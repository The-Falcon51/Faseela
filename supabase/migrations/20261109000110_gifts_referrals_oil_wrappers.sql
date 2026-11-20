-- Faseela: gift purchase + referral programme, part 2 — oil credit merge (re-emits), export, wrappers, grants.

-- ---------------------------------------------------------------------------
-- Oil: referral credits merge into the next request and return on cancel/reject (re-emits)
-- ---------------------------------------------------------------------------
create or replace function private.request_oil(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_kind text := private.opt_text(p, 'kind', 10);
  v_ids uuid[];
  v_contact jsonb := coalesce(p->'contact', '{}'::jsonb);
  v_name text := btrim(coalesce(private.opt_text(v_contact, 'name', 120), ''));
  v_phone text := btrim(coalesce(private.opt_text(v_contact, 'phone', 40), ''));
  v_line1 text := btrim(coalesce(private.opt_text(v_contact, 'addressLine1', 200), ''));
  v_line2 text := btrim(coalesce(private.opt_text(v_contact, 'addressLine2', 200), ''));
  v_city text := btrim(coalesce(private.opt_text(v_contact, 'city', 120), ''));
  v_country text := upper(btrim(coalesce(private.opt_text(v_contact, 'country', 2), '')));
  v_note text := btrim(coalesce(private.opt_text(v_contact, 'note', 300), ''));
  v_ml integer;
  v_n integer;
  v_request_id uuid;
  v_open integer;
  v_credit integer := 0;
begin
  perform private.require_verified_email(v_uid, 'Verify your email before requesting oil.');
  if v_kind is null or v_kind not in ('delivery', 'pickup', 'donate') then
    perform private.fail('invalid-argument', 'Request kind is invalid.');
  end if;
  if coalesce(jsonb_typeof(p->'allocationIds'), 'missing') <> 'array' or jsonb_array_length(p->'allocationIds') = 0
     or jsonb_array_length(p->'allocationIds') > 50 then
    perform private.fail('invalid-argument', 'Select between 1 and 50 allocations.');
  end if;
  begin
    select array_agg((e.value #>> '{}')::uuid) into v_ids from jsonb_array_elements(p->'allocationIds') e;
  exception when others then
    perform private.fail('invalid-argument', 'Allocation ids are invalid.');
  end;
  if v_kind in ('delivery', 'pickup') and (char_length(v_name) < 2 or v_phone !~ '^\+?[0-9 ()-]{6,40}$') then
    perform private.fail('invalid-argument', 'Name and phone number are required.');
  end if;
  if v_kind = 'delivery' and (char_length(v_line1) < 3 or char_length(v_city) < 2 or v_country !~ '^[A-Z]{2}$') then
    perform private.fail('invalid-argument', 'A delivery address with city and country is required.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('faseela:oil:' || v_uid::text, 0));
  -- One open request at a time keeps the review queue unambiguous (counted under the lock; audit hardening).
  select count(*) into v_open from public.oil_requests where user_id = v_uid and status in ('pending', 'approved');
  if v_open >= 3 then
    perform private.fail('resource-exhausted', 'Too many open oil requests. Wait for the current ones to be processed.');
  end if;
  select coalesce(sum(liters_ml), 0), count(*) into v_ml, v_n
    from public.oil_allocations
   where id = any(v_ids) and user_id = v_uid and status = 'available';
  if v_n <> cardinality(v_ids) or v_n = 0 then
    perform private.fail('failed-precondition', 'Some allocations are not available.');
  end if;
  if v_ml <= 0 then
    perform private.fail('failed-precondition', 'The selected allocations contain no oil.');
  end if;
  -- Referral credits (reward_credits) ride along with the next oil request.
  select coalesce(sum(liters_ml), 0) into v_credit from public.reward_credits where user_id = v_uid and status = 'granted';
  v_ml := v_ml + v_credit;

  insert into public.oil_requests (user_id, kind, liters_ml, allocation_count)
  values (v_uid, v_kind, v_ml, v_n) returning id into v_request_id;
  update public.oil_allocations set status = 'requested', request_id = v_request_id
   where id = any(v_ids) and user_id = v_uid and status = 'available';
  update public.reward_credits set status = 'redeemed', oil_request_id = v_request_id
   where user_id = v_uid and status = 'granted';

  if v_kind <> 'donate' then
    insert into private.oil_request_contacts (request_id, contact_enc)
    values (v_request_id, extensions.pgp_sym_encrypt(jsonb_build_object(
      'name', v_name, 'phone', v_phone, 'addressLine1', v_line1, 'addressLine2', v_line2,
      'city', v_city, 'country', v_country, 'note', v_note)::text, private.pii_key()));
  end if;

  perform private.audit(v_uid, 'oil_request.created', 'oil_requests/' || v_request_id,
    jsonb_build_object('kind', v_kind, 'litersMl', v_ml, 'allocations', v_n));
  perform private.notify_user(v_uid, 'oil_request_received', jsonb_build_object('requestId', v_request_id, 'kind', v_kind, 'litersMl', v_ml));
  perform private.notify_role('finance_admin', 'review_needed', jsonb_build_object('queue', 'oil_requests', 'requestId', v_request_id, 'litersMl', v_ml));
  return jsonb_build_object('requestId', v_request_id, 'status', 'pending', 'litersMl', v_ml, 'creditMl', v_credit, 'kind', v_kind);
end;
$$;

create or replace function private.cancel_oil_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id uuid := private.req_uuid(coalesce(payload, '{}'::jsonb), 'requestId');
  v_req public.oil_requests;
begin
  select * into v_req from public.oil_requests where id = v_id and user_id = v_uid for update;
  if not found then
    perform private.fail('not-found', 'Oil request not found.');
  end if;
  if v_req.status <> 'pending' then
    perform private.fail('failed-precondition', 'Only pending requests can be cancelled.');
  end if;
  update public.oil_requests set status = 'cancelled' where id = v_id;
  update public.oil_allocations set status = 'available', request_id = null where request_id = v_id;
  update public.reward_credits set status = 'granted', oil_request_id = null where oil_request_id = v_id;
  perform private.audit(v_uid, 'oil_request.cancelled', 'oil_requests/' || v_id, '{}'::jsonb);
  return jsonb_build_object('requestId', v_id, 'status', 'cancelled');
end;
$$;

create or replace function private.review_oil_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_id uuid := private.req_uuid(p, 'requestId');
  v_decision text := private.opt_text(p, 'decision', 10);
  v_note text := private.parse_note(p);
  v_req public.oil_requests;
  v_status text;
begin
  if v_decision is null or v_decision not in ('approve', 'reject', 'fulfil') then
    perform private.fail('invalid-argument', 'Decision is invalid.');
  end if;
  if v_decision = 'reject' and char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A rejection needs a note.');
  end if;
  select * into v_req from public.oil_requests where id = v_id for update;
  if not found then
    perform private.fail('not-found', 'Oil request not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_req.user_id);

  if v_decision = 'approve' then
    if v_req.status <> 'pending' then perform private.fail('failed-precondition', 'Request is not pending.'); end if;
    v_status := 'approved';
    update public.oil_requests set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now() where id = v_id;
  elsif v_decision = 'fulfil' then
    if v_req.status not in ('pending', 'approved') then perform private.fail('failed-precondition', 'Request is not open.'); end if;
    v_status := 'fulfilled';
    update public.oil_requests set status = v_status, review_note = coalesce(nullif(v_note, ''), review_note),
           reviewed_by_uid = coalesce(reviewed_by_uid, v_uid), reviewed_at = coalesce(reviewed_at, now()), fulfilled_at = now()
     where id = v_id;
    update public.oil_allocations set status = 'fulfilled' where request_id = v_id;
  else
    if v_req.status not in ('pending', 'approved') then perform private.fail('failed-precondition', 'Request is not open.'); end if;
    v_status := 'rejected';
    update public.oil_requests set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now() where id = v_id;
    update public.oil_allocations set status = 'available', request_id = null where request_id = v_id;
    update public.reward_credits set status = 'granted', oil_request_id = null where oil_request_id = v_id;
  end if;

  perform private.audit(v_uid, 'oil_request.' || v_status, 'oil_requests/' || v_id,
    jsonb_build_object('kind', v_req.kind, 'litersMl', v_req.liters_ml, 'note', v_note));
  perform private.notify_user(v_req.user_id, 'oil_request_' || v_status, jsonb_build_object(
    'requestId', v_id, 'kind', v_req.kind, 'litersMl', v_req.liters_ml, 'note', v_note));
  return jsonb_build_object('requestId', v_id, 'status', v_status);
end;
$$;

revoke all on function private.request_oil(jsonb), private.cancel_oil_request(jsonb), private.review_oil_request(jsonb) from public, anon, authenticated;
grant execute on function private.request_oil(jsonb), private.cancel_oil_request(jsonb), private.review_oil_request(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Export (merged client-side into the DSGVO export like export_my_oil)
-- ---------------------------------------------------------------------------
create or replace function private.export_my_rewards()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'referralCode', (select referral_code from public.profiles where id = (select auth.uid())),
    'referrals', coalesce((select jsonb_agg(to_jsonb(r) - 'referrer_uid' - 'referred_uid'
                            || jsonb_build_object('role', case when r.referrer_uid = (select auth.uid()) then 'referrer' else 'referred' end))
                           from public.referrals r where r.referrer_uid = (select auth.uid()) or r.referred_uid = (select auth.uid())), '[]'::jsonb),
    'rewardCredits', coalesce((select jsonb_agg(to_jsonb(c)) from public.reward_credits c where c.user_id = (select auth.uid())), '[]'::jsonb),
    'gifts', private.my_gifts());
$$;

-- ---------------------------------------------------------------------------
-- Public wrappers + privileges (deny-by-default, then intended grants)
-- ---------------------------------------------------------------------------
create or replace function public.my_referral_code() returns jsonb
language sql security invoker set search_path = '' as $$ select private.my_referral_code(); $$;
create or replace function public.attach_request_extras(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.attach_request_extras(payload); $$;
create or replace function public.create_gift(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.create_gift(payload); $$;
create or replace function public.cancel_gift(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.cancel_gift(payload); $$;
create or replace function public.redeem_gift(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.redeem_gift(payload); $$;
create or replace function public.my_gifts() returns jsonb
language sql security invoker set search_path = '' as $$ select private.my_gifts(); $$;
create or replace function public.export_my_rewards() returns jsonb
language sql security invoker set search_path = '' as $$ select private.export_my_rewards(); $$;

revoke all on function private.random_code(integer), private.gift_code_hash(text), private.create_gift_for_share(uuid, text, text, text),
  private.on_share_created(), private.on_investment_closed(),
  private.my_referral_code(), private.attach_request_extras(jsonb), private.create_gift(jsonb), private.cancel_gift(jsonb),
  private.redeem_gift(jsonb), private.my_gifts(), private.export_my_rewards(),
  public.my_referral_code(), public.attach_request_extras(jsonb), public.create_gift(jsonb), public.cancel_gift(jsonb),
  public.redeem_gift(jsonb), public.my_gifts(), public.export_my_rewards()
  from public, anon, authenticated;
grant execute on function
  private.my_referral_code(), private.attach_request_extras(jsonb), private.create_gift(jsonb), private.cancel_gift(jsonb),
  private.redeem_gift(jsonb), private.my_gifts(), private.export_my_rewards(),
  public.my_referral_code(), public.attach_request_extras(jsonb), public.create_gift(jsonb), public.cancel_gift(jsonb),
  public.redeem_gift(jsonb), public.my_gifts(), public.export_my_rewards()
  to authenticated;
