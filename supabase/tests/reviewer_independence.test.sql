-- Faseela reviewer independence suite (migration 47). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a1 constant uuid := '1d000000-0000-4000-8000-0000000000a1'; -- admin (appoints)
  c_a2 constant uuid := '1d000000-0000-4000-8000-0000000000a2'; -- becomes admin through a1
  c_a3 constant uuid := '1d000000-0000-4000-8000-0000000000a3'; -- admin appointed outside the app
  c_i constant uuid := '1d000000-0000-4000-8000-0000000000e1';  -- investor
  c_one constant text := '{"channels":[{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"SY00 FIRST 0001"}]}';
  c_two constant text := '{"channels":[{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"SY00 SECOND 0002"}]}';
  v_j jsonb; v_n integer;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;
  create function pg_temp.call_as(p uuid, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p); return pg_temp.try(p_sql); end $f$;

  -- Other admins of the database are parked so the admin count of this suite is known.
  update auth.users set banned_until = now() + interval '1 hour' where id in (select user_id from private.user_roles where role = 'admin');
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a1, 'ra1@t.faseela.invalid', 'Admin One'), (c_a2, 'ra2@t.faseela.invalid', 'Admin Two'), (c_a3, 'ra3@t.faseela.invalid', 'Admin Three'), (c_i, 'ri@t.faseela.invalid', 'Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a1, 'admin');

  -- The rule itself.
  perform pg_temp.chk('same person is refused', pg_temp.try(format('select private.assert_not_self_review(%L, %L)', c_a1, c_a1)) = 'permission-denied');
  perform pg_temp.chk('missing reviewer is refused', pg_temp.try(format('select private.assert_not_self_review(null, %L)', c_a1)) = 'permission-denied');
  perform pg_temp.chk('unrelated people are independent', pg_temp.try(format('select private.assert_not_self_review(%L, %L)', c_a1, c_i)) = 'OK');

  -- a1 appoints a2 as admin through the app: the appointment works, but they are not independent yet.
  perform pg_temp.chk('admin appoints a second admin', pg_temp.call_as(c_a1, format($q$select public.admin_set_user_role('{"userId":"%s","role":"admin"}')$q$, c_a2)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('appointment recorded with grantor', (select granted_by = c_a1 and role = 'admin' from private.user_roles where user_id = c_a2));
  perform pg_temp.chk('appointee cannot review the appointer', pg_temp.try(format('select private.assert_not_self_review(%L, %L)', c_a2, c_a1)) = 'permission-denied');
  perform pg_temp.chk('appointer cannot review the appointee', pg_temp.try(format('select private.assert_not_self_review(%L, %L)', c_a1, c_a2)) = 'permission-denied');

  -- End to end: the payment-account change proposed by a1 cannot be approved by the account a1 just appointed.
  perform pg_temp.as_user(c_a1);
  v_j := public.admin_set_payment_instructions(c_one::jsonb);
  perform pg_temp.chk('with two admins a change waits for approval', v_j->>'status' = 'pending', v_j::text);
  perform pg_temp.chk('fresh appointee cannot approve the appointer''s change', pg_temp.call_as(c_a2, $q$select public.admin_review_payment_instructions('{"decision":"approve"}')$q$) = 'permission-denied');
  perform pg_temp.as_pg();
  perform pg_temp.chk('the refused approval changed nothing', not exists (select 1 from private.app_settings where key = 'payment_instructions' and value::text like '%FIRST 0001%'));

  -- An admin who was not appointed by the proposer is independent and may approve.
  insert into private.user_roles (user_id, role) values (c_a3, 'admin');
  perform pg_temp.chk('independent admin approves', pg_temp.call_as(c_a3, $q$select public.admin_review_payment_instructions('{"decision":"approve"}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('approved change is live', exists (select 1 from private.app_settings where key = 'payment_instructions' and value::text like '%FIRST 0001%'));

  -- After 7 days the appointee counts as independent.
  update private.user_roles set granted_at = now() - interval '8 days' where user_id = c_a2;
  perform pg_temp.chk('independent after the waiting period', pg_temp.try(format('select private.assert_not_self_review(%L, %L)', c_a2, c_a1)) = 'OK');
  perform pg_temp.as_user(c_a1);
  v_j := public.admin_set_payment_instructions(c_two::jsonb);
  perform pg_temp.chk('second change waits for approval', v_j->>'status' = 'pending', v_j::text);
  perform pg_temp.chk('appointee approves after the waiting period', pg_temp.call_as(c_a2, $q$select public.admin_review_payment_instructions('{"decision":"approve"}')$q$) = 'OK');

  -- Non-reviewing roles never create a waiting period.
  perform pg_temp.chk('admin makes the investor a farmer', pg_temp.call_as(c_a1, format($q$select public.admin_set_user_role('{"userId":"%s","role":"farmer"}')$q$, c_i)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('farmer appointment does not block reviews', pg_temp.try(format('select private.assert_not_self_review(%L, %L)', c_a1, c_i)) = 'OK');

  -- API roles cannot call the rule or edit grants directly.
  perform pg_temp.chk('investor cannot rewrite a grant date', pg_temp.call_as(c_i, $q$update private.user_roles set granted_at = now() - interval '30 days'$q$) <> 'OK');

  perform pg_temp.as_pg();
  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
