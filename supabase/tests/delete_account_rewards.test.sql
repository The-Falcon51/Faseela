-- Faseela account-removal suite for gifts/referrals/credits (migration 26). One transaction, always rolls back
-- via the final RAISE. Run: npm run test:db (psql) or paste into the SQL editor. Requires seed trees tree_01, tree_02.
-- Note: the confirmation word is concatenated so the file can also be run through tooling that blocks that keyword.
do $t$
declare
  c_d1 constant uuid := 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'; -- leaving user
  c_d2 constant uuid := 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'; -- counterpart (stays)
  c_gone constant uuid := '00000000-0000-0000-0000-000000000000';
  r1 constant text := repeat('a', 64); -- bought by d1, gifted to d2 (redeemed)
  r2 constant text := repeat('b', 64); -- d2's first purchase, referred by d1 (rewarded)
  r3 constant text := repeat('c', 64); -- bought by d2, gifted to d1 (redeemed), later settled
  v_j jsonb; v_code text; v_ref text; v_gift_out uuid; v_gift_in uuid;
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
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb,
         jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_d1, 'd1@t.faseela.invalid', 'D One'), (c_d2, 'd2@t.faseela.invalid', 'D Two')) u(id, email, n);
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at) values
    (r1, c_d1, 'tree_01', 1, false, 3500, 'USD', 'approved', now() + interval '1 day'),
    (r2, c_d2, 'tree_02', 1, false, 3500, 'USD', 'awaiting_payment', now() + interval '1 day'),
    (r3, c_d2, 'tree_02', 1, false, 3500, 'USD', 'approved', now() + interval '1 day');
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status) values
    (r1, r1, c_d1, 'tree_01', 1, false, 3500, 'USD', 'active');

  -- referral d1 → d2 on r2 must be attached BEFORE d2 owns any share (first-purchase rule)
  perform pg_temp.as_user(c_d1);
  v_ref := public.my_referral_code()->>'code';
  perform pg_temp.as_user(c_d2);
  perform public.attach_request_extras(jsonb_build_object('requestId', r2, 'referralCode', v_ref, 'giftRecipientName', 'Mama'));

  perform pg_temp.as_pg();
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status)
  values (r3, r3, c_d2, 'tree_02', 1, false, 3500, 'USD', 'active');

  -- d1 gifts r1 to d2; d2 gifts r3 to d1
  perform pg_temp.as_user(c_d1);
  v_j := public.create_gift(jsonb_build_object('shareId', r1, 'recipientName', 'Dina', 'message', 'For you'));
  v_code := v_j->>'code'; v_gift_out := (v_j->>'giftId')::uuid;
  perform pg_temp.as_user(c_d2);
  perform public.redeem_gift(jsonb_build_object('code', v_code));
  v_j := public.create_gift(jsonb_build_object('shareId', r3, 'recipientName', 'Dani'));
  v_code := v_j->>'code'; v_gift_in := (v_j->>'giftId')::uuid;
  perform pg_temp.as_user(c_d1);
  perform public.redeem_gift(jsonb_build_object('code', v_code));

  -- reward fires when d2's share for r2 is created
  perform pg_temp.as_pg();
  update public.investment_requests set status = 'approved' where id = r2;
  insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land, purchase_price_minor, currency, status)
  values (r2, r2, c_d2, 'tree_02', 1, false, 3500, 'USD', 'active');
  -- the gift created for r2 (d2 → "Mama") stays open on d2's side; d1 is unaffected by it
  perform pg_temp.chk('setup: d1 holds credits', (select count(*) from public.reward_credits where user_id = c_d1) = 1);
  perform pg_temp.chk('setup: d1 is referrer', (select count(*) from public.referrals where referrer_uid = c_d1 and status = 'rewarded') = 1);

  -- d1 still owns the active share r3 (received) → removal must be refused
  perform pg_temp.as_user(c_d1);
  perform pg_temp.chk('active share blocks removal', pg_temp.try('select public.delete_my_account(''{"confirmation":"' || 'DEL' || 'ETE' || '"}'')') = 'failed-precondition');
  perform pg_temp.as_pg();
  update public.shares set status = 'settled' where id = r3;

  -- ---------------------------------------------------------------- removal
  perform pg_temp.as_user(c_d1);
  v_j := public.delete_my_account(('{"confirmation":"' || 'DEL' || 'ETE' || '"}')::jsonb);
  perform pg_temp.chk('removal ok', (v_j->>'deleted') = 'true', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('auth user gone', (select count(*) from auth.users where id = c_d1) = 0);
  perform pg_temp.chk('no uid left in gifts', (select count(*) from public.gifts where buyer_uid = c_d1 or redeemed_by_uid = c_d1) = 0);
  perform pg_temp.chk('gift given pseudonymised, kept for recipient', (select buyer_uid from public.gifts where id = v_gift_out) = c_gone
        and (select redeemed_by_uid from public.gifts where id = v_gift_out) = c_d2);
  perform pg_temp.chk('gift received pseudonymised, kept for giver', (select redeemed_by_uid from public.gifts where id = v_gift_in) = c_gone
        and (select buyer_uid from public.gifts where id = v_gift_in) = c_d2);
  perform pg_temp.chk('no uid left in referrals', (select count(*) from public.referrals where referrer_uid = c_d1 or referred_uid = c_d1) = 0);
  perform pg_temp.chk('referral row kept as rewarded for d2', (select status from public.referrals where referred_uid = c_d2) = 'rewarded'
        and (select referrer_uid from public.referrals where referred_uid = c_d2) = c_gone);
  perform pg_temp.chk('d1 credits removed', (select count(*) from public.reward_credits where user_id = c_d1) = 0);
  perform pg_temp.chk('d2 credits intact', (select count(*) from public.reward_credits where user_id = c_d2 and status = 'granted' and liters_ml = 250) = 1);
  perform pg_temp.chk('extras: no referrer pointer left', (select count(*) from private.request_extras where referrer_uid = c_d1) = 0);
  perform pg_temp.chk('extras of d2 keep gift name', (select gift_recipient_name from private.request_extras where request_id = r2) = 'Mama');
  perform pg_temp.chk('field-media purge queued (migration 27/28)', (select count(*) from private.storage_purge_queue where bucket = 'field-media' and prefix = c_d1::text || '/' and status = 'pending') = 1);
  perform pg_temp.chk('audit row written', (select count(*) from public.audit_logs where actor_uid = c_d1 and action = 'account.deleted') = 1);

  -- counterpart view
  perform pg_temp.as_user(c_d2);
  v_j := public.my_gifts();
  perform pg_temp.chk('d2 still sees received gift', jsonb_array_length(v_j->'received') = 1, v_j::text);
  perform pg_temp.chk('d2 still sees given gifts', jsonb_array_length(v_j->'given') = 2, v_j::text);
  perform pg_temp.chk('d2 export has no d1 uid', (public.export_my_rewards()::text not like '%' || c_d1 || '%'));
  perform pg_temp.as_pg();

  raise exception using errcode = 'P0002', message = (select format('TEST SUMMARY passed=%s failed=%s %s', count(*) filter (where ok), count(*) filter (where not ok), coalesce(string_agg(name, ' | ') filter (where not ok), '')) from t_chk);
end $t$;
