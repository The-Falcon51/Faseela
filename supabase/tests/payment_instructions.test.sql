-- Faseela payment-instructions + rate-limit suite (migrations 29-31). One transaction, always rolls back via the final RAISE.
-- Run: npm run test:db (psql) or paste into the SQL editor.
-- Real admin accounts are suspended INSIDE this transaction only (rolled back) so the admin count is deterministic.
do $t$
declare
  c_a1 constant uuid := 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'; -- admin 1
  c_a2 constant uuid := 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3'; -- admin 2
  c_i constant uuid := 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';  -- investor
  v_j jsonb; i int; v_t text;
  c_one constant text := '{"channels":[{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"SY00 FIRST 0001"}]}';
  c_two constant text := '{"channels":[{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"SY00 SECOND 0002"}],"noteEn":"Keep the receipt"}';
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.as_anon() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','{"role":"anon"}',true); perform set_config('role','anon',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;

  -- ---------------------------------------------------------------- setup
  update auth.users set banned_until = now() + interval '1 hour'
   where id in (select user_id from private.user_roles where role = 'admin');
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a1, 'pa1@t.faseela.invalid', 'Admin One'), (c_a2, 'pa2@t.faseela.invalid', 'Admin Two'), (c_i, 'pi@t.faseela.invalid', 'Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a1, 'admin'), (c_a2, 'admin');
  update auth.users set banned_until = now() + interval '1 hour' where id = c_a2; -- single-admin phase

  -- ---------------------------------------------------------------- single admin: applies at once, everyone is told
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot set', pg_temp.try(format('select public.admin_set_payment_instructions(%L)', c_one)) = 'permission-denied');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot read admin state', pg_temp.try('select public.admin_payment_state()') = 'permission-denied');
  perform pg_temp.as_user(c_a1);
  perform pg_temp.chk('empty channels rejected', pg_temp.try('select public.admin_set_payment_instructions(''{"channels":[]}'')') = 'invalid-argument');
  perform pg_temp.as_user(c_a1);
  perform pg_temp.chk('html in account rejected', pg_temp.try('select public.admin_set_payment_instructions(''{"channels":[{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"<b>1</b>"}]}'')') = 'invalid-argument');
  perform pg_temp.as_user(c_a1);
  v_j := public.admin_set_payment_instructions(c_one::jsonb);
  perform pg_temp.chk('single admin: applied immediately', (v_j->>'status') = 'applied', v_j::text);
  v_j := public.admin_payment_state();
  perform pg_temp.chk('state: live set, no pending, four-eyes off', (v_j->'live'->'channels'->0->>'account') = 'SY00 FIRST 0001' and (v_j->'pending') = 'null'::jsonb and (v_j->>'fourEyes') = 'false' and (v_j->>'adminCount') = '1', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('change notification queued', (select count(*) from private.email_outbox where template = 'payment_accounts_changed' and recipient = 'pa1@t.faseela.invalid') = 1);
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor reads live accounts', (public.payment_instructions()->'channels'->0->>'account') = 'SY00 FIRST 0001');

  -- ---------------------------------------------------------------- two admins: proposal needs a different approver
  perform pg_temp.as_pg();
  update auth.users set banned_until = null where id = c_a2;
  perform pg_temp.as_user(c_a1);
  v_j := public.admin_set_payment_instructions(c_two::jsonb);
  perform pg_temp.chk('two admins: only proposed', (v_j->>'status') = 'pending', v_j::text);
  v_j := public.admin_payment_state();
  perform pg_temp.chk('proposer sees own proposal', (v_j->'pending'->>'proposedBySelf') = 'true' and (v_j->'pending'->'channels'->0->>'account') = 'SY00 SECOND 0002' and (v_j->>'fourEyes') = 'true', v_j::text);
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('live value unchanged while pending', (public.payment_instructions()->'channels'->0->>'account') = 'SY00 FIRST 0001');
  perform pg_temp.as_user(c_a1);
  perform pg_temp.chk('proposer cannot approve own change', pg_temp.try('select public.admin_review_payment_instructions(''{"decision":"approve"}'')') = 'permission-denied');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot review', pg_temp.try('select public.admin_review_payment_instructions(''{"decision":"approve"}'')') = 'permission-denied');
  perform pg_temp.as_user(c_a2);
  perform pg_temp.chk('bad decision rejected', pg_temp.try('select public.admin_review_payment_instructions(''{"decision":"maybe"}'')') = 'invalid-argument');
  perform pg_temp.as_user(c_a2);
  perform pg_temp.chk('second admin sees foreign proposal', (public.admin_payment_state()->'pending'->>'proposedBySelf') = 'false');
  v_j := public.admin_review_payment_instructions('{"decision":"approve"}'::jsonb);
  perform pg_temp.chk('second admin approves', (v_j->>'status') = 'applied', v_j::text);
  perform pg_temp.chk('proposal cleared', (public.admin_payment_state()->'pending') = 'null'::jsonb);
  perform pg_temp.chk('no second approval', pg_temp.try('select public.admin_review_payment_instructions(''{"decision":"approve"}'')') = 'not-found');
  perform pg_temp.as_user(c_i);
  v_j := public.payment_instructions();
  perform pg_temp.chk('investor sees approved accounts', (v_j->'channels'->0->>'account') = 'SY00 SECOND 0002' and (v_j->>'noteEn') = 'Keep the receipt', v_j::text);
  perform pg_temp.as_user(c_a2);
  perform public.admin_set_payment_instructions(c_one::jsonb);
  v_j := public.admin_review_payment_instructions('{"decision":"reject"}'::jsonb);
  perform pg_temp.chk('proposer may withdraw', (v_j->>'status') = 'rejected', v_j::text);
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('withdrawn proposal never went live', (public.payment_instructions()->'channels'->0->>'account') = 'SY00 SECOND 0002');
  perform pg_temp.as_pg();
  perform pg_temp.chk('audit trail complete', (select count(*) from public.audit_logs where action like 'settings.payment_instructions%' and actor_uid in (c_a1, c_a2)) = 5,
    (select string_agg(action, ',') from public.audit_logs where action like 'settings.payment_instructions%' and actor_uid in (c_a1, c_a2)));
  perform pg_temp.chk('four-eyes flag audited', (select count(*) from public.audit_logs where action = 'settings.payment_instructions' and (details->>'fourEyes') = 'true') = 1);
  perform pg_temp.chk('pending notifications queued', (select count(*) from private.email_outbox where template = 'payment_change_pending') >= 2);
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot read settings table', pg_temp.try('select count(*) from private.app_settings') <> 'OK');

  -- ---------------------------------------------------------------- rate limits
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon blocked from payment instructions', pg_temp.try('select public.payment_instructions()') <> 'OK');
  perform pg_temp.as_anon();
  for i in 1..20 loop perform public.verify_certificate('{"serial":"x"}'::jsonb); end loop;
  perform pg_temp.chk('verify_certificate: 21st anonymous call limited', pg_temp.try('select public.verify_certificate(''{"serial":"x"}'')') = 'resource-exhausted');
  perform pg_temp.as_anon();
  perform pg_temp.chk('limit is per bucket', pg_temp.try('select public.public_status()') = 'OK');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('limit is per subject (signed-in user unaffected)', pg_temp.try('select public.verify_certificate(''{"serial":"x"}'')') = 'OK');
  perform pg_temp.as_user(c_i);
  for i in 1..5 loop perform public.export_my_rewards(); end loop;
  perform pg_temp.chk('export: 6th call in 10 min limited', pg_temp.try('select public.export_my_rewards()') = 'resource-exhausted');
  perform pg_temp.as_pg();
  perform pg_temp.chk('no clear-text subject stored', (select count(*) from private.rate_limits where subject !~ '^(u:[0-9a-f-]{36}|ip:[0-9a-f]{64})$') = 0);
  update private.rate_limits set window_start = now() - interval '2 minutes' where bucket = 'verify_certificate';
  perform pg_temp.as_anon();
  perform pg_temp.chk('window expiry resets the counter', pg_temp.try('select public.verify_certificate(''{"serial":"x"}'')') = 'OK');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('limiter table hidden', pg_temp.try('select count(*) from private.rate_limits') <> 'OK');
  perform pg_temp.as_pg();
  raise exception using errcode = 'P0002', message = (select format('TEST SUMMARY passed=%s failed=%s %s', count(*) filter (where ok), count(*) filter (where not ok), coalesce(string_agg(name, ' | ') filter (where not ok), '')) from t_chk);
end $t$;
