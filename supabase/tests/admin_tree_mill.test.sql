-- Faseela tree mill suite (migration 42). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := 'b0000000-0000-4000-8000-0000000000a1';
  c_i constant uuid := 'b0000000-0000-4000-8000-0000000000e1';
  v_j jsonb; v_r text[] := '{}'; v_e text;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'ma@t.faseela.invalid', 'Mill Admin'), (c_i, 'mi@t.faseela.invalid', 'Mill Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin');
  perform set_config('request.jwt.claims', json_build_object('sub', c_i, 'role', 'authenticated')::text, true);
  begin perform private.admin_set_tree_mill('{"treeId":"tree_03","millId":"mill_09"}'::jsonb); v_r := v_r || 'FAIL investor allowed';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || ('investor=' || v_e); end;
  perform set_config('request.jwt.claims', json_build_object('sub', c_a, 'role', 'authenticated')::text, true);
  begin perform private.admin_set_tree_mill('{"treeId":"tree_03","millId":"bad id!"}'::jsonb); v_r := v_r || 'FAIL bad id allowed';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || ('badid=' || v_e); end;
  begin perform private.admin_set_tree_mill('{"treeId":"nope","millId":"mill_09"}'::jsonb); v_r := v_r || 'FAIL unknown tree allowed';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; v_r := v_r || ('unknown=' || v_e); end;
  v_j := private.admin_set_tree_mill('{"treeId":"tree_03","millId":"mill_09"}'::jsonb);
  v_r := v_r || ('set=' || (select mill_id from private.trees where tree_id = 'tree_03')) || ('get=' || (private.admin_get_tree_mill('{"treeId":"tree_03"}'::jsonb)->>'millId'));
  v_j := private.admin_set_tree_mill('{"treeId":"tree_03","millId":null}'::jsonb);
  v_r := v_r || ('cleared=' || coalesce((select mill_id from private.trees where tree_id = 'tree_03'), 'NULL'))
             || ('audit=' || (select count(*) from public.audit_logs where actor_uid = c_a and action = 'tree.mill_changed'));
  raise exception 'TEST RESULT %', array_to_string(v_r, ' | ');
end
$t$;
