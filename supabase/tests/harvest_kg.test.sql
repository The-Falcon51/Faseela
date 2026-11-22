-- Faseela harvest suite (migration 45). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_f constant uuid := 'b2000000-0000-4000-8000-0000000000f1'; -- farmer (assigned to tree_14)
  c_g constant uuid := 'b2000000-0000-4000-8000-0000000000f2'; -- farmer (not assigned)
  c_q constant uuid := 'b2000000-0000-4000-8000-0000000000c1'; -- quality auditor
  c_i constant uuid := 'b2000000-0000-4000-8000-0000000000e1'; -- owner of 1 of 4 shares
  r1 constant text := repeat('8', 64);
  v_r text := ''; v_e text; v_j jsonb; v_b uuid;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n), now(), now()
  from (values (c_f, 'hf@t.faseela.invalid', 'H Farmer'), (c_g, 'hg@t.faseela.invalid', 'H Other'), (c_q, 'hq@t.faseela.invalid', 'H Auditor'), (c_i, 'hi@t.faseela.invalid', 'H Owner')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_f, 'farmer'), (c_g, 'farmer'), (c_q, 'quality_auditor');
  insert into public.farmer_assignments (farmer_uid, tree_id) values (c_f, 'tree_14');
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at) values (r1, c_i, 'tree_14', 1, false, 2900, 'USD', 'approved', now() + interval '1 day');
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status) values (r1, r1, c_i, 'tree_14', 1, false, 2900, 'USD', 'active');

  perform set_config('request.jwt.claims', json_build_object('sub', c_g, 'role', 'authenticated')::text, true);
  begin perform private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":30,"netKg":24}'::jsonb); v_r := v_r || 'FAIL unassigned allowed | ';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || 'unassigned=' || v_e || ' | '; end;
  perform set_config('request.jwt.claims', json_build_object('sub', c_f, 'role', 'authenticated')::text, true);
  begin perform private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":20,"netKg":24}'::jsonb); v_r := v_r || 'FAIL net>gross allowed | ';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || 'net>gross=' || v_e || ' | '; end;
  begin perform private.submit_harvest_batch('{"treeId":"tree_01","harvestKg":30,"netKg":24}'::jsonb); v_r := v_r || 'FAIL olive allowed | ';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || 'olive=' || v_e || ' | '; end;
  v_j := private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":30,"netKg":24}'::jsonb);
  v_b := (v_j->>'batchId')::uuid;
  v_r := v_r || 'submitted=' || (v_j->>'status') || ' | ';
  begin perform private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":30,"netKg":24}'::jsonb); v_r := v_r || 'FAIL duplicate allowed | ';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || 'duplicate=' || v_e || ' | '; end;
  perform set_config('request.jwt.claims', json_build_object('sub', c_q, 'role', 'authenticated')::text, true);
  v_j := private.certify_pressing_batch(jsonb_build_object('batchId', v_b, 'decision', 'certify', 'certificateSerial', 'HARVEST-TEST-1', 'note', 'ok'));
  v_r := v_r || 'certified=' || (select status from public.pressing_batches where id = v_b)
             || ' | grams=' || coalesce((select liters_ml::text from public.oil_allocations where batch_id = v_b and user_id = c_i), 'none')
             || ' | mailUnit=' || coalesce((select params->>'unit' from private.email_outbox where template = 'oil_allocated' and recipient = 'hi@t.faseela.invalid' order by id desc limit 1), 'none')
             || ' | tasksOliveOnly=' || (select (pg_get_functiondef(p.oid) like '%p.crop_category = ''olive'' and t.mill_id is null%')::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'admin_tasks')
             || ' | tree13=' || (select status from public.trees_public where tree_id = 'tree_13');
  raise exception 'TEST RESULT %', v_r;
end
$t$;
