-- Faseela admin operations suite (migration 38). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := 'ae000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := 'ae000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_i constant uuid := 'ae000000-0000-4000-8000-0000000000e1'; -- investor
  r1 constant text := repeat('d', 64);
  c_new constant jsonb := '{"treeId":"tree_ops_test","name":"شجرة اختبار","nameEn":"Test tree","region":"إدلب","regionEn":"Idlib","treeType":"صوراني","treeTypeEn":"Sorani","totalShares":10,"pricePerShareMinor":3500,"plantedYear":1990,"estimatedAnnualYieldKg":40}';
  v_j jsonb; v_n integer; v_tree text; v_mail bigint; v_mail2 bigint;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_anon() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true); perform set_config('role','anon',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;
  -- Runs a statement as the given user and returns the error code (or OK).
  create function pg_temp.call_as(p uuid, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p); return pg_temp.try(p_sql); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'oa@t.faseela.invalid', 'Ops Admin'), (c_f, 'of@t.faseela.invalid', 'Ops Finance'), (c_i, 'oi@t.faseela.invalid', 'Ops Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin');
  select tree_id into v_tree from public.trees_public order by tree_id limit 1;
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at, proof_submitted_at)
  values (r1, c_i, v_tree, 2, false, 7000, 'USD', 'approved', now() + interval '1 day', now());
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status)
  values (r1, r1, c_i, v_tree, 2, false, 7000, 'USD', 'active'); -- a share row carries the id of its request
  insert into private.email_outbox (recipient, template, params, status, attempts, last_error) values ('oi@t.faseela.invalid', 'onboarding_welcome', '{}', 'failed', 5, 'provider not configured') returning id into v_mail;
  insert into private.email_outbox (recipient, template, params, status, attempts) values ('oi@t.faseela.invalid', 'onboarding_welcome', '{}', 'sent', 1) returning id into v_mail2;

  -- access control
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot create a tree', pg_temp.try(format('select public.admin_create_tree(%L)', c_new)) <> 'OK');
  perform pg_temp.chk('investor cannot create a tree', pg_temp.call_as(c_i, format('select public.admin_create_tree(%L)', c_new)) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot create a tree', pg_temp.call_as(c_f, format('select public.admin_create_tree(%L)', c_new)) = 'permission-denied');
  perform pg_temp.chk('investor cannot edit a tree', pg_temp.call_as(c_i, format('select public.admin_update_tree(%L)', jsonb_build_object('treeId', v_tree, 'nameEn', 'Hacked'))) = 'permission-denied');
  perform pg_temp.chk('investor cannot open a user record', pg_temp.call_as(c_i, format('select public.admin_user_detail(%L)', jsonb_build_object('userId', c_a))) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot open a user record', pg_temp.call_as(c_f, format('select public.admin_user_detail(%L)', jsonb_build_object('userId', c_i))) = 'permission-denied');
  perform pg_temp.chk('investor cannot read the register', pg_temp.call_as(c_i, $q$select public.admin_list_shares('{}'::jsonb)$q$) = 'permission-denied');
  perform pg_temp.chk('investor cannot read the mail queue', pg_temp.call_as(c_i, 'select public.admin_list_outbox()') = 'permission-denied');
  perform pg_temp.chk('finance admin cannot requeue mail', pg_temp.call_as(c_f, $q$select public.admin_retry_email('{"all":true}'::jsonb)$q$) = 'permission-denied');

  -- tree creation
  perform pg_temp.chk('bad tree id refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"treeId":"Bad Id!"}')) = 'invalid-argument');
  perform pg_temp.chk('markup in a name refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"nameEn":"<b>x</b>"}')) = 'invalid-argument');
  perform pg_temp.chk('missing region refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new - 'regionEn')) = 'invalid-argument');
  perform pg_temp.chk('fractional share count refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"totalShares":2.5}')) = 'invalid-argument');
  perform pg_temp.chk('price as text refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"pricePerShareMinor":"3500"}')) = 'invalid-argument');
  perform pg_temp.chk('zero price refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"pricePerShareMinor":0}')) = 'invalid-argument');
  perform pg_temp.chk('remote image refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"images":["https://evil.example/x.png"]}')) = 'invalid-argument');
  perform pg_temp.chk('land option without price refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"hasLandOption":true}')) = 'invalid-argument');
  perform pg_temp.chk('future planting year refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new || '{"plantedYear":2999}')) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_create_tree(c_new);
  perform pg_temp.as_pg();
  perform pg_temp.chk('tree created unlisted with full inventory', (v_j->>'status') = 'unlisted'
    and (select status = 'unlisted' and available_shares = 10 and total_shares = 10 and region_en = 'Idlib' and currency = 'USD' from public.trees_public where tree_id = 'tree_ops_test')
    and (select total_shares = 10 and sold_shares = 0 and price_per_share_minor = 3500 from private.trees where tree_id = 'tree_ops_test'), v_j::text);
  perform pg_temp.chk('creation audited', exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'tree.created' and target = 'trees_public/tree_ops_test'));
  perform pg_temp.chk('duplicate id refused', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new)) = 'already-exists');
  perform pg_temp.as_anon();
  perform pg_temp.chk('unlisted tree invisible to the public', not exists (select 1 from public.trees_public where tree_id = 'tree_ops_test'));

  -- tree editing
  perform pg_temp.as_pg();
  update private.trees set sold_shares = 3, reserved_shares = 2 where tree_id = 'tree_ops_test';
  update public.trees_public set available_shares = 5 where tree_id = 'tree_ops_test';
  perform pg_temp.chk('share count below sold+reserved refused', pg_temp.call_as(c_a, $q$select public.admin_update_tree('{"treeId":"tree_ops_test","totalShares":4}'::jsonb)$q$) = 'failed-precondition');
  perform pg_temp.chk('unknown tree refused', pg_temp.call_as(c_a, $q$select public.admin_update_tree('{"treeId":"no_such_tree","nameEn":"Abc"}'::jsonb)$q$) = 'not-found');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_update_tree('{"treeId":"tree_ops_test","totalShares":8,"pricePerShareMinor":4000,"nameEn":"Renamed tree","landPriceMinor":9999}'::jsonb);
  perform pg_temp.as_pg();
  perform pg_temp.chk('edit keeps the inventory consistent', (select total_shares = 8 and available_shares = 3 and price_per_share_minor = 4000 and name_en = 'Renamed tree' and name = 'شجرة اختبار' and land_price_minor = 0 from public.trees_public where tree_id = 'tree_ops_test')
    and (select total_shares = 8 and sold_shares = 3 and reserved_shares = 2 and price_per_share_minor = 4000 and land_price_minor = 0 from private.trees where tree_id = 'tree_ops_test'),
    (select row_to_json(t)::text from public.trees_public t where tree_id = 'tree_ops_test'));
  perform pg_temp.chk('edit audited with before/after', exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'tree.updated' and (details->>'priceBefore')::int = 3500 and (details->>'priceAfter')::int = 4000 and (details->>'sharesAfter')::int = 8));
  perform pg_temp.chk('open request keeps its amount', (select amount_minor = 7000 from public.investment_requests where id = r1));
  perform pg_temp.as_user(c_a);
  v_j := public.admin_get_tree('{"treeId":"tree_ops_test"}'::jsonb);
  perform pg_temp.chk('edit form record complete', (v_j->>'nameEn') = 'Renamed tree' and (v_j->>'soldShares')::int = 3 and (v_j->>'reservedShares')::int = 2 and jsonb_array_length(v_j->'images') = 1, v_j::text);

  -- user record
  v_j := public.admin_user_detail(jsonb_build_object('userId', c_i));
  perform pg_temp.chk('user record has profile, requests and shares', (v_j->>'email') = 'oi@t.faseela.invalid' and (v_j->>'role') = 'investor'
    and jsonb_array_length(v_j->'requests') = 1 and jsonb_array_length(v_j->'shares') = 1 and (v_j->'counts'->>'requests')::int = 1
    and v_j->'assignments' ?& array['trees','mills'], v_j::text);
  perform pg_temp.chk('user record carries no credentials', v_j::text not ilike '%password%' and v_j::text not ilike '%token%');
  perform pg_temp.as_pg();
  perform pg_temp.chk('opening a record is audited', exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'user.viewed' and target = 'users/' || c_i::text));
  perform pg_temp.chk('unknown user refused', pg_temp.call_as(c_a, $q$select public.admin_user_detail('{"userId":"ae000000-0000-4000-8000-00000000dead"}'::jsonb)$q$) = 'not-found');
  perform pg_temp.chk('malformed user id refused', pg_temp.call_as(c_a, $q$select public.admin_user_detail('{"userId":"1 or 1=1"}'::jsonb)$q$) = 'invalid-argument');

  -- ownership register
  perform pg_temp.as_user(c_f);
  v_j := public.admin_list_shares(jsonb_build_object('treeId', v_tree));
  perform pg_temp.chk('finance admin reads the register', (v_j->>'total')::int >= 1 and exists (select 1 from jsonb_array_elements(v_j->'rows') e where e->>'ownerEmail' = 'oi@t.faseela.invalid' and (e->>'shareCount')::int = 2), v_j::text);
  v_j := public.admin_list_shares('{"treeId":"tree_ops_test"}'::jsonb);
  perform pg_temp.chk('tree filter applies', (v_j->>'total')::int = 0 and jsonb_array_length(v_j->'rows') = 0, v_j::text);
  perform pg_temp.chk('oversized page refused', pg_temp.call_as(c_f, $q$select public.admin_list_shares('{"limit":5000}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.chk('bad tree filter refused', pg_temp.call_as(c_f, $q$select public.admin_list_shares('{"treeId":"x; drop"}'::jsonb)$q$) = 'invalid-argument');

  -- e-mail queue
  perform pg_temp.as_user(c_a);
  v_j := public.admin_list_outbox();
  perform pg_temp.chk('queue lists counts and masked recipients', (v_j->'counts'->>'failed')::int >= 1 and exists (select 1 from jsonb_array_elements(v_j->'rows') e where (e->>'id')::bigint = v_mail and e->>'recipient' = 'o***@t.faseela.invalid')
    and v_j::text not like '%oi@t.faseela.invalid%', left(v_j::text, 300));
  perform pg_temp.chk('retry needs a target', pg_temp.call_as(c_a, $q$select public.admin_retry_email('{}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.chk('retry refuses id and all together', pg_temp.call_as(c_a, format('select public.admin_retry_email(%L)', jsonb_build_object('id', v_mail, 'all', true))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_retry_email(jsonb_build_object('id', v_mail2));
  perform pg_temp.chk('a sent mail is not requeued', (v_j->>'requeued')::int = 0, v_j::text);
  v_j := public.admin_retry_email(jsonb_build_object('id', v_mail));
  perform pg_temp.as_pg();
  perform pg_temp.chk('failed mail requeued', (v_j->>'requeued')::int = 1 and (select status = 'pending' and attempts = 0 and last_error is null from private.email_outbox where id = v_mail), v_j::text);
  perform pg_temp.chk('retry audited', exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'outbox.retry' and (details->>'count')::int = 1));

  perform pg_temp.as_pg();
  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
