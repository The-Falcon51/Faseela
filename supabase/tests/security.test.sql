-- Faseela security & business-rule test suite (RLS, RPC authorization, four-eyes, quotas,
-- idempotency, storage policies, scheduled jobs). Runs as one transaction that ALWAYS rolls back:
-- the final RAISE aborts it and carries the summary ("TEST SUMMARY passed=N failed=M ...").
-- Run: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=0 -f supabase/tests/security.test.sql
--      (or paste into the SQL editor / Supabase MCP execute_sql). Requires the seed (tree_01..03).
do $test$
declare
  -- Fixed test identities (rolled back at the end).
  c_i1 constant uuid := '11111111-1111-4111-8111-111111111111'; -- investor
  c_i2 constant uuid := '22222222-2222-4222-8222-222222222222'; -- investor, later farmer applicant
  c_u  constant uuid := '33333333-3333-4333-8333-333333333333'; -- unverified e-mail
  c_f  constant uuid := '44444444-4444-4444-8444-444444444444'; -- finance_admin
  c_q  constant uuid := '55555555-5555-4555-8555-555555555555'; -- quality_auditor
  c_a  constant uuid := '66666666-6666-4666-8666-666666666666'; -- admin
  c_fa constant uuid := '77777777-7777-4777-8777-777777777777'; -- farmer
  c_m  constant uuid := '88888888-8888-4888-8888-888888888888'; -- mill_operator
  c_ob constant uuid := '99999999-9999-4999-8999-999999999999'; -- onboarding / consent
  c_o2 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; -- second oil holder
  v_req1 text := encode(sha256(convert_to('11111111-1111-4111-8111-111111111111:key-i1-tree01-000001', 'UTF8')), 'hex');
  v_reqf text := encode(sha256(convert_to('44444444-4444-4444-8444-444444444444:key-f-treet6-0000001', 'UTF8')), 'hex');
  v_tests jsonb;
  v_case jsonb;
  v_sql text;
  v_expect text;
  v_actor text;
  v_got text;
  v_hint text;
  v_msg text;
  v_pass integer := 0;
  v_fail integer := 0;
  v_failures text[] := '{}';
  v_upd uuid;
  v_batch uuid;
  v_alloc uuid;
  v_serial text;
  v_req_i2 text := encode(sha256(convert_to('22222222-2222-4222-8222-222222222222:key-i2-treet4-000001', 'UTF8')), 'hex');
  v_upload_sql text;
begin
  -- The land option is off by default (migration 46); this suite exercises it, so it is switched on for this transaction.
  insert into private.app_settings (key, value) values ('land_offer_enabled', 'true') on conflict (key) do update set value = 'true';
  -- ---------------------------------------------------------------- setup (as postgres)
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '',
         case when u.verified then now() else null end, '{}'::jsonb,
         jsonb_build_object('display_name', u.name, 'requested_role', u.req), now(), now()
    from (values
      (c_i1, 'i1@test.faseela.invalid', 'Investor One', true, 'investor'),
      (c_i2, 'i2@test.faseela.invalid', 'Investor Two', true, 'farmer'),
      (c_u,  'u@test.faseela.invalid',  'Unverified', false, 'investor'),
      (c_f,  'f@test.faseela.invalid',  'Finance', true, 'investor'),
      (c_q,  'q@test.faseela.invalid',  'Auditor', true, 'investor'),
      (c_a,  'a@test.faseela.invalid',  'Admin', true, 'investor'),
      (c_fa, 'fa@test.faseela.invalid', 'Farmer', true, 'farmer'),
      (c_m,  'm@test.faseela.invalid',  'Mill', true, 'mill_operator')
    ) as u(id, email, name, verified, req);
  insert into private.user_roles (user_id, role) values
    (c_f, 'finance_admin'), (c_q, 'quality_auditor'), (c_a, 'admin'), (c_fa, 'farmer'), (c_m, 'mill_operator');
  -- Extra test trees for quota tests.
  insert into public.trees_public (tree_id, total_shares, available_shares, price_per_share_minor)
  values ('tree_t4', 4, 4, 1000), ('tree_t5', 4, 4, 1000), ('tree_t6', 4, 4, 1000);
  insert into private.trees (tree_id, total_shares, price_per_share_minor)
  values ('tree_t4', 4, 1000), ('tree_t5', 4, 1000), ('tree_t6', 4, 1000);

  -- ---------------------------------------------------------------- cases
  -- expect: 'ok' | 'err' (any error) | 'err:<hint>' | 'eq:<text>'
  v_tests := jsonb_build_array(
    -- Anonymous visitors: public catalogue only.
    jsonb_build_array('anon', 'anon sees listed trees', 'select count(*)::text from public.trees_public where tree_id like ''tree_0%''', 'eq:3'),
    jsonb_build_array('anon', 'anon cannot read profiles', 'select count(*)::text from public.profiles', 'err'),
    jsonb_build_array('anon', 'anon cannot call RPC', 'select public.create_investment_request(''{}''::jsonb)::text', 'err'),
    -- Clients never write tables directly.
    jsonb_build_array(c_i1, 'no direct insert', 'insert into public.investment_requests (id,user_id,tree_id,share_count,amount_minor,currency,status,expires_at) values (repeat(''a'',64), ''' || c_i1 || ''', ''tree_01'', 1, 1, ''USD'', ''approved'', now())', 'err'),
    jsonb_build_array(c_i1, 'no direct update of listing', 'update public.trees_public set price_per_share_minor = 1', 'err'),
    jsonb_build_array(c_i1, 'no access to private inventory', 'select count(*)::text from private.trees', 'err'),
    jsonb_build_array(c_i1, 'no self role grant', 'insert into private.user_roles (user_id, role) values (''' || c_i1 || ''', ''admin'')', 'err'),
    jsonb_build_array(c_i1, 'operator helper not callable', 'select private.admin_set_role(''i1@test.faseela.invalid'', ''admin'')::text', 'err'),
    jsonb_build_array(c_i1, 'own profile only', 'select count(*)::text from public.profiles', 'eq:1'),
    jsonb_build_array(c_i1, 'default role investor', 'select private.current_app_role()', 'eq:investor'),
    -- Reservation rules.
    jsonb_build_array(c_u, 'unverified e-mail blocked', 'select public.create_investment_request(''{"treeId":"tree_01","shareCount":1,"idempotencyKey":"key-unverified-000001"}'')::text', 'err:failed-precondition'),
    jsonb_build_array(c_i1, 'reserve 1 share', 'select public.create_investment_request(''{"treeId":"tree_01","shareCount":1,"idempotencyKey":"key-i1-tree01-000001"}'')->>''requestId''', 'eq:' || v_req1),
    jsonb_build_array(c_i1, 'idempotent replay', 'select public.create_investment_request(''{"treeId":"tree_01","shareCount":1,"idempotencyKey":"key-i1-tree01-000001"}'')->>''requestId''', 'eq:' || v_req1),
    jsonb_build_array(c_i1, 'replay reserved once', 'select available_shares::text from public.trees_public where tree_id = ''tree_01''', 'eq:1'),
    jsonb_build_array(c_i1, 'server amount minor units', 'select amount_minor::text from public.investment_requests where id = ''' || v_req1 || '''', 'eq:3500'),
    jsonb_build_array(c_i1, 'one open request per tree', 'select public.create_investment_request(''{"treeId":"tree_01","shareCount":1,"idempotencyKey":"key-i1-tree01-000002"}'')::text', 'err:already-exists'),
    jsonb_build_array(c_i1, 'fractional shares rejected', 'select public.create_investment_request(''{"treeId":"tree_02","shareCount":1.5,"idempotencyKey":"key-i1-tree02-000009"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i1, 'string shareCount rejected', 'select public.create_investment_request(''{"treeId":"tree_02","shareCount":"2","idempotencyKey":"key-i1-tree02-000009"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i1, 'missing shareCount rejected', 'select public.create_investment_request(''{"treeId":"tree_02","idempotencyKey":"key-i1-tree02-000009"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i1, 'short idempotency key rejected', 'select public.create_investment_request(''{"treeId":"tree_02","shareCount":1,"idempotencyKey":"short"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i1, 'land only with full tree', 'select public.create_investment_request(''{"treeId":"tree_03","shareCount":1,"includesLand":true,"idempotencyKey":"key-i1-tree03-000009"}'')::text', 'err:failed-precondition'),
    jsonb_build_array(c_i1, 'reserve 3 shares tree_02', 'select public.create_investment_request(''{"treeId":"tree_02","shareCount":3,"idempotencyKey":"key-i1-tree02-000001"}'')->>''status''', 'eq:awaiting_payment'),
    jsonb_build_array(c_i1, 'full tree + land price', 'select public.create_investment_request(''{"treeId":"tree_03","shareCount":4,"includesLand":true,"idempotencyKey":"key-i1-tree03-000001"}'')->>''amountMinor''', 'eq:10300'),
    jsonb_build_array(c_i1, 'max 3 open requests', 'select public.create_investment_request(''{"treeId":"tree_t4","shareCount":1,"idempotencyKey":"key-i1-treet4-000001"}'')::text', 'err:resource-exhausted'),
    jsonb_build_array(c_i2, 'no oversell', 'select public.create_investment_request(''{"treeId":"tree_01","shareCount":2,"idempotencyKey":"key-i2-tree01-000001"}'')::text', 'err:failed-precondition'),
    jsonb_build_array(c_i2, 'reserve 4 on t4', 'select public.create_investment_request(''{"treeId":"tree_t4","shareCount":4,"idempotencyKey":"key-i2-treet4-000001"}'')->>''status''', 'eq:awaiting_payment'),
    jsonb_build_array(c_i2, 'reserve 4 on t5', 'select public.create_investment_request(''{"treeId":"tree_t5","shareCount":4,"idempotencyKey":"key-i2-treet5-000001"}'')->>''status''', 'eq:awaiting_payment'),
    jsonb_build_array(c_i2, 'max 8 open shares', 'select public.create_investment_request(''{"treeId":"tree_t6","shareCount":1,"idempotencyKey":"key-i2-treet6-000001"}'')::text', 'err:resource-exhausted'),
    -- Cross-user isolation.
    jsonb_build_array(c_i2, 'cannot read others requests', 'select count(*)::text from public.investment_requests where user_id = ''' || c_i1 || '''', 'eq:0'),
    jsonb_build_array(c_i2, 'cannot read others transactions', 'select count(*)::text from public.transactions where user_id = ''' || c_i1 || '''', 'eq:0'),
    jsonb_build_array(c_i2, 'cannot cancel others request', 'select public.cancel_investment_request(''{"requestId":"' || v_req1 || '"}'')::text', 'err:not-found'),
    jsonb_build_array(c_i2, 'cannot upload into others folder', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''payment-proofs'', ''' || c_i1 || '/' || v_req1 || '/x.pdf'', ''' || c_i2 || ''', ''{"mimetype":"application/pdf"}'')', 'err'),
    jsonb_build_array(c_i1, 'cannot upload for unknown request', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''payment-proofs'', ''' || c_i1 || '/' || repeat('b', 64) || '/x.pdf'', ''' || c_i1 || ''', ''{"mimetype":"application/pdf"}'')', 'err'),
    jsonb_build_array(c_i1, 'upload own proof', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''payment-proofs'', ''' || c_i1 || '/' || v_req1 || '/receipt.pdf'', ''' || c_i1 || ''', ''{"mimetype":"application/pdf"}'')', 'ok'),
    jsonb_build_array(c_i2, 'cannot list others proofs', 'select count(*)::text from storage.objects where bucket_id = ''payment-proofs''', 'eq:0'),
    jsonb_build_array(c_i1, 'proof path must be own', 'select public.submit_investment_payment_proof(''{"requestId":"' || v_req1 || '","storagePath":"' || c_i2 || '/' || v_req1 || '/receipt.pdf"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i1, 'submit proof', 'select public.submit_investment_payment_proof(''{"requestId":"' || v_req1 || '","storagePath":"' || c_i1 || '/' || v_req1 || '/receipt.pdf"}'')->>''status''', 'eq:under_review'),
    jsonb_build_array(c_i1, 'investor cannot approve', 'select public.review_investment_request(''{"requestId":"' || v_req1 || '","decision":"approve"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_q, 'auditor cannot approve payments', 'select public.review_investment_request(''{"requestId":"' || v_req1 || '","decision":"approve"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_q, 'auditor cannot list payments', 'select public.list_review_queue(''{"queue":"payments"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_f, 'finance sees payment queue', 'select jsonb_array_length(public.list_review_queue(''{"queue":"payments"}'')->''items'')::text', 'eq:1'),
    jsonb_build_array(c_f, 'finance sees proof object', 'select count(*)::text from storage.objects where bucket_id = ''payment-proofs''', 'eq:1'),
    jsonb_build_array(c_f, 'approval needs a screening first', 'select public.review_investment_request(''{"requestId":"' || v_req1 || '","decision":"approve"}'')::text', 'err:screening-required'),
    jsonb_build_array(c_f, 'finance records clear screening', 'select public.record_payment_screening(''{"requestId":"' || v_req1 || '","result":"clear","listsChecked":"EU, UN"}'')->>''result''', 'eq:clear'),
    jsonb_build_array(c_f, 'finance approves', 'select public.review_investment_request(''{"requestId":"' || v_req1 || '","decision":"approve","note":"ok"}'')->>''status''', 'eq:approved'),
    jsonb_build_array(c_f, 'double decision blocked', 'select public.review_investment_request(''{"requestId":"' || v_req1 || '","decision":"approve"}'')::text', 'err:failed-precondition'),
    jsonb_build_array(c_i1, 'share created for owner', 'select count(*)::text from public.shares where id = ''' || v_req1 || ''' and user_id = ''' || c_i1 || '''', 'eq:1'),
    jsonb_build_array(c_i1, 'transaction settled', 'select status from public.transactions where id = ''' || v_req1 || '''', 'eq:settled'),
    -- Four-eyes: finance cannot approve own request.
    jsonb_build_array(c_f, 'finance reserves own', 'select public.create_investment_request(''{"treeId":"tree_t6","shareCount":1,"idempotencyKey":"key-f-treet6-0000001"}'')->>''requestId''', 'eq:' || v_reqf),
    jsonb_build_array(c_f, 'finance uploads own proof', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''payment-proofs'', ''' || c_f || '/' || v_reqf || '/r.png'', ''' || c_f || ''', ''{"mimetype":"image/png"}'')', 'ok'),
    jsonb_build_array(c_f, 'finance submits own proof', 'select public.submit_investment_payment_proof(''{"requestId":"' || v_reqf || '","storagePath":"' || c_f || '/' || v_reqf || '/r.png"}'')->>''status''', 'eq:under_review'),
    jsonb_build_array(c_f, 'no self approval (finance)', 'select public.review_investment_request(''{"requestId":"' || v_reqf || '","decision":"approve"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'another reviewer may decide', 'select public.review_investment_request(''{"requestId":"' || v_reqf || '","decision":"reject","note":"x"}'')->>''status''', 'eq:rejected'),
    -- Field operations.
    jsonb_build_array(c_i1, 'investor cannot file field report', 'select public.submit_farmer_update(''{"treeId":"tree_01","eventType":"pruning","notes":"x","mediaPaths":[]}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_fa, 'farmer needs assignment', 'select public.submit_farmer_update(''{"treeId":"tree_01","eventType":"pruning","notes":"x","mediaPaths":[]}'')::text', 'err:permission-denied'),
    jsonb_build_array('postgres', 'assign farmer', 'select private.admin_assign_farmer(''fa@test.faseela.invalid'', ''tree_01'')::text', 'ok'),
    jsonb_build_array(c_fa, 'media must be own folder', 'select public.submit_farmer_update(''{"treeId":"tree_01","eventType":"pruning","notes":"x","mediaPaths":["' || c_i1 || '/tree_01/a.jpg"]}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_fa, 'unknown event type rejected', 'select public.submit_farmer_update(''{"treeId":"tree_01","eventType":"party","notes":"x","mediaPaths":[]}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_fa, 'farmer media upload own tree', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''field-media'', ''' || c_fa || '/tree_01/p.jpg'', ''' || c_fa || ''', ''{"mimetype":"image/jpeg"}'')', 'ok'),
    jsonb_build_array(c_fa, 'farmer media upload foreign tree', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''field-media'', ''' || c_fa || '/tree_02/p.jpg'', ''' || c_fa || ''', ''{"mimetype":"image/jpeg"}'')', 'err'),
    jsonb_build_array(c_fa, 'farmer files report', 'select public.submit_farmer_update(''{"treeId":"tree_01","eventType":"pruning","notes":"Pruned","mediaPaths":["' || c_fa || '/tree_01/p.jpg"],"gpsLat":34.8,"gpsLng":36.1}'')->>''status''', 'eq:pending_review'),
    jsonb_build_array(c_i1, 'investor cannot read field reports', 'select count(*)::text from public.farmer_updates', 'eq:0'),
    jsonb_build_array(c_q, 'auditor sees report queue', 'select jsonb_array_length(public.list_review_queue(''{"queue":"farmer_updates"}'')->''items'')::text', 'eq:1'),
    jsonb_build_array(c_m, 'mill needs assignment', 'select public.submit_pressing_batch(''{"treeId":"tree_01","millId":"mill_01","olivesWeightKg":100,"oilYieldLiters":18,"temperatureCelsius":24,"acidityPct":0.4,"peroxideValue":8}'')::text', 'err:permission-denied'),
    jsonb_build_array('postgres', 'assign mill', 'select private.admin_assign_mill(''m@test.faseela.invalid'', ''mill_01'')::text', 'ok'),
    jsonb_build_array(c_m, 'cold-press bound enforced', 'select public.submit_pressing_batch(''{"treeId":"tree_01","millId":"mill_01","olivesWeightKg":100,"oilYieldLiters":18,"temperatureCelsius":50,"acidityPct":0.4,"peroxideValue":8}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_m, 'mill submits batch', 'select public.submit_pressing_batch(''{"treeId":"tree_01","millId":"mill_01","olivesWeightKg":100,"oilYieldLiters":18,"temperatureCelsius":24,"acidityPct":0.4,"peroxideValue":8}'')->>''status''', 'eq:pending_review'),
    jsonb_build_array(c_fa, 'farmer cannot see batches', 'select count(*)::text from public.pressing_batches', 'eq:0'),
    -- Role applications.
    jsonb_build_array(c_i2, 'apply for farmer role', 'select public.submit_role_application(''{"requestedRole":"farmer","region":"Idlib"}'')->>''status''', 'eq:pending'),
    jsonb_build_array(c_i2, 'cannot request admin role', 'select public.submit_role_application(''{"requestedRole":"admin","region":"Idlib"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i2, 'applicant cannot self-approve', 'select public.review_role_application(''{"userId":"' || c_i2 || '","decision":"approve"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'admin approves role', 'select public.review_role_application(''{"userId":"' || c_i2 || '","decision":"approve"}'')->>''status''', 'eq:approved'),
    jsonb_build_array(c_i2, 'role active immediately', 'select private.current_app_role()', 'eq:farmer'),
    jsonb_build_array(c_a, 'admin cannot approve own application', 'select public.review_role_application(''{"userId":"' || c_a || '","decision":"approve"}'')::text', 'err:permission-denied'),
    -- Admin & privacy.
    jsonb_build_array(c_i1, 'user directory admin only', 'select public.admin_list_users()::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'admin user directory', 'select (jsonb_array_length(public.admin_list_users()->''users'') >= 8)::text', 'eq:true'),
    jsonb_build_array(c_i1, 'audit log admin only', 'select count(*)::text from public.audit_logs', 'eq:0'),
    jsonb_build_array(c_a, 'admin reads audit log', 'select (count(*) > 0)::text from public.audit_logs', 'eq:true'),
    jsonb_build_array(c_i1, 'export contains own data', 'select jsonb_array_length(public.export_my_data()->''investmentRequests'')::text', 'eq:3'),
    jsonb_build_array(c_i1, 'export has no foreign data', 'select (public.export_my_data()::text like ''%' || c_i2 || '%'')::text', 'eq:false')
  );

  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('role', 'none', true);
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      elsif v_actor <> 'postgres' then
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      else
        perform set_config('request.jwt.claims', '', true);
      end if;

      if v_sql ~* '^\s*select' then
        execute v_sql into v_got;
      else
        execute v_sql;
        v_got := null;
      end if;
      perform set_config('role', 'none', true);

      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---------------------------------------------------------------- reviewer decisions needing ids
  perform set_config('role', 'none', true);
  select id into v_upd from public.farmer_updates where farmer_uid = c_fa limit 1;
  select id into v_batch from public.pressing_batches where submitted_by_uid = c_m limit 1;
  v_tests := jsonb_build_array(
    jsonb_build_array(c_fa, 'farmer cannot publish own report', 'select public.review_farmer_update(''{"updateId":"' || v_upd || '","decision":"publish"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_q, 'auditor publishes report', 'select public.review_farmer_update(''{"updateId":"' || v_upd || '","decision":"publish"}'')->>''status''', 'eq:published'),
    jsonb_build_array('anon', 'published event is public, media private', 'select media_count::text from public.tree_events_public where event_type = ''pruning''', 'eq:1'),
    jsonb_build_array(c_q, 'certify needs serial', 'select public.certify_pressing_batch(''{"batchId":"' || v_batch || '","decision":"certify"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_q, 'auditor certifies batch', 'select public.certify_pressing_batch(''{"batchId":"' || v_batch || '","decision":"certify","certificateSerial":"LAB-2026-001"}'')->>''status''', 'eq:certified'),
    jsonb_build_array('anon', 'certified batch public without operator id', 'select (to_jsonb(e)::text like ''%' || c_m || '%'')::text from public.tree_events_public e where event_type = ''pressing_certified''', 'eq:false')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      else
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      end if;
      execute v_sql into v_got;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---------------------------------------------------------------- admin tools & upload caps
  perform set_config('role', 'none', true);
  v_upload_sql := 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''payment-proofs'', ''' || c_i2 || '/' || v_req_i2 || '/f%s.pdf'', ''' || c_i2 || ''', ''{"mimetype":"application/pdf"}'')';
  v_tests := jsonb_build_array(
    jsonb_build_array(c_i1, 'investor cannot set roles', 'select public.admin_set_user_role(''{"userId":"' || c_i2 || '","role":"admin"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_f, 'finance cannot set roles', 'select public.admin_set_user_role(''{"userId":"' || c_i2 || '","role":"admin"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'admin cannot change own role', 'select public.admin_set_user_role(''{"userId":"' || c_a || '","role":"investor"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'admin cannot suspend self', 'select public.admin_set_user_status(''{"userId":"' || c_a || '","status":"suspended"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'unknown role rejected', 'select public.admin_set_user_role(''{"userId":"' || c_i1 || '","role":"superuser"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_a, 'admin promotes i1 to finance', 'select public.admin_set_user_role(''{"userId":"' || c_i1 || '","role":"finance_admin"}'')->>''role''', 'eq:finance_admin'),
    jsonb_build_array(c_i1, 'promotion effective immediately', 'select private.current_app_role()', 'eq:finance_admin'),
    jsonb_build_array(c_a, 'admin suspends i1', 'select public.admin_set_user_status(''{"userId":"' || c_i1 || '","status":"suspended"}'')->>''status''', 'eq:suspended'),
    jsonb_build_array(c_a, 'directory shows suspension', 'select (u->>''disabled'') from jsonb_array_elements(public.admin_list_users()->''users'') u where u->>''uid'' = ''' || c_i1 || '''', 'eq:true'),
    jsonb_build_array(c_a, 'admin reactivates i1', 'select public.admin_set_user_status(''{"userId":"' || c_i1 || '","status":"active"}'')->>''status''', 'eq:active'),
    jsonb_build_array(c_fa, 'farmer cannot self-assign', 'select public.admin_assign(''{"userId":"' || c_fa || '","kind":"farmer_tree","action":"add","targetId":"tree_02"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'assign unknown tree rejected', 'select public.admin_assign(''{"userId":"' || c_fa || '","kind":"farmer_tree","action":"add","targetId":"tree_nope"}'')::text', 'err:not-found'),
    jsonb_build_array(c_a, 'admin assigns tree_02', 'select (public.admin_assign(''{"userId":"' || c_fa || '","kind":"farmer_tree","action":"add","targetId":"tree_02"}'')->''trees'') ? ''tree_02''', 'eq:true'),
    jsonb_build_array(c_fa, 'farmer reports on tree_02', 'select public.submit_farmer_update(''{"treeId":"tree_02","eventType":"watering","notes":"ok","mediaPaths":[]}'')->>''status''', 'eq:pending_review'),
    jsonb_build_array(c_a, 'admin revokes tree_02', 'select (public.admin_assign(''{"userId":"' || c_fa || '","kind":"farmer_tree","action":"remove","targetId":"tree_02"}'')->''trees'') ? ''tree_02''', 'eq:false'),
    jsonb_build_array(c_fa, 'revoked assignment blocks reports', 'select public.submit_farmer_update(''{"treeId":"tree_02","eventType":"watering","notes":"ok","mediaPaths":[]}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_fa, 'revoked assignment blocks media upload', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''field-media'', ''' || c_fa || '/tree_02/q.jpg'', ''' || c_fa || ''', ''{"mimetype":"image/jpeg"}'')', 'err'),
    jsonb_build_array(c_a, 'admin assigns mill_02', 'select (public.admin_assign(''{"userId":"' || c_m || '","kind":"mill","action":"add","targetId":"mill_02"}'')->''mills'') ? ''mill_02''', 'eq:true'),
    jsonb_build_array(c_i2, 'proof upload 1', format(v_upload_sql, 1), 'ok'),
    jsonb_build_array(c_i2, 'proof upload 2', format(v_upload_sql, 2), 'ok'),
    jsonb_build_array(c_i2, 'proof upload 3', format(v_upload_sql, 3), 'ok'),
    jsonb_build_array(c_i2, 'proof upload 4', format(v_upload_sql, 4), 'ok'),
    jsonb_build_array(c_i2, 'proof upload 5', format(v_upload_sql, 5), 'ok'),
    jsonb_build_array(c_i2, 'proof upload cap (6th rejected)', format(v_upload_sql, 6), 'err'),
    jsonb_build_array(c_a, 'audit log records admin actions', 'select (count(*) >= 6)::text from public.audit_logs where actor_uid = ''' || c_a || ''' and action in (''role.set'', ''account.suspended'', ''account.active'', ''assignment.farmer_tree.add'', ''assignment.farmer_tree.remove'', ''assignment.mill.add'')', 'eq:true')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      if v_sql ~* '^\s*select' then
        execute v_sql into v_got;
      else
        execute v_sql;
        v_got := null;
      end if;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---------------------------------------------------------------- notifications & monitoring
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  -- Deterministic alert dedupe window inside the (rolled-back) test transaction.
  insert into private.ops_state (key, value) values ('last_alert', '{"at": "2000-01-01T00:00:00Z"}'::jsonb)
  on conflict (key) do update set value = excluded.value;
  -- A failed delivery inside the transaction makes the ops alert deterministic (independent of real outbox history).
  insert into private.email_outbox (recipient, template, params, status, last_error)
  values ('probe@test.faseela.invalid', 'ops_alert', '{}'::jsonb, 'failed', 'suite probe');
  v_tests := jsonb_build_array(
    jsonb_build_array(c_i1, 'reservation enqueued investor mail', 'select count(*)::text from private.email_outbox where recipient = ''i1@test.faseela.invalid'' and template = ''reservation_created''', 'err'),
    jsonb_build_array('postgres', 'outbox: reservation mail', 'select count(*)::text from private.email_outbox where recipient = ''i1@test.faseela.invalid'' and template = ''reservation_created''', 'eq:3'),
    jsonb_build_array('postgres', 'outbox: approval mail', 'select count(*)::text from private.email_outbox where recipient = ''i1@test.faseela.invalid'' and template = ''payment_approved''', 'eq:1'),
    jsonb_build_array('postgres', 'outbox: finance + admin notified of proof', 'select count(*)::text from private.email_outbox where template = ''review_needed'' and params->>''queue'' = ''payments'' and recipient in (''f@test.faseela.invalid'', ''a@test.faseela.invalid'')', 'eq:4'),
    jsonb_build_array('postgres', 'outbox: role decision mail', 'select template from private.email_outbox where recipient = ''i2@test.faseela.invalid'' and template like ''role_%''', 'eq:role_approved'),
    jsonb_build_array('postgres', 'outbox: no mail to unverified/banned', 'select count(*)::text from private.email_outbox where recipient = ''u@test.faseela.invalid''', 'eq:0'),
    jsonb_build_array('anon', 'anon cannot read outbox', 'select count(*)::text from private.email_outbox', 'err'),
    jsonb_build_array('anon', 'anon cannot claim outbox', 'select count(*)::text from public.outbox_claim(1)', 'err'),
    jsonb_build_array(c_a, 'admin cannot claim outbox', 'select count(*)::text from public.outbox_claim(1)', 'err'),
    jsonb_build_array(c_i1, 'notify helpers not callable by users', 'select private.notify_user(''' || c_i1 || ''', ''ops_alert'', ''{}'')::text', 'err'),
    jsonb_build_array('anon', 'anon cannot enqueue mail', 'select private.enqueue_email(''x@test.faseela.invalid'', ''ops_alert'', ''{}'')::text', 'err'),
    jsonb_build_array('anon', 'anon can report an error', 'select public.report_client_error(''{"message":"TypeError: probe","source":"app.js:1"}'')->>''stored''', 'eq:true'),
    jsonb_build_array('anon', 'empty report dropped', 'select public.report_client_error(''{"message":""}'')->>''stored''', 'eq:false'),
    jsonb_build_array('postgres', 'limiter reset before the fingerprint test', 'with d as (delete from private.rate_limits where bucket = ''report_client_error'' returning 1) select ''ok''::text', 'eq:ok'),
    jsonb_build_array('anon', 'per-fingerprint cap', 'select (select bool_and((public.report_client_error(''{"message":"TypeError: flood","source":"x"}'')->>''stored'')::boolean) from generate_series(1, 20))::text', 'eq:true'),
    jsonb_build_array('postgres', 'limiter reset before the 21st report', 'with d as (delete from private.rate_limits where bucket = ''report_client_error'' returning 1) select ''ok''::text', 'eq:ok'),
    jsonb_build_array('anon', 'per-fingerprint cap (21st dropped)', 'select public.report_client_error(''{"message":"TypeError: flood","source":"x"}'')->>''stored''', 'eq:false'),
    jsonb_build_array(c_i1, 'system status admin only', 'select public.admin_system_status()::text', 'err:permission-denied'),
    jsonb_build_array(c_f, 'system status not for finance', 'select public.admin_system_status()::text', 'err:permission-denied'),
    jsonb_build_array(c_a, 'system status for admin', 'select (public.admin_system_status()->''clientErrors''->>''last24h'')::int >= 21', 'eq:true'),
    jsonb_build_array(c_a, 'system status lists jobs', 'select (jsonb_array_length(public.admin_system_status()->''jobs'') >= 4)::text', 'eq:true'),
    jsonb_build_array('postgres', 'ops check alerts admins once', 'select (private.ops_check()->>''clientErrorsLastHour'')::int >= 21', 'eq:true'),
    jsonb_build_array('postgres', 'ops alert enqueued for admin', 'select count(*)::text from private.email_outbox where template = ''ops_alert'' and recipient = ''a@test.faseela.invalid''', 'eq:1'),
    jsonb_build_array('postgres', 'ops alert deduplicated', 'select (private.ops_check() is not null)::text || count(*)::text from private.email_outbox where template = ''ops_alert'' and recipient = ''a@test.faseela.invalid''', 'eq:true1')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('role', 'none', true);
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      elsif v_actor <> 'postgres' then
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      else
        perform set_config('request.jwt.claims', '', true);
      end if;
      execute v_sql into v_got;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---------------------------------------------------------------- scheduled jobs (as postgres)
  -- ---- profile self-service, marketing consent, onboarding sequence, public status ----------------
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', c_ob, 'authenticated', 'authenticated', 'ob@test.faseela.invalid', '',
          now(), '{}'::jsonb, '{"display_name":"Onb"}'::jsonb, now() - interval '4 days', now());
  update public.profiles set created_at = now() - interval '4 days' where id = c_ob;
  v_tests := jsonb_build_array(
    jsonb_build_array('anon', 'anon reads public status', 'select public.public_status()->>''api''', 'eq:ok'),
    jsonb_build_array('anon', 'anon cannot update profile', 'select public.update_my_profile(''{"displayName":"X Y Z"}'')::text', 'err'),
    jsonb_build_array(c_ob, 'short name rejected', 'select public.update_my_profile(''{"displayName":"ab"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_ob, 'bad phone rejected', 'select public.update_my_profile(''{"displayName":"Onb Oard","phone":"call me"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_ob, 'profile update persists', 'select public.update_my_profile(''{"displayName":"Onb Oard","phone":"+49 151 1234567","region":"Idlib"}'')->>''phone''', 'eq:+49 151 1234567'),
    jsonb_build_array(c_ob, 'profile row updated', 'select display_name from public.profiles where id = ''' || c_ob || '''', 'eq:Onb Oard'),
    jsonb_build_array(c_ob, 'consent needs boolean', 'select public.set_marketing_consent(''{"optIn":"yes"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_ob, 'consent missing rejected', 'select public.set_marketing_consent(''{}'')::text', 'err:invalid-argument'),
    jsonb_build_array('postgres', 'onboarding job runs', 'select (private.send_onboarding() >= 0)::text', 'eq:true'),
    jsonb_build_array('postgres', 'no onboarding without consent', 'select count(*)::text from private.email_outbox where recipient = ''ob@test.faseela.invalid''', 'eq:0'),
    jsonb_build_array(c_ob, 'consent granted', 'select public.set_marketing_consent(''{"optIn":true}'')->>''marketingOptIn''', 'eq:true'),
    jsonb_build_array('postgres', 'onboarding job enqueues', 'select (private.send_onboarding() >= 2)::text', 'eq:true'),
    jsonb_build_array('postgres', 'onboarding one+three for the new user', 'select count(*)::text from private.email_outbox where recipient = ''ob@test.faseela.invalid'' and template in (''onboarding_one'', ''onboarding_three'')', 'eq:2'),
    jsonb_build_array('postgres', 'onboarding idempotent', 'select private.send_onboarding()::text', 'eq:0'),
    jsonb_build_array('postgres', 'onboarding rows marked marketing', 'select count(*)::text from private.email_outbox where recipient = ''ob@test.faseela.invalid'' and (params->>''marketing'')::boolean', 'eq:2'),
    jsonb_build_array(c_ob, 'consent revoked', 'select public.set_marketing_consent(''{"optIn":false}'')->>''marketingOptIn''', 'eq:false'),
    jsonb_build_array('postgres', 'consent audit logged', 'select count(*)::text from public.audit_logs where actor_uid = ''' || c_ob || ''' and action like ''consent.marketing.%''', 'eq:2'),
    jsonb_build_array(c_ob, 'user cannot run onboarding job', 'select private.send_onboarding()::text', 'err')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('role', 'none', true);
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      elsif v_actor <> 'postgres' then
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      else
        perform set_config('request.jwt.claims', '', true);
      end if;
      execute v_sql into v_got;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---- harvest & oil allocation -------------------------------------------------------------------
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', c_o2, 'authenticated', 'authenticated', 'oi2@test.faseela.invalid', '',
          now(), '{}'::jsonb, '{"display_name":"Oil Two"}'::jsonb, now(), now());
  insert into public.trees_public (tree_id, status, total_shares, available_shares, price_per_share_minor) values ('tree_oil', 'listed', 4, 1, 1000);
  insert into private.trees (tree_id, total_shares, sold_shares, reserved_shares, price_per_share_minor) values ('tree_oil', 4, 3, 0, 1000);
  insert into public.investment_requests (id, user_id, tree_id, share_count, amount_minor, currency, status, expires_at) values
    (repeat('d', 64), c_i2, 'tree_oil', 1, 1000, 'USD', 'approved', now()), (repeat('e', 64), c_o2, 'tree_oil', 2, 2000, 'USD', 'approved', now());
  insert into public.shares (id, request_id, user_id, tree_id, share_count, purchase_price_minor, currency) values
    (repeat('d', 64), repeat('d', 64), c_i2, 'tree_oil', 1, 1000, 'USD'), (repeat('e', 64), repeat('e', 64), c_o2, 'tree_oil', 2, 2000, 'USD');
  perform private.admin_assign_mill('m@test.faseela.invalid', 'mill_oil');
  perform set_config('request.jwt.claims', json_build_object('sub', c_m, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  v_batch := (public.submit_pressing_batch('{"treeId":"tree_oil","millId":"mill_oil","olivesWeightKg":100,"oilYieldLiters":10,"temperatureCelsius":24,"acidityPct":0.4,"peroxideValue":8}')->>'batchId')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', c_q, 'role', 'authenticated')::text, true);
  perform public.certify_pressing_batch(jsonb_build_object('batchId', v_batch, 'decision', 'certify', 'certificateSerial', 'LAB-OIL-1'));
  perform set_config('role', 'none', true);
  select id into v_alloc from public.oil_allocations where user_id = c_i2 and tree_id = 'tree_oil';
  v_tests := jsonb_build_array(
    jsonb_build_array('postgres', 'oil: 1 share gets 2500 ml of 10 L', 'select liters_ml::text from public.oil_allocations where id = ''' || v_alloc || '''', 'eq:2500'),
    jsonb_build_array('postgres', 'oil: 2 shares get 5000 ml', 'select liters_ml::text from public.oil_allocations where user_id = ''' || c_o2 || ''' and tree_id = ''tree_oil''', 'eq:5000'),
    jsonb_build_array('postgres', 'oil: holders notified', 'select count(*)::text from private.email_outbox where template = ''oil_allocated'' and recipient in (''i2@test.faseela.invalid'', ''oi2@test.faseela.invalid'')', 'eq:2'),
    jsonb_build_array(c_o2, 'oil: cannot request foreign allocation', 'select public.request_oil(''{"kind":"donate","allocationIds":["' || v_alloc || '"]}'')::text', 'err:failed-precondition'),
    jsonb_build_array(c_i2, 'oil: delivery needs address', 'select public.request_oil(''{"kind":"delivery","allocationIds":["' || v_alloc || '"],"contact":{"name":"Ab Cd","phone":"+49 151 1234567"}}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_i2, 'oil: request delivery', 'select public.request_oil(''{"kind":"delivery","allocationIds":["' || v_alloc || '"],"contact":{"name":"Ab Cd","phone":"+49 151 1234567","addressLine1":"Musterweg 1","city":"Berlin","country":"de"}}'')->>''litersMl''', 'eq:2500'),
    jsonb_build_array(c_i2, 'oil: double request blocked', 'select public.request_oil(''{"kind":"donate","allocationIds":["' || v_alloc || '"]}'')::text', 'err:failed-precondition'),
    jsonb_build_array(c_i2, 'oil: contact table hidden', 'select count(*)::text from private.oil_request_contacts', 'err'),
    jsonb_build_array('postgres', 'oil: contact encrypted at rest', 'select bool_and(encode(contact_enc, ''escape'') not like ''%Musterweg%'')::text from private.oil_request_contacts', 'eq:true'),
    jsonb_build_array(c_o2, 'oil: other investor sees no request', 'select count(*)::text from public.oil_requests', 'eq:0'),
    jsonb_build_array(c_i2, 'oil: investor cannot review', 'select public.review_oil_request(jsonb_build_object(''requestId'', (select id from public.oil_requests where user_id = ''' || c_i2 || '''), ''decision'', ''approve''))::text', 'err:permission-denied'),
    jsonb_build_array(c_q, 'oil: auditor cannot see queue', 'select public.list_review_queue(''{"queue":"oil_requests"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_f, 'oil: finance sees decrypted city', 'select i->''contact''->>''city'' from jsonb_array_elements(public.list_review_queue(''{"queue":"oil_requests"}'')->''items'') i where i->>''user_id'' = ''' || c_i2 || '''', 'eq:Berlin'),
    jsonb_build_array(c_f, 'oil: reject needs note', 'select public.review_oil_request(jsonb_build_object(''requestId'', (select id from public.oil_requests where user_id = ''' || c_i2 || '''), ''decision'', ''reject''))::text', 'err:invalid-argument'),
    jsonb_build_array(c_f, 'oil: finance approves', 'select public.review_oil_request(jsonb_build_object(''requestId'', (select id from public.oil_requests where user_id = ''' || c_i2 || '''), ''decision'', ''approve''))->>''status''', 'eq:approved'),
    jsonb_build_array(c_f, 'oil: finance fulfils', 'select public.review_oil_request(jsonb_build_object(''requestId'', (select id from public.oil_requests where user_id = ''' || c_i2 || '''), ''decision'', ''fulfil''))->>''status''', 'eq:fulfilled'),
    jsonb_build_array(c_i2, 'oil: allocation fulfilled', 'select status from public.oil_allocations where id = ''' || v_alloc || '''', 'eq:fulfilled'),
    jsonb_build_array(c_o2, 'oil: donate then cancel releases', 'select public.cancel_oil_request(jsonb_build_object(''requestId'', (public.request_oil(jsonb_build_object(''kind'', ''donate'', ''allocationIds'', (select jsonb_agg(id) from public.oil_allocations where user_id = ''' || c_o2 || ''')))->>''requestId'')::uuid))->>''status''', 'eq:cancelled'),
    jsonb_build_array(c_o2, 'oil: allocation available again', 'select status from public.oil_allocations where user_id = ''' || c_o2 || ''' and tree_id = ''tree_oil''', 'eq:available'),
    jsonb_build_array(c_i2, 'oil: export decrypts own contact', 'select public.export_my_oil()->''oilRequests''->0->''contact''->>''city''', 'eq:Berlin'),
    jsonb_build_array('postgres', 'oil: lifecycle mails to investor', 'select count(*)::text from private.email_outbox where recipient = ''i2@test.faseela.invalid'' and template in (''oil_request_received'', ''oil_request_approved'', ''oil_request_fulfilled'')', 'eq:3')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('role', 'none', true);
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      elsif v_actor <> 'postgres' then
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      else
        perform set_config('request.jwt.claims', '', true);
      end if;
      execute v_sql into v_got;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---- share certificates ---------------------------------------------------------------------
  v_serial := 'FSL-' || to_char(now(), 'YYYY') || '-' || upper(substr(v_req1, 1, 16));
  v_tests := jsonb_build_array(
    jsonb_build_array(c_i1, 'cert: owner gets data', 'select public.share_certificate(''{"shareId":"' || v_req1 || '"}'')->>''serial''', 'eq:' || v_serial),
    jsonb_build_array(c_i1, 'cert: carries holder name', 'select public.share_certificate(''{"shareId":"' || v_req1 || '"}'')->>''holderName''', 'eq:Investor One'),
    jsonb_build_array(c_i2, 'cert: foreign share hidden', 'select public.share_certificate(''{"shareId":"' || v_req1 || '"}'')::text', 'err:not-found'),
    jsonb_build_array(c_a, 'cert: admin may fetch any', 'select public.share_certificate(''{"shareId":"' || v_req1 || '"}'')->>''treeId''', 'eq:tree_01'),
    jsonb_build_array('anon', 'cert: anon cannot fetch data', 'select public.share_certificate(''{"shareId":"' || v_req1 || '"}'')::text', 'err'),
    jsonb_build_array('anon', 'cert: anon verifies serial', 'select (v->>''valid'') || ''|'' || (v->>''holderInitials'') || ''|'' || (v->>''shareCount'') from public.verify_certificate(''{"serial":"' || v_serial || '"}'') v', 'eq:true|I.O.|1'),
    jsonb_build_array('anon', 'cert: verification leaks no id or name', 'select (public.verify_certificate(''{"serial":"' || v_serial || '"}'')::text ~* ''Investor One|' || c_i1 || '|' || substr(v_req1, 17, 20) || ''')::text', 'eq:false'),
    jsonb_build_array('anon', 'cert: unknown serial', 'select public.verify_certificate(''{"serial":"FSL-2026-0000000000000000"}'')->>''valid''', 'eq:false'),
    jsonb_build_array('anon', 'cert: malformed serial', 'select public.verify_certificate(''{"serial":"FSL-20xx-zz"}'')->>''reason''', 'eq:format')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('role', 'none', true);
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      else
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      end if;
      execute v_sql into v_got;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;

  -- ---- public tree profiles, farmer profiles (consent), my_assignments ----------------------------
  v_tests := jsonb_build_array(
    jsonb_build_array(c_fa, 'assign: farmer sees own tree', 'select public.my_assignments()->''trees''->0->>''treeId''', 'eq:tree_01'),
    jsonb_build_array(c_fa, 'assign: tree carries names', 'select (public.my_assignments()->''trees''->0 ? ''nameEn'')::text', 'eq:true'),
    jsonb_build_array(c_i1, 'assign: investor has none', 'select jsonb_array_length(public.my_assignments()->''trees'')::text || jsonb_array_length(public.my_assignments()->''mills'')::text', 'eq:00'),
    jsonb_build_array(c_m, 'assign: mill operator sees mill', 'select public.my_assignments()->''mills''->>0', 'eq:mill_01'),
    jsonb_build_array('anon', 'assign: anon denied', 'select public.my_assignments()::text', 'err'),
    jsonb_build_array(c_i1, 'profile: investor cannot create farmer profile', 'select public.update_farmer_profile(''{"displayName":"X Y"}'')::text', 'err:permission-denied'),
    jsonb_build_array(c_fa, 'profile: consent needs a name', 'select public.update_farmer_profile(''{"consentPublic":true}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_fa, 'profile: photo must be own folder', 'select public.update_farmer_profile(''{"displayName":"Abu Ahmad","photoPath":"' || c_i1 || '/profile/a.jpg"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_fa, 'profile: photo must be profile folder', 'select public.update_farmer_profile(''{"displayName":"Abu Ahmad","photoPath":"' || c_fa || '/tree_01/p.jpg"}'')::text', 'err:invalid-argument'),
    jsonb_build_array(c_fa, 'profile: upload own profile photo', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''field-media'', ''' || c_fa || '/profile/me.jpg'', ''' || c_fa || ''', ''{"mimetype":"image/jpeg"}'')', 'ok'),
    jsonb_build_array(c_i1, 'profile: investor cannot upload profile photo', 'insert into storage.objects (bucket_id, name, owner_id, metadata) values (''field-media'', ''' || c_i1 || '/profile/me.jpg'', ''' || c_i1 || ''', ''{"mimetype":"image/jpeg"}'')', 'err'),
    jsonb_build_array(c_fa, 'profile: save private profile', 'select public.update_farmer_profile(''{"displayName":"Abu Ahmad","village":"Al-Qusayr","region":"Homs","yearsFarming":25,"bio":"نبذة","photoPath":"' || c_fa || '/profile/me.jpg"}'')->>''consentPublic''', 'eq:false'),
    jsonb_build_array(c_fa, 'profile: owner reads own private row', 'select count(*)::text from public.farmer_profiles where farmer_uid = ''' || c_fa || '''', 'eq:1'),
    jsonb_build_array(c_i1, 'profile: private row hidden from others', 'select count(*)::text from public.farmer_profiles', 'eq:0'),
    jsonb_build_array('anon', 'profile: anon has no table read at all (audit F3)', 'select count(*)::text from public.farmer_profiles', 'err'),
    jsonb_build_array('anon', 'tree: private farmer absent from public profile', 'select (jsonb_typeof(public.public_tree_profile(''{"treeId":"tree_01"}'')->''farmer'') is distinct from ''object'')::text', 'eq:true'),
    jsonb_build_array('anon', 'tree: published events listed', 'select (jsonb_array_length(public.public_tree_profile(''{"treeId":"tree_01"}'')->''events'') >= 1)::text', 'eq:true'),
    jsonb_build_array('anon', 'tree: media paths not exposed', 'select (public.public_tree_profile(''{"treeId":"tree_01"}'')::text like ''%/tree_01/p.jpg%'')::text', 'eq:false'),
    jsonb_build_array('anon', 'tree: unknown tree', 'select public.public_tree_profile(''{"treeId":"tree_nope"}'')::text', 'err:not-found'),
    jsonb_build_array('anon', 'tree: malformed id', 'select public.public_tree_profile(''{"treeId":"../x"}'')::text', 'err:invalid-argument'),
    jsonb_build_array('postgres', 'audit F4: seed an unlisted tree', 'insert into public.trees_public (tree_id, status, total_shares, available_shares, price_per_share_minor) values (''tree_hidden'', ''unlisted'', 4, 4, 1000)', 'ok'),
    jsonb_build_array('anon', 'audit F4: unlisted tree looks unknown to anon', 'select public.public_tree_profile(''{"treeId":"tree_hidden"}'')::text', 'err:not-found'),
    jsonb_build_array('anon', 'audit F4: direct read of unlisted tree is empty', 'select count(*)::text from public.trees_public where tree_id = ''tree_hidden''', 'eq:0'),
    jsonb_build_array('postgres', 'audit L3: realtime publication does not publish removals', 'select (not pubdelete)::text from pg_publication where pubname = ''supabase_realtime''', 'eq:true'),
    jsonb_build_array('postgres', 'audit L1: suspend i1', 'update auth.users set banned_until = now() + interval ''1 day'' where id = ''' || c_i1 || '''', 'ok'),
    jsonb_build_array(c_i1, 'audit L1: suspended user is refused by RPCs', 'select public.export_my_data()::text', 'err:permission-denied'),
    jsonb_build_array('postgres', 'audit L1: unsuspend i1', 'update auth.users set banned_until = null where id = ''' || c_i1 || '''', 'ok'),
    jsonb_build_array(c_i1, 'audit L1: access restored', 'select (public.export_my_data() is not null)::text', 'eq:true'),
    jsonb_build_array('postgres', 'audit L2: 45 enqueues for one recipient', 'select count(*)::text from (select private.enqueue_email(''quota@test.faseela.invalid'', ''ops_alert'', ''{}'') from generate_series(1, 45)) s', 'eq:45'),
    jsonb_build_array('postgres', 'audit L2: outbox holds at most 40 per hour', 'select count(*)::text from private.email_outbox where recipient = ''quota@test.faseela.invalid''', 'eq:40'),
    jsonb_build_array('postgres', 'audit L2: surplus counted, not queued', 'select sum(skipped)::text from private.email_skipped where recipient = ''quota@test.faseela.invalid''', 'eq:5'),
    jsonb_build_array(c_fa, 'audit F2: report with a phantom photo', 'select public.submit_farmer_update(''{"treeId":"tree_01","eventType":"watering","notes":"Phantom","mediaPaths":["' || c_fa || '/tree_01/ghost.jpg"]}'')->>''status''', 'eq:pending_review'),
    jsonb_build_array(c_q, 'audit F2: decision is mandatory', 'select public.review_farmer_update(jsonb_build_object(''updateId'', (select id from public.farmer_updates where farmer_uid = ''' || c_fa || ''' and notes = ''Phantom'')))::text', 'err:invalid-argument'),
    jsonb_build_array(c_q, 'audit F2: phantom media is not published', 'select public.review_farmer_update(jsonb_build_object(''updateId'', (select id from public.farmer_updates where farmer_uid = ''' || c_fa || ''' and notes = ''Phantom''), ''decision'', ''publish''))->>''mediaPublished''', 'eq:0'),
    jsonb_build_array('anon', 'audit F2: published event carries no phantom media', 'select media_count::text from public.tree_events_public where notes = ''Phantom''', 'eq:0'),
    jsonb_build_array(c_fa, 'profile: publish with consent', 'select public.update_farmer_profile(''{"displayName":"Abu Ahmad","consentPublic":true}'')->>''consentPublic''', 'eq:true'),
    jsonb_build_array(c_fa, 'profile: consent timestamped', 'select (consent_at is not null and consent_version = ''farmer-public-v1'')::text from public.farmer_profiles where farmer_uid = ''' || c_fa || '''', 'eq:true'),
    jsonb_build_array('anon', 'profile: consented row still not table-readable by anon (audit F3)', 'select display_name from public.farmer_profiles where farmer_uid = ''' || c_fa || '''', 'err'),
    jsonb_build_array(c_i1, 'profile: consented row not table-readable by other users (audit F3)', 'select count(*)::text from public.farmer_profiles', 'eq:0'),
    jsonb_build_array('anon', 'tree: consented farmer shown', 'select public.public_tree_profile(''{"treeId":"tree_01"}'')->''farmer''->>''displayName''', 'eq:Abu Ahmad'),
    jsonb_build_array('anon', 'tree: farmer uid never leaked', 'select (public.public_tree_profile(''{"treeId":"tree_01"}'')::text like ''%' || c_fa || '%'')::text', 'eq:false'),
    jsonb_build_array('anon', 'media: anon cannot list media paths', 'select public.tree_media_paths(''tree_01'')::text', 'err'),
    jsonb_build_array(c_fa, 'media: farmer cannot list media paths', 'select public.tree_media_paths(''tree_01'')::text', 'err'),
    jsonb_build_array(c_a, 'media: admin cannot list media paths', 'select public.tree_media_paths(''tree_01'')::text', 'err'),
    jsonb_build_array(c_fa, 'profile: withdraw consent', 'select public.update_farmer_profile(''{"displayName":"Abu Ahmad","consentPublic":false}'')->>''consentPublic''', 'eq:false'),
    jsonb_build_array('anon', 'tree: farmer hidden after withdrawal', 'select (jsonb_typeof(public.public_tree_profile(''{"treeId":"tree_01"}'')->''farmer'') is distinct from ''object'')::text', 'eq:true'),
    jsonb_build_array(c_a, 'profile: consent changes audited', 'select (count(*) >= 2)::text from public.audit_logs where action in (''farmer_profile.published'', ''farmer_profile.withdrawn'') and actor_uid = ''' || c_fa || '''', 'eq:true')
  );
  foreach v_case in array (select array_agg(value order by ordinality) from jsonb_array_elements(v_tests) with ordinality) loop
    v_actor := v_case ->> 0;
    v_sql := v_case ->> 2;
    v_expect := v_case ->> 3;
    begin
      perform set_config('role', 'none', true);
      if v_actor = 'anon' then
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        perform set_config('role', 'anon', true);
      elsif v_actor <> 'postgres' then
        perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
      else
        perform set_config('request.jwt.claims', '', true);
      end if;
      if v_sql ~* '^\s*select' then
        execute v_sql into v_got;
      else
        execute v_sql;
        v_got := null;
      end if;
      perform set_config('role', 'none', true);
      if v_expect = 'ok' or (v_expect like 'eq:%' and v_got is not distinct from substr(v_expect, 4)) then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got %s', v_case ->> 1, v_expect, coalesce(v_got, 'NULL'));
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint, v_msg = message_text;
      perform set_config('role', 'none', true);
      if v_expect = 'err' or v_expect = 'err:' || coalesce(v_hint, '') then
        v_pass := v_pass + 1;
      else
        v_fail := v_fail + 1;
        v_failures := v_failures || format('%s: expected %s, got error [%s] %s', v_case ->> 1, v_expect, coalesce(v_hint, ''), v_msg);
      end if;
    end;
  end loop;
  -- media paths are signed only by the Edge Function (service_role); the DB decides what is public.
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
  v_got := public.tree_media_paths('tree_01')::text;
  perform set_config('role', 'none', true);
  if v_got like '%' || c_fa || '/tree_01/p.jpg%' and v_got not like '%/profile/me.jpg%' then
    v_pass := v_pass + 1;
  else
    v_fail := v_fail + 1;
    v_failures := v_failures || ('tree_media_paths (service_role): published photo missing or withdrawn profile photo leaked: ' || coalesce(v_got, 'NULL'));
  end if;

  -- audit F4: an unlisted tree yields no signable media even for the signing role.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
  v_got := public.tree_media_paths('tree_hidden')::text;
  perform set_config('role', 'none', true);
  if v_got = '{"events": [], "farmerPhoto": null}' then
    v_pass := v_pass + 1;
  else
    v_fail := v_fail + 1;
    v_failures := v_failures || ('audit F4: unlisted tree media not empty: ' || coalesce(v_got, 'NULL'));
  end if;

  -- ---- scheduled jobs --------------------------------------------------------------------------
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  update public.investment_requests set expires_at = now() - interval '1 minute'
   where user_id = c_i1 and status = 'awaiting_payment';
  -- Run the job first: sub-selects in one expression may be evaluated before the call (init plans).
  v_got := private.expire_investment_requests()::text;
  v_got := format('expired=%s tree_03.available=%s tree_02.reserved=%s', v_got,
    (select available_shares from public.trees_public where tree_id = 'tree_03'),
    (select reserved_shares from private.trees where tree_id = 'tree_02'));
  if v_got = 'expired=2 tree_03.available=4 tree_02.reserved=0' then
    v_pass := v_pass + 1;
  else
    v_fail := v_fail + 1;
    v_failures := v_failures || ('expiry job: ' || v_got);
  end if;
  if (select sold_shares from private.trees where tree_id = 'tree_01') = 3
     and (select available_shares from public.trees_public where tree_id = 'tree_01') = 1 then
    v_pass := v_pass + 1;
  else
    v_fail := v_fail + 1;
    v_failures := v_failures || 'approved share not booked as sold'::text;
  end if;
  update public.investment_requests set status = 'under_review', proof_submitted_at = now() - interval '73 hours'
   where id = v_reqf;
  if private.flag_overdue_reviews() = 1 then
    v_pass := v_pass + 1;
  else
    v_fail := v_fail + 1;
    v_failures := v_failures || 'SLA flag job did not flag the overdue review'::text;
  end if;

  raise exception 'TEST SUMMARY passed=% failed=% %', v_pass, v_fail,
    case when v_fail = 0 then '' else array_to_string(v_failures, ' | ') end
    using errcode = 'P0002';
end;
$test$;
