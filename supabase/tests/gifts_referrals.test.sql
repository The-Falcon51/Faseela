-- Faseela gifts + referrals suite (55 checks). Runs as one transaction that ALWAYS rolls back via the final RAISE.
-- Run: npm run test:db (psql) or paste into the SQL editor. Requires seed trees tree_01, tree_02. [GETESTET 2026-11-09: 55/55]
do $t$
declare
  c_g1 constant uuid := 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'; -- buyer / referrer
  c_g2 constant uuid := 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'; -- recipient
  c_g3 constant uuid := 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3'; -- referred, first purchase
  c_g4 constant uuid := 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4'; -- unverified
  c_g5 constant uuid := 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5'; -- referred, rejected later
  r1 constant text := repeat('1', 64); -- g1 share (approved)
  r2 constant text := repeat('2', 64); -- g3 open request
  r3 constant text := repeat('3', 64); -- g1 open request (self-referral test)
  r4 constant text := repeat('4', 64); -- g1 second share (cancel test)
  r5 constant text := repeat('5', 64); -- g5 open request (void test)
  r6 constant text := repeat('6', 64); -- g2 open request (gift via extras)
    v_code text; v_ref text; v_ref2 text; v_j jsonb; v_t text; v_hint text; v_msg text;
  v_batch uuid; v_alloc uuid; v_gift uuid; v_oil uuid; i int;

begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated; -- checks must NOT change the acting role (RLS assertions depend on it)
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin
    insert into t_chk values (p_name || case when coalesce(p_cond, false) then '' else coalesce(' got=' || left(p_got, 300), '') end, coalesce(p_cond, false));
  end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text;
  begin
    begin
      execute p_sql;
      return 'OK';
    exception when others then
      get stacked diagnostics h = pg_exception_hint;
      perform set_config('role', 'none', true);
      return coalesce(nullif(h, ''), 'ERR');
    end;
  end $f$;
  -- ---------------------------------------------------------------- setup
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '',
         case when u.v then now() end, '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_g1, 'g1@t.faseela.invalid', 'G One', true), (c_g2, 'g2@t.faseela.invalid', 'G Two', true),
               (c_g3, 'g3@t.faseela.invalid', 'G Three', true), (c_g4, 'g4@t.faseela.invalid', 'G Four', false),
               (c_g5, 'g5@t.faseela.invalid', 'G Five', true)) u(id, email, n, v);
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at) values
    (r1, c_g1, 'tree_01', 1, false, 3500, 'USD', 'approved', now() + interval '1 day'),
    (r2, c_g3, 'tree_02', 1, false, 3500, 'USD', 'awaiting_payment', now() + interval '1 day'),
    (r3, c_g1, 'tree_02', 1, false, 3500, 'USD', 'awaiting_payment', now() + interval '1 day'),
    (r4, c_g1, 'tree_02', 1, false, 3500, 'USD', 'approved', now() + interval '1 day'),
    (r5, c_g5, 'tree_02', 1, false, 3500, 'USD', 'awaiting_payment', now() + interval '1 day'),
    (r6, c_g2, 'tree_02', 1, false, 3500, 'USD', 'awaiting_payment', now() + interval '1 day');
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status) values
    (r1, r1, c_g1, 'tree_01', 1, false, 3500, 'USD', 'active'),
    (r4, r4, c_g1, 'tree_02', 1, false, 3500, 'USD', 'active');
  insert into public.pressing_batches (submitted_by_uid, tree_id, mill_id, olives_weight_kg, oil_yield_liters, temperature_celsius, acidity_pct, peroxide_value, season_year, status, certificate_serial)
  values (c_g1, 'tree_01', 'mill_01', 100, 18, 24, 0.4, 8, 2026, 'certified', 'LAB-T-1') returning id into v_batch;
  insert into public.oil_allocations (batch_id, tree_id, user_id, share_id, share_count, liters_ml, season_year, status)
  values (v_batch, 'tree_01', c_g1, r1, 1, 500, 2026, 'available') returning id into v_alloc;
  perform pg_temp.chk('setup: no reward hooks fired on direct share insert without extras', (select count(*) from public.gifts) = 0);

  -- ---------------------------------------------------------------- referral code
  perform pg_temp.as_user(c_g1);
  v_j := public.my_referral_code(); v_ref := v_j->>'code';
  perform pg_temp.chk('referral code format', v_ref ~ '^[A-Z2-9]{8}$', v_ref);
  perform pg_temp.chk('referral code stable', (public.my_referral_code()->>'code') = v_ref);
  perform pg_temp.chk('referral stats zero', (v_j->>'rewarded') = '0' and (v_j->>'creditsMl') = '0');

  -- attach rules
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('attach bad format', pg_temp.try(format('select public.attach_request_extras(%L)', jsonb_build_object('requestId', r2, 'referralCode', 'abc'))) = 'invalid-argument');
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('attach unknown code', pg_temp.try(format('select public.attach_request_extras(%L)', jsonb_build_object('requestId', r2, 'referralCode', 'ZZZZZZZZ'))) = 'not-found');
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('attach foreign request', pg_temp.try(format('select public.attach_request_extras(%L)', jsonb_build_object('requestId', r3, 'referralCode', v_ref))) = 'not-found');
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('self referral blocked', pg_temp.try(format('select public.attach_request_extras(%L)', jsonb_build_object('requestId', r3, 'referralCode', v_ref))) = 'invalid-argument');
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('closed request blocked', pg_temp.try(format('select public.attach_request_extras(%L)', jsonb_build_object('requestId', r1, 'giftRecipientName', 'X'))) = 'failed-precondition');
  perform pg_temp.as_user(c_g3);
  v_j := public.attach_request_extras(jsonb_build_object('requestId', r2, 'referralCode', v_ref));
  perform pg_temp.chk('attach referral ok', (v_j->>'referral') = 'true', v_j::text);
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('second referral blocked', pg_temp.try(format('select public.attach_request_extras(%L)', jsonb_build_object('requestId', r2, 'referralCode', v_ref))) = 'failed-precondition');
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('referrer sees pending', (public.my_referral_code()->>'pending') = '1');
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('referred sees referral row (RLS)', (select count(*) from public.referrals) = 1);
  perform pg_temp.as_user(c_g2);
  perform pg_temp.chk('stranger sees no referral (RLS)', (select count(*) from public.referrals) = 0);
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('request_extras hidden from clients', pg_temp.try('select count(*) from private.request_extras') <> 'OK');

  -- ---------------------------------------------------------------- gifts: create
  perform pg_temp.as_user(c_g2);
  perform pg_temp.chk('cannot gift foreign share', pg_temp.try(format('select public.create_gift(%L)', jsonb_build_object('shareId', r1))) = 'failed-precondition');
  perform pg_temp.as_user(c_g4);
  perform pg_temp.chk('unverified cannot gift', pg_temp.try(format('select public.create_gift(%L)', jsonb_build_object('shareId', r1))) = 'failed-precondition');
  perform pg_temp.as_user(c_g1);
  v_j := public.create_gift(jsonb_build_object('shareId', r1, 'recipientName', 'Layla', 'message', 'Happy birthday'));
  v_code := v_j->>'code'; v_gift := (v_j->>'giftId')::uuid;
  perform pg_temp.chk('gift code format', v_code ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$', v_code);
  perform pg_temp.chk('gift expires ~12 months', (v_j->>'expiresAt')::bigint > (extract(epoch from now() + interval '11 months') * 1000)::bigint);
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('one open gift per share', pg_temp.try(format('select public.create_gift(%L)', jsonb_build_object('shareId', r1))) = 'already-exists');
  perform pg_temp.as_user(c_g1);
  v_j := public.my_gifts();
  perform pg_temp.chk('my_gifts given=1', jsonb_array_length(v_j->'given') = 1 and (v_j->'given'->0->>'codeHint') = right(replace(v_code, '-', ''), 4), v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('code never stored in plaintext', (select count(*) from public.gifts where code_hash = v_code or message like '%' || v_code || '%') = 0);
  perform pg_temp.chk('notification carries code once', (select count(*) from private.email_outbox where recipient = 'g1@t.faseela.invalid' and template = 'gift_created' and params->>'code' = v_code) = 1);

  -- ---------------------------------------------------------------- gifts: redeem
  perform pg_temp.as_user(c_g4);
  perform pg_temp.chk('unverified cannot redeem', pg_temp.try(format('select public.redeem_gift(%L)', jsonb_build_object('code', v_code))) = 'failed-precondition');
  perform pg_temp.as_user(c_g2);
  perform pg_temp.chk('bad format rejected', pg_temp.try(format('select public.redeem_gift(%L)', jsonb_build_object('code', 'abc'))) = 'invalid-argument');
  perform pg_temp.as_user(c_g2);
  v_j := public.redeem_gift(jsonb_build_object('code', 'AAAA-AAAA-AAAA'));
  perform pg_temp.chk('unknown code -> status invalid (no exception)', (v_j->>'status') = 'invalid', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('failed attempt audited', (select count(*) from public.audit_logs where actor_uid = c_g2 and action = 'gift.redeem_failed') = 1);
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('self redeem blocked', pg_temp.try(format('select public.redeem_gift(%L)', jsonb_build_object('code', v_code))) = 'invalid-argument');
  perform pg_temp.as_user(c_g2);
  v_j := public.redeem_gift(jsonb_build_object('code', lower(replace(v_code, '-', ' '))));
  perform pg_temp.chk('redeem ok (normalised input)', (v_j->>'status') = 'redeemed' and (v_j->>'treeId') = 'tree_01' and (v_j->>'message') = 'Happy birthday', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('share transferred to recipient', (select user_id from public.shares where id = r1) = c_g2);
  perform pg_temp.chk('gift marked redeemed', (select status from public.gifts where id = v_gift) = 'redeemed');
  perform pg_temp.chk('both parties notified', (select count(*) from private.email_outbox where template in ('gift_redeemed', 'gift_received')) = 2);
  perform pg_temp.as_user(c_g2);
  perform pg_temp.chk('replay -> invalid', (public.redeem_gift(jsonb_build_object('code', v_code))->>'status') = 'invalid');
  perform pg_temp.chk('recipient sees gift (RLS)', (select count(*) from public.gifts) = 1 and jsonb_array_length(public.my_gifts()->'received') = 1);
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('stranger sees no gift (RLS)', (select count(*) from public.gifts) = 0);
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('cannot cancel redeemed gift', pg_temp.try(format('select public.cancel_gift(%L)', jsonb_build_object('giftId', v_gift))) = 'failed-precondition');
  perform pg_temp.as_user(c_g1);
  perform pg_temp.chk('former owner cannot re-gift transferred share', pg_temp.try(format('select public.create_gift(%L)', jsonb_build_object('shareId', r1))) = 'failed-precondition');

  -- cancel path
  perform pg_temp.as_user(c_g1);
  v_j := public.create_gift(jsonb_build_object('shareId', r4));
  v_gift := (v_j->>'giftId')::uuid; v_t := v_j->>'code';
  perform pg_temp.chk('cancel ok', (public.cancel_gift(jsonb_build_object('giftId', v_gift))->>'status') = 'cancelled');
  perform pg_temp.as_user(c_g2);
  perform pg_temp.chk('cancelled code -> invalid', (public.redeem_gift(jsonb_build_object('code', v_t))->>'status') = 'invalid');
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('cannot cancel foreign gift', pg_temp.try(format('select public.cancel_gift(%L)', jsonb_build_object('giftId', v_gift))) = 'not-found');

  -- attempt cap: g3 already has 0 failures; burn 10
  perform pg_temp.as_user(c_g3);
  for i in 1..10 loop perform public.redeem_gift(jsonb_build_object('code', 'BBBB-BBBB-BBB' || substr('23456789AB', i, 1))); end loop;
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('11th attempt rate-limited', pg_temp.try(format('select public.redeem_gift(%L)', jsonb_build_object('code', 'CCCC-CCCC-CCCC'))) = 'resource-exhausted');

  -- ---------------------------------------------------------------- referral reward on share creation
  perform pg_temp.as_pg();
  update public.investment_requests set status = 'approved' where id = r2;
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status)
  values (r2, r2, c_g3, 'tree_02', 1, false, 3500, 'USD', 'active');
  perform pg_temp.chk('referral rewarded', (select status from public.referrals where referred_uid = c_g3) = 'rewarded');
  perform pg_temp.chk('250 ml each side', (select count(*) from public.reward_credits where liters_ml = 250 and status = 'granted' and user_id in (c_g1, c_g3)) = 2);
  perform pg_temp.chk('reward notifications', (select count(*) from private.email_outbox where template = 'referral_rewarded') = 2);
  perform pg_temp.as_user(c_g1);
  v_j := public.my_referral_code();
  perform pg_temp.chk('referrer stats', (v_j->>'rewarded') = '1' and (v_j->>'pending') = '0' and (v_j->>'creditsMl') = '250', v_j::text);
  perform pg_temp.as_user(c_g3);
  perform pg_temp.chk('referred sees own credit only (RLS)', (select coalesce(sum(liters_ml), 0) from public.reward_credits) = 250);

  -- void on reject
  perform pg_temp.as_user(c_g5);
  perform public.attach_request_extras(jsonb_build_object('requestId', r5, 'referralCode', v_ref));
  perform pg_temp.as_pg();
  update public.investment_requests set status = 'rejected' where id = r5;
  perform pg_temp.chk('referral void on reject', (select status from public.referrals where referred_uid = c_g5) = 'void');
  perform pg_temp.chk('no credit for void', (select count(*) from public.reward_credits where user_id = c_g5) = 0);

  -- gift via checkout extras
  perform pg_temp.as_user(c_g2);
  v_j := public.attach_request_extras(jsonb_build_object('requestId', r6, 'giftRecipientName', 'Mama', 'giftMessage', 'Love'));
  perform pg_temp.chk('attach gift ok', (v_j->>'gift') = 'true');
  perform pg_temp.as_pg();
  update public.investment_requests set status = 'approved' where id = r6;
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status)
  values (r6, r6, c_g2, 'tree_02', 1, false, 3500, 'USD', 'active');
  perform pg_temp.chk('gift auto-created on approval', (select count(*) from public.gifts where share_id = r6 and buyer_uid = c_g2 and status = 'open' and recipient_name = 'Mama') = 1);

  -- ---------------------------------------------------------------- oil credit merge
  perform pg_temp.as_user(c_g1);
  v_j := public.request_oil(jsonb_build_object('kind', 'donate', 'allocationIds', jsonb_build_array(v_alloc)));
  v_oil := (v_j->>'requestId')::uuid;
  perform pg_temp.chk('credit merged into oil request', (v_j->>'litersMl') = '750' and (v_j->>'creditMl') = '250', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('credit marked redeemed', (select status from public.reward_credits where user_id = c_g1) = 'redeemed'
        and (select oil_request_id from public.reward_credits where user_id = c_g1) = v_oil);
  perform pg_temp.as_user(c_g1);
  perform public.cancel_oil_request(jsonb_build_object('requestId', v_oil));
  perform pg_temp.as_pg();
  perform pg_temp.chk('credit restored on cancel', (select status from public.reward_credits where user_id = c_g1) = 'granted'
        and (select oil_request_id from public.reward_credits where user_id = c_g1) is null);

  -- export
  perform pg_temp.as_user(c_g1);
  v_j := public.export_my_rewards();
  perform pg_temp.chk('export rewards', (v_j->>'referralCode') = v_ref and jsonb_array_length(v_j->'referrals') = 2 and jsonb_array_length(v_j->'rewardCredits') = 1
        and (v_j::text not like '%' || c_g3 || '%'), v_j::text);

  -- anon
  perform pg_temp.as_pg();
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('role', 'anon', true);
  v_t := pg_temp.try('select public.my_gifts()');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('role', 'anon', true);
  perform pg_temp.chk('anon cannot call gift RPCs', v_t <> 'OK' and pg_temp.try('select public.redeem_gift(''{"code":"AAAA-AAAA-AAAA"}'')') <> 'OK');
  perform pg_temp.as_pg();

  raise exception using errcode = 'P0002', message = (select format('TEST SUMMARY passed=%s failed=%s %s', count(*) filter (where ok), count(*) filter (where not ok), coalesce(string_agg(name, ' | ') filter (where not ok), '')) from t_chk);
end $t$;
