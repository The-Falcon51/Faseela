-- Faseela: gift purchase + referral programme (roadmap W1/W2, no payment provider involved).
--
-- Gifts: a buyer turns one of their active shares into a gift code (at checkout via request extras, or later
-- from the share card). The recipient redeems the code with their own verified account; the share row moves
-- to the recipient (future oil allocations and the certificate follow the owner). Codes are stored hashed.
-- Referrals: every user has a referral code; a first-time buyer attaches it to their reservation. When finance
-- approves that payment, both sides receive an oil credit (ml) that is merged into their next oil request.
-- Deny-by-default: every new table has RLS with owner-scoped SELECT only; all writes go through private.* RPCs.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists referral_code text unique check (referral_code ~ '^[A-Z2-9]{8}$');

create table if not exists public.gifts (
  id uuid primary key default gen_random_uuid(),
  buyer_uid uuid not null,
  share_id text not null references public.shares (id),
  code_hash text not null unique,
  code_hint text not null check (code_hint ~ '^[A-Z2-9]{4}$'),
  recipient_name text not null default '' check (char_length(recipient_name) <= 80),
  message text not null default '' check (char_length(message) <= 300),
  status text not null default 'open' check (status in ('open', 'redeemed', 'cancelled', 'expired')),
  redeemed_by_uid uuid,
  redeemed_at timestamptz,
  expires_at timestamptz not null default now() + interval '12 months',
  created_at timestamptz not null default now()
);
create unique index if not exists gifts_one_open_per_share on public.gifts (share_id) where status = 'open';
create index if not exists gifts_buyer_idx on public.gifts (buyer_uid, status);
create index if not exists gifts_redeemer_idx on public.gifts (redeemed_by_uid);
alter table public.gifts enable row level security;
revoke all on public.gifts from public, anon, authenticated;
grant select on public.gifts to authenticated;
create policy gifts_select on public.gifts for select to authenticated
  using (buyer_uid = (select auth.uid()) or redeemed_by_uid = (select auth.uid()));

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_uid uuid not null,
  referred_uid uuid not null,
  request_id text not null references public.investment_requests (id),
  status text not null default 'pending' check (status in ('pending', 'rewarded', 'void')),
  created_at timestamptz not null default now(),
  rewarded_at timestamptz
);
create index if not exists referrals_referrer_idx on public.referrals (referrer_uid, status);
-- One live referral per referred user; a voided row does not block the next attempt.
create unique index if not exists referrals_referred_live on public.referrals (referred_uid) where status in ('pending', 'rewarded');
alter table public.referrals enable row level security;
revoke all on public.referrals from public, anon, authenticated;
grant select on public.referrals to authenticated;
create policy referrals_select on public.referrals for select to authenticated
  using (referrer_uid = (select auth.uid()) or referred_uid = (select auth.uid()));

create table if not exists public.reward_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('referral_referrer', 'referral_referred')),
  liters_ml integer not null check (liters_ml > 0),
  status text not null default 'granted' check (status in ('granted', 'redeemed')),
  referral_id uuid references public.referrals (id),
  oil_request_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists reward_credits_user_status_idx on public.reward_credits (user_id, status);
alter table public.reward_credits enable row level security;
revoke all on public.reward_credits from public, anon, authenticated;
grant select on public.reward_credits to authenticated;
create policy reward_credits_select on public.reward_credits for select to authenticated
  using (user_id = (select auth.uid()));

-- Checkout intent captured right after the reservation; consumed by the approval trigger.
create table if not exists private.request_extras (
  request_id text primary key references public.investment_requests (id),
  gift_recipient_name text check (char_length(gift_recipient_name) <= 80),
  gift_message text check (char_length(gift_message) <= 300),
  referrer_uid uuid,
  created_at timestamptz not null default now()
);
revoke all on private.request_extras from public, anon, authenticated;

alter publication supabase_realtime add table public.gifts, public.reward_credits;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Unambiguous alphabet (no 0/O/1/I); 32 symbols → 5 bits per char.
create or replace function private.random_code(p_len integer)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(p_len);
  v_out text := '';
  i integer;
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(c_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_out;
end;
$$;

create or replace function private.gift_code_hash(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex'); $$;

-- ---------------------------------------------------------------------------
-- Referral code of the signed-in user (created on first call)
-- ---------------------------------------------------------------------------
create or replace function private.my_referral_code()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_code text;
  v_try integer := 0;
begin
  select referral_code into v_code from public.profiles where id = v_uid;
  while v_code is null and v_try < 5 loop
    v_try := v_try + 1;
    begin
      update public.profiles set referral_code = private.random_code(8), updated_at = now()
       where id = v_uid and referral_code is null
       returning referral_code into v_code;
    exception when unique_violation then
      v_code := null;
    end;
  end loop;
  if v_code is null then
    perform private.fail('internal', 'Referral code could not be created.');
  end if;
  return jsonb_build_object(
    'code', v_code,
    'rewarded', (select count(*) from public.referrals where referrer_uid = v_uid and status = 'rewarded'),
    'pending', (select count(*) from public.referrals where referrer_uid = v_uid and status = 'pending'),
    'creditsMl', (select coalesce(sum(liters_ml), 0) from public.reward_credits where user_id = v_uid and status = 'granted'),
    'creditsRedeemedMl', (select coalesce(sum(liters_ml), 0) from public.reward_credits where user_id = v_uid and status = 'redeemed'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Checkout extras: gift intent and/or referral code for a reservation the caller just made
-- ---------------------------------------------------------------------------
create or replace function private.attach_request_extras(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_request_id text := private.req_id(p, 'requestId', '^[a-f0-9]{64}$');
  v_gift_name text := nullif(btrim(coalesce(private.opt_text(p, 'giftRecipientName', 80), '')), '');
  v_gift_msg text := nullif(btrim(coalesce(private.opt_text(p, 'giftMessage', 300), '')), '');
  v_ref_code text := upper(nullif(btrim(coalesce(private.opt_text(p, 'referralCode', 12), '')), ''));
  v_referrer uuid;
  v_req public.investment_requests;
begin
  select * into v_req from public.investment_requests where id = v_request_id and user_id = v_uid;
  if not found then
    perform private.fail('not-found', 'Investment request was not found.');
  end if;
  if v_req.status not in ('awaiting_payment', 'under_review') then
    perform private.fail('failed-precondition', 'Extras can only be attached to an open request.');
  end if;
  if v_gift_name is null and v_ref_code is null then
    perform private.fail('invalid-argument', 'Nothing to attach.');
  end if;

  if v_ref_code is not null then
    if v_ref_code !~ '^[A-Z2-9]{8}$' then
      perform private.fail('invalid-argument', 'Referral code format is invalid.');
    end if;
    select id into v_referrer from public.profiles where referral_code = v_ref_code;
    if v_referrer is null then
      perform private.fail('not-found', 'Referral code is unknown.');
    end if;
    if v_referrer = v_uid then
      perform private.fail('invalid-argument', 'You cannot refer yourself.');
    end if;
    -- First purchase only: no approved share yet and no earlier referral.
    if exists (select 1 from public.shares where user_id = v_uid)
       or exists (select 1 from public.referrals where referred_uid = v_uid and status in ('pending', 'rewarded')) then
      perform private.fail('failed-precondition', 'Referral codes apply to a first purchase only.');
    end if;
    insert into public.referrals (referrer_uid, referred_uid, request_id) values (v_referrer, v_uid, v_request_id);
  end if;

  insert into private.request_extras (request_id, gift_recipient_name, gift_message, referrer_uid)
  values (v_request_id, v_gift_name, v_gift_msg, v_referrer)
  on conflict (request_id) do update
     set gift_recipient_name = coalesce(excluded.gift_recipient_name, private.request_extras.gift_recipient_name),
         gift_message = coalesce(excluded.gift_message, private.request_extras.gift_message),
         referrer_uid = coalesce(excluded.referrer_uid, private.request_extras.referrer_uid);
  perform private.audit(v_uid, 'investment_request.extras', 'investment_requests/' || v_request_id,
    jsonb_build_object('gift', v_gift_name is not null, 'referral', v_referrer is not null));
  return jsonb_build_object('requestId', v_request_id, 'gift', v_gift_name is not null, 'referral', v_referrer is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Gifts
-- ---------------------------------------------------------------------------
-- Internal: create the gift row for an active share and return the plaintext code exactly once.
create or replace function private.create_gift_for_share(p_buyer uuid, p_share_id text, p_name text, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share public.shares;
  v_code text;
  v_id uuid;
  v_expires timestamptz;
begin
  select * into v_share from public.shares where id = p_share_id and user_id = p_buyer for update;
  if not found or v_share.status <> 'active' then
    perform private.fail('failed-precondition', 'Only an active share you own can be gifted.');
  end if;
  if exists (select 1 from public.gifts where share_id = p_share_id and status = 'open') then
    perform private.fail('already-exists', 'This share already has an open gift code.');
  end if;
  if exists (select 1 from public.oil_allocations a join public.oil_requests r on r.id = a.request_id
              where a.share_id = p_share_id and r.status in ('pending', 'approved')) then
    perform private.fail('failed-precondition', 'Finish the open oil request of this share before gifting it.');
  end if;
  v_code := private.random_code(4) || '-' || private.random_code(4) || '-' || private.random_code(4);
  insert into public.gifts (buyer_uid, share_id, code_hash, code_hint, recipient_name, message)
  values (p_buyer, p_share_id, private.gift_code_hash(v_code), right(replace(v_code, '-', ''), 4),
          coalesce(p_name, ''), coalesce(p_message, ''))
  returning id, expires_at into v_id, v_expires;
  perform private.audit(p_buyer, 'gift.created', 'gifts/' || v_id, jsonb_build_object('shareId', p_share_id, 'treeId', v_share.tree_id));
  perform private.notify_user(p_buyer, 'gift_created', jsonb_build_object('code', v_code, 'recipientName', coalesce(p_name, ''),
    'treeId', v_share.tree_id, 'shareCount', v_share.share_count, 'expiresAt', private.epoch_ms(v_expires)));
  return jsonb_build_object('giftId', v_id, 'code', v_code, 'shareId', p_share_id, 'treeId', v_share.tree_id,
                            'shareCount', v_share.share_count, 'expiresAt', private.epoch_ms(v_expires));
end;
$$;

create or replace function private.create_gift(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_share_id text := private.req_id(p, 'shareId', '^[a-f0-9]{64}$');
  v_name text := btrim(coalesce(private.opt_text(p, 'recipientName', 80), ''));
  v_msg text := btrim(coalesce(private.opt_text(p, 'message', 300), ''));
begin
  perform private.require_verified_email(v_uid, 'Verify your email before creating a gift.');
  if (select count(*) from public.gifts where buyer_uid = v_uid and created_at > now() - interval '1 day') >= 10 then
    perform private.fail('resource-exhausted', 'Too many gift codes created today.');
  end if;
  return private.create_gift_for_share(v_uid, v_share_id, v_name, v_msg);
end;
$$;

create or replace function private.cancel_gift(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id uuid := private.req_uuid(coalesce(payload, '{}'::jsonb), 'giftId');
  v_gift public.gifts;
begin
  select * into v_gift from public.gifts where id = v_id and buyer_uid = v_uid for update;
  if not found then
    perform private.fail('not-found', 'Gift not found.');
  end if;
  if v_gift.status <> 'open' then
    perform private.fail('failed-precondition', 'Only open gift codes can be cancelled.');
  end if;
  update public.gifts set status = 'cancelled' where id = v_id;
  perform private.audit(v_uid, 'gift.cancelled', 'gifts/' || v_id, '{}'::jsonb);
  return jsonb_build_object('giftId', v_id, 'status', 'cancelled');
end;
$$;

create or replace function private.redeem_gift(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_code text := coalesce(private.opt_text(p, 'code', 20), '');
  v_gift public.gifts;
  v_share public.shares;
  v_attempts integer;
begin
  perform private.require_verified_email(v_uid, 'Verify your email before redeeming a gift.');
  if regexp_replace(v_code, '[^A-Za-z0-9]', '', 'g') !~ '^[A-Za-z0-9]{12}$' then
    perform private.fail('invalid-argument', 'Gift code format is invalid.');
  end if;
  -- Guessing protection: 10 failed redeem attempts per user per hour (audited below).
  select count(*) into v_attempts from public.audit_logs
   where actor_uid = v_uid and action = 'gift.redeem_failed' and created_at > now() - interval '1 hour';
  if v_attempts >= 10 then
    perform private.fail('resource-exhausted', 'Too many attempts. Try again later.');
  end if;

  select * into v_gift from public.gifts where code_hash = private.gift_code_hash(v_code) for update;
  if not found or v_gift.status <> 'open' or v_gift.expires_at < now() then
    -- No exception here: the failed-attempt audit row must commit so the hourly cap can count it.
    if found and v_gift.status = 'open' and v_gift.expires_at < now() then
      update public.gifts set status = 'expired' where id = v_gift.id;
    end if;
    perform private.audit(v_uid, 'gift.redeem_failed', 'gifts/unknown', '{}'::jsonb);
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_gift.buyer_uid = v_uid then
    perform private.fail('invalid-argument', 'You cannot redeem your own gift.');
  end if;

  select * into v_share from public.shares where id = v_gift.share_id for update;
  if not found or v_share.status <> 'active' or v_share.user_id <> v_gift.buyer_uid then
    update public.gifts set status = 'cancelled' where id = v_gift.id;
    perform private.fail('failed-precondition', 'The gifted share is no longer available.');
  end if;

  update public.shares set user_id = v_uid where id = v_share.id;
  update public.gifts set status = 'redeemed', redeemed_by_uid = v_uid, redeemed_at = now() where id = v_gift.id;
  perform private.audit(v_uid, 'gift.redeemed', 'gifts/' || v_gift.id,
    jsonb_build_object('shareId', v_share.id, 'treeId', v_share.tree_id, 'fromUid', v_gift.buyer_uid));
  perform private.notify_user(v_gift.buyer_uid, 'gift_redeemed', jsonb_build_object('recipientName', v_gift.recipient_name, 'treeId', v_share.tree_id, 'shareCount', v_share.share_count));
  perform private.notify_user(v_uid, 'gift_received', jsonb_build_object('treeId', v_share.tree_id, 'shareCount', v_share.share_count, 'message', v_gift.message));
  return jsonb_build_object('giftId', v_gift.id, 'shareId', v_share.id, 'treeId', v_share.tree_id,
                            'shareCount', v_share.share_count, 'message', v_gift.message, 'status', 'redeemed');
end;
$$;

create or replace function private.my_gifts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'given', coalesce((select jsonb_agg(jsonb_build_object('giftId', g.id, 'shareId', g.share_id, 'treeId', s.tree_id, 'shareCount', s.share_count,
                        'codeHint', g.code_hint, 'recipientName', g.recipient_name, 'message', g.message, 'status', g.status,
                        'createdAt', private.epoch_ms(g.created_at), 'expiresAt', private.epoch_ms(g.expires_at), 'redeemedAt', private.epoch_ms(g.redeemed_at))
                        order by g.created_at desc)
                       from public.gifts g join public.shares s on s.id = g.share_id
                      where g.buyer_uid = (select auth.uid())), '[]'::jsonb),
    'received', coalesce((select jsonb_agg(jsonb_build_object('giftId', g.id, 'shareId', g.share_id, 'treeId', s.tree_id, 'shareCount', s.share_count,
                        'message', g.message, 'redeemedAt', private.epoch_ms(g.redeemed_at)) order by g.redeemed_at desc)
                       from public.gifts g join public.shares s on s.id = g.share_id
                      where g.redeemed_by_uid = (select auth.uid())), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- Approval hook: the share row is inserted last in review_investment_request, so it is the approval moment.
-- gift intent → gift code to the buyer; referral → oil credits for both sides
-- ---------------------------------------------------------------------------
create or replace function private.on_share_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_credit_ml constant integer := 250;
  c_max_rewards_per_year constant integer := 20;
  v_extra private.request_extras;
  v_ref public.referrals;
  v_rewards integer;
begin
  if tg_op <> 'INSERT' or new.status <> 'active' then
    return new;
  end if;
  select * into v_extra from private.request_extras where request_id = new.request_id;
  if found and v_extra.gift_recipient_name is not null then
    perform private.create_gift_for_share(new.user_id, new.id, v_extra.gift_recipient_name, v_extra.gift_message);
  end if;

  select * into v_ref from public.referrals where referred_uid = new.user_id and request_id = new.request_id and status = 'pending' for update;
  if found then
    select count(*) into v_rewards from public.referrals
     where referrer_uid = v_ref.referrer_uid and status = 'rewarded' and rewarded_at > now() - interval '1 year';
    if v_rewards >= c_max_rewards_per_year then
      update public.referrals set status = 'void' where id = v_ref.id;
    else
      update public.referrals set status = 'rewarded', rewarded_at = now() where id = v_ref.id;
      insert into public.reward_credits (user_id, kind, liters_ml, referral_id) values
        (v_ref.referrer_uid, 'referral_referrer', c_credit_ml, v_ref.id),
        (v_ref.referred_uid, 'referral_referred', c_credit_ml, v_ref.id);
      perform private.audit(v_ref.referrer_uid, 'referral.rewarded', 'referrals/' || v_ref.id, jsonb_build_object('referredUid', v_ref.referred_uid, 'litersMl', c_credit_ml));
      perform private.notify_user(v_ref.referrer_uid, 'referral_rewarded', jsonb_build_object('role', 'referrer', 'litersMl', c_credit_ml));
      perform private.notify_user(v_ref.referred_uid, 'referral_rewarded', jsonb_build_object('role', 'referred', 'litersMl', c_credit_ml));
    end if;
  end if;
  return new;
end;
$$;
create or replace trigger shares_created_rewards
  after insert on public.shares
  for each row execute function private.on_share_created();

-- Rejected / expired / cancelled reservations void a pending referral so the code can be used again.
create or replace function private.on_investment_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('rejected', 'expired', 'cancelled') and old.status not in ('rejected', 'expired', 'cancelled') then
    update public.referrals set status = 'void' where request_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;
create or replace trigger investment_requests_closed
  after update of status on public.investment_requests
  for each row execute function private.on_investment_closed();

