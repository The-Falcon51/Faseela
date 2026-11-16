-- Faseela staff second-factor suite (migration 49). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := '5f000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := '5f000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_i constant uuid := '5f000000-0000-4000-8000-0000000000e1'; -- sponsor
  c_m constant uuid := '5f000000-0000-4000-8000-0000000000b1'; -- mill operator
  v_j jsonb; v_n integer;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  -- p_aal is the assurance level of the session: aal1 = password only, aal2 = password + second factor.
  create function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated','aal',p_aal)::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;
  create function pg_temp.call_as(p uuid, p_aal text, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p, p_aal); return pg_temp.try(p_sql); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'sa@t.faseela.invalid', 'Mfa Admin'), (c_f, 'sf@t.faseela.invalid', 'Mfa Finance'), (c_i, 'si@t.faseela.invalid', 'Mfa Sponsor'), (c_m, 'sm@t.faseela.invalid', 'Mfa Miller')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin'), (c_m, 'mill_operator');
  delete from private.app_settings where key = 'staff_mfa_required';

  -- ---------------------------------------------------------------- off by default: nothing changes
  perform pg_temp.chk('off by default', not private.staff_mfa_required());
  perform pg_temp.chk('admin works with a password only', pg_temp.call_as(c_a, 'aal1', 'select public.admin_list_master_data()') = 'OK');
  perform pg_temp.chk('finance works with a password only', pg_temp.call_as(c_f, 'aal1', 'select public.admin_list_trees()') = 'OK');
  perform pg_temp.as_user(c_a, 'aal1');
  v_j := public.staff_security_state();
  perform pg_temp.chk('state: not required, session aal1', v_j = '{"mfaRequired": false, "sessionLevel": "aal1"}'::jsonb, v_j::text);

  -- ---------------------------------------------------------------- who may flip the switch, and from which session
  perform pg_temp.chk('sponsor cannot require it', pg_temp.call_as(c_i, 'aal2', $q$select public.admin_set_staff_mfa('{"required":true}')$q$) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot require it', pg_temp.call_as(c_f, 'aal2', $q$select public.admin_set_staff_mfa('{"required":true}')$q$) = 'permission-denied');
  perform pg_temp.chk('sponsor cannot read the staff state', pg_temp.call_as(c_i, 'aal1', 'select public.staff_security_state()') = 'permission-denied');
  perform pg_temp.chk('non-boolean value refused', pg_temp.call_as(c_a, 'aal2', $q$select public.admin_set_staff_mfa('{"required":"yes"}')$q$) = 'invalid-argument');
  perform pg_temp.chk('admin without a second factor cannot require it', pg_temp.call_as(c_a, 'aal1', $q$select public.admin_set_staff_mfa('{"required":true}')$q$) = 'failed-precondition');
  perform pg_temp.as_pg();
  perform pg_temp.chk('refused attempts left it off', not private.staff_mfa_required());
  perform pg_temp.chk('admin with a second factor requires it', pg_temp.call_as(c_a, 'aal2', $q$select public.admin_set_staff_mfa('{"required":true}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('switch stored and audited', private.staff_mfa_required()
    and exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'settings.staff_mfa' and details->>'required' = 'true'));

  -- ---------------------------------------------------------------- required: staff need aal2, everyone else is untouched
  perform pg_temp.chk('admin with password only is stopped', pg_temp.call_as(c_a, 'aal1', 'select public.admin_list_master_data()') = 'mfa-required');
  perform pg_temp.chk('finance with password only is stopped', pg_temp.call_as(c_f, 'aal1', 'select public.admin_list_trees()') = 'mfa-required');
  perform pg_temp.chk('finance cannot review with password only', pg_temp.call_as(c_f, 'aal1', format($q$select public.review_investment_request('{"requestId":"%s","decision":"approve"}')$q$, repeat('a', 64))) = 'mfa-required');
  perform pg_temp.chk('a session without the claim counts as aal1', pg_temp.try('select 1') = 'OK' and (select pg_temp.call_as(c_a, '', 'select public.admin_list_master_data()')) = 'mfa-required');
  perform pg_temp.chk('admin with a second factor works', pg_temp.call_as(c_a, 'aal2', 'select public.admin_list_master_data()') = 'OK');
  perform pg_temp.chk('finance with a second factor works', pg_temp.call_as(c_f, 'aal2', 'select public.admin_list_trees()') = 'OK');
  perform pg_temp.chk('sponsor is not asked for a second factor', pg_temp.call_as(c_i, 'aal1', $q$select public.set_my_locale('{"locale":"en"}')$q$) = 'OK');
  perform pg_temp.chk('sponsor is still refused staff functions as before', pg_temp.call_as(c_i, 'aal1', 'select public.admin_list_trees()') = 'permission-denied');
  perform pg_temp.as_user(c_f, 'aal1');
  v_j := public.staff_security_state();
  perform pg_temp.chk('staff can read the state without a second factor', v_j = '{"mfaRequired": true, "sessionLevel": "aal1"}'::jsonb, v_j::text);

  -- ---------------------------------------------------------------- switching it off again
  perform pg_temp.chk('cannot be switched off with password only', pg_temp.call_as(c_a, 'aal1', $q$select public.admin_set_staff_mfa('{"required":false}')$q$) = 'mfa-required');
  perform pg_temp.chk('admin with a second factor switches it off', pg_temp.call_as(c_a, 'aal2', $q$select public.admin_set_staff_mfa('{"required":false}')$q$) = 'OK');
  perform pg_temp.chk('password-only staff work again', pg_temp.call_as(c_f, 'aal1', 'select public.admin_list_trees()') = 'OK');
  perform pg_temp.chk('the switch is not writable for API roles', pg_temp.call_as(c_i, 'aal1', $q$insert into private.app_settings (key, value) values ('staff_mfa_required', 'true') on conflict (key) do update set value = 'true'$q$) <> 'OK');

  -- ---------------------------------------------------------------- mill assignments reference mill records
  perform pg_temp.chk('assigning an unknown mill is refused', pg_temp.call_as(c_a, 'aal1', format($q$select public.admin_assign('{"userId":"%s","kind":"mill","action":"add","targetId":"mill_unknown"}')$q$, c_m)) = 'not-found');
  perform pg_temp.chk('assigning an existing mill works', pg_temp.call_as(c_a, 'aal1', format($q$select public.admin_assign('{"userId":"%s","kind":"mill","action":"add","targetId":"mill_01"}')$q$, c_m)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('the table itself refuses an unknown mill', pg_temp.try(format($q$insert into public.mill_assignments (operator_uid, mill_id) values ('%s', 'mill_ghost')$q$, c_m)) <> 'OK');

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
