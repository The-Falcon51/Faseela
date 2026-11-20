-- Faseela push-notification suite (migration 33). One transaction, always rolls back via the final RAISE.
-- Run: npm run test:db (psql) or paste into the SQL editor.
do $t$
declare
  c_a constant uuid := 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'; -- investor with a device
  c_b constant uuid := 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'; -- investor without a device
  c_x constant uuid := 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3'; -- banned account
  t_a constant text := 'tokenA_' || repeat('a', 40);
  t_a2 constant text := 'tokenA2:' || repeat('b', 40);
  t_x constant text := 'tokenX-' || repeat('c', 40);
  v_j jsonb;
  v_n integer;
  v_id bigint;
  i integer;
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

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, banned_until)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now(), u.banned
  from (values (c_a, 'pa@t.faseela.invalid', 'Push A', null::timestamptz), (c_b, 'pb@t.faseela.invalid', 'Push B', null),
               (c_x, 'px@t.faseela.invalid', 'Push X', now() + interval '10 years')) u(id, email, n, banned);

  -- ---------------------------------------------------------------- structure
  perform pg_temp.chk('tables are row-level secured', (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname in ('push_tokens', 'push_outbox')));
  perform pg_temp.chk('account removal clears both tables (cascading keys)', (select count(*) from pg_constraint where contype = 'f' and confdeltype = 'c' and conrelid in ('private.push_tokens'::regclass, 'private.push_outbox'::regclass)) = 2);
  perform pg_temp.chk('sender cron is scheduled', exists (select 1 from cron.job where jobname = 'faseela-send-push' and active));
  perform pg_temp.chk('definer functions pin search_path', (select bool_and(p.proconfig::text like '%search_path=%') from pg_proc p where p.proname in ('register_push_token','unregister_push_token','push_state','push_claim','push_mark','enqueue_push','retire_push_token','notify_user','push_token_arg') and p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)));

  -- ---------------------------------------------------------------- registration
  -- ---------------------------------------------------------------- server switch (migration 35)
  update private.app_settings set value = 'false'::jsonb where key = 'push_enabled';
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('registration refused while push is switched off', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', t_a, 'platform', 'android'))) = 'failed-precondition');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('state reports the switch as off', (public.push_state()->>'enabled') = 'false');
  perform pg_temp.chk('client cannot flip the switch', pg_temp.try($q$insert into private.app_settings (key, value) values ('push_enabled', 'true'::jsonb)$q$) <> 'OK');
  perform pg_temp.as_pg();
  insert into private.app_settings (key, value) values ('push_enabled', 'true'::jsonb) on conflict (key) do update set value = excluded.value;
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('state reports the switch as on', (public.push_state()->>'enabled') = 'true');

  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot register', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', t_a, 'platform', 'android'))) <> 'OK');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('short token rejected', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', 'short', 'platform', 'android'))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('oversized token rejected', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', repeat('a', 4097), 'platform', 'android'))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('token with markup rejected', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', '<script>' || repeat('a', 30), 'platform', 'android'))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('tombstone cannot be registered', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', 'x:' || repeat('1', 30), 'platform', 'android'))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('unknown platform rejected', pg_temp.try(format('select public.register_push_token(%L)', jsonb_build_object('token', t_a, 'platform', 'web'))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.register_push_token(jsonb_build_object('token', t_a, 'platform', 'android'));
  perform pg_temp.chk('token registered', (v_j->>'registered') = 'true' and (v_j->>'activeDevices') = '1', v_j::text);
  v_j := public.register_push_token(jsonb_build_object('token', t_a, 'platform', 'android'));
  perform pg_temp.chk('re-registration is idempotent', (v_j->>'activeDevices') = '1', v_j::text);
  v_j := public.push_state();
  perform pg_temp.chk('state reports one device', (v_j->>'activeDevices') = '1', v_j::text);
  perform pg_temp.chk('client cannot read the token table', pg_temp.try('select count(*) from private.push_tokens') <> 'OK');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('client cannot read the queue', pg_temp.try('select count(*) from private.push_outbox') <> 'OK');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('client cannot claim', pg_temp.try('select public.push_claim(5)') <> 'OK');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('client cannot mark', pg_temp.try($q$select public.push_mark(1, 'sent')$q$) <> 'OK');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('client cannot enqueue directly', pg_temp.try(format('select private.enqueue_push(%L, %L, %L)', c_b, 'payment_approved', '{}'::jsonb)) <> 'OK');

  -- ---------------------------------------------------------------- queueing through notify_user
  perform pg_temp.as_pg();
  perform private.notify_user(c_a, 'payment_approved', jsonb_build_object('amountMinor', 3500, 'note', 'secret note'));
  perform pg_temp.chk('push queued for a user with a device', (select count(*) from private.push_outbox where user_id = c_a and template = 'payment_approved' and status = 'pending') = 1);
  perform pg_temp.chk('e-mail still queued', (select count(*) from private.email_outbox where recipient = 'pa@t.faseela.invalid' and template = 'payment_approved') = 1);
  perform pg_temp.chk('queue row carries no message parameters', not exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'push_outbox' and column_name in ('params', 'payload', 'body')));
  perform private.notify_user(c_a, 'payment_approved', '{}'::jsonb);
  perform pg_temp.chk('burst of the same template collapses', (select count(*) from private.push_outbox where user_id = c_a and template = 'payment_approved') = 1);
  perform private.notify_user(c_a, 'onboarding_welcome', jsonb_build_object('marketing', true));
  perform pg_temp.chk('marketing mail does not push', not exists (select 1 from private.push_outbox where user_id = c_a and template = 'onboarding_welcome'));
  perform private.notify_user(c_b, 'payment_approved', '{}'::jsonb);
  perform pg_temp.chk('no push without a device', not exists (select 1 from private.push_outbox where user_id = c_b));
  insert into private.push_tokens (user_id, token, platform) values (c_x, t_x, 'android');
  perform private.notify_user(c_x, 'payment_approved', '{}'::jsonb);
  perform pg_temp.chk('banned account gets no push', not exists (select 1 from private.push_outbox where user_id = c_x));
  perform private.enqueue_push(c_a, 'Bad-Template!', '{}'::jsonb);
  perform pg_temp.chk('invalid template is ignored without error', not exists (select 1 from private.push_outbox where template = 'Bad-Template!'));
  perform private.enqueue_push('00000000-0000-4000-8000-000000000001', 'payment_approved', '{}'::jsonb);
  perform pg_temp.chk('unknown user is ignored without error', true);

  -- ---------------------------------------------------------------- sender side
  v_j := public.push_claim(10);
  perform pg_temp.chk('claim returns the row with its tokens', jsonb_array_length(v_j) = 1 and (v_j->0->>'template') = 'payment_approved' and (v_j->0->'tokens'->0->>'token') = t_a and (v_j->0->>'attempts') = '1', v_j::text);
  v_id := (v_j->0->>'id')::bigint;
  perform pg_temp.chk('claimed row is not handed out twice', jsonb_array_length(public.push_claim(10)) = 0);
  perform pg_temp.chk('unknown outcome refused', pg_temp.try(format($q$select public.push_mark(%s, 'done')$q$, v_id)) <> 'OK');
  perform public.push_mark(v_id, 'retry', 'UNAVAILABLE 503');
  perform pg_temp.chk('transient failure goes back to pending', (select status = 'pending' and last_error = 'UNAVAILABLE 503' from private.push_outbox where id = v_id));
  for i in 1..4 loop
    perform public.push_claim(10);
    perform public.push_mark(v_id, 'retry', 'UNAVAILABLE 503');
  end loop;
  perform pg_temp.chk('gives up after five attempts', (select status = 'failed' and attempts = 5 from private.push_outbox where id = v_id));

  update private.push_outbox set created_at = now() - interval '2 minutes' where id = v_id; -- outside the burst window
  perform private.notify_user(c_a, 'payment_approved', '{}'::jsonb);
  v_j := public.push_claim(10);
  v_id := (v_j->0->>'id')::bigint;
  -- Dead-token list containing a foreign token: only the recipient's own token may be retired.
  perform public.push_mark(v_id, 'skipped', 'UNREGISTERED', array[t_a, t_x]);
  perform pg_temp.chk('row marked skipped', (select status = 'skipped' from private.push_outbox where id = v_id));
  perform pg_temp.chk('dead token retired and overwritten', (select count(*) from private.push_tokens where user_id = c_a and disabled_reason = 'unregistered' and token like 'x:%') = 1 and not exists (select 1 from private.push_tokens where token = t_a));
  perform pg_temp.chk('foreign token untouched by mark', (select disabled_at is null from private.push_tokens where token = t_x));
  perform private.notify_user(c_a, 'gift_redeemed', '{}'::jsonb);
  perform pg_temp.chk('no push after the last device is gone', not exists (select 1 from private.push_outbox where user_id = c_a and template = 'gift_redeemed'));

  -- ---------------------------------------------------------------- expiry
  perform pg_temp.as_user(c_a);
  perform public.register_push_token(jsonb_build_object('token', t_a2, 'platform', 'ios'));
  perform pg_temp.as_pg();
  perform private.notify_user(c_a, 'reservation_expired', '{}'::jsonb);
  update private.push_outbox set created_at = now() - interval '25 hours' where user_id = c_a and template = 'reservation_expired';
  v_j := public.push_claim(10);
  perform pg_temp.chk('stale push expires instead of being sent', jsonb_array_length(v_j) = 0 and (select status = 'expired' from private.push_outbox where user_id = c_a and template = 'reservation_expired'), v_j::text);
  perform private.notify_user(c_a, 'proof_received', '{}'::jsonb);
  v_j := public.push_claim(10);
  perform public.push_mark((v_j->0->>'id')::bigint, 'sent');
  perform pg_temp.chk('sent row is final', (select status = 'sent' and sent_at is not null and last_error is null from private.push_outbox where user_id = c_a and template = 'proof_received'));

  -- ---------------------------------------------------------------- device changes hands, cap, sign-out
  perform pg_temp.as_user(c_b);
  v_j := public.register_push_token(jsonb_build_object('token', t_a2, 'platform', 'ios'));
  perform pg_temp.chk('token moves to the new account', (v_j->>'activeDevices') = '1', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('previous owner no longer holds it', not exists (select 1 from private.push_tokens where user_id = c_a and disabled_at is null));
  perform pg_temp.chk('move is audited without the token', exists (select 1 from public.audit_logs where action = 'push_token.reassigned' and actor_uid = c_b) and not exists (select 1 from public.audit_logs where action = 'push_token.reassigned' and details::text like '%' || t_a2 || '%'));
  perform pg_temp.as_user(c_a);
  v_j := public.unregister_push_token(jsonb_build_object('token', t_a2));
  perform pg_temp.chk('cannot switch off someone else''s device', (v_j->>'unregistered') = 'false', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('foreign device still active', (select disabled_at is null from private.push_tokens where token = t_a2));
  perform pg_temp.as_user(c_b);
  for i in 1..11 loop
    perform private.register_push_token(jsonb_build_object('token', 'capTok_' || lpad(i::text, 3, '0') || repeat('d', 30), 'platform', 'android'));
  end loop;
  v_j := public.push_state();
  perform pg_temp.chk('at most ten active devices', (v_j->>'activeDevices') = '10', v_j::text);
  v_j := public.unregister_push_token(jsonb_build_object('token', 'capTok_011' || repeat('d', 30)));
  perform pg_temp.chk('sign-out switches the device off', (v_j->>'unregistered') = 'true' and (v_j->>'activeDevices') = '9', v_j::text);
  v_j := public.unregister_push_token(jsonb_build_object('token', 'capTok_011' || repeat('d', 30)));
  perform pg_temp.chk('second sign-out is a no-op', (v_j->>'unregistered') = 'false', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('retired tokens keep no identifier', not exists (select 1 from private.push_tokens where disabled_at is not null and token not like 'x:%'));

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n,
    coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
