-- Faseela (migration 28): account deletion no longer touches storage.objects directly — the field-media prefix is
-- queued for the purge-storage Edge Function (migration 27). Otherwise identical to migration 26.
-- Contains DELETE → apply in the SQL editor (the MCP tool blocks it). Re-emits private.delete_my_account.
--
-- Design (unchanged): rows that are shared bookkeeping with another person (a redeemed gift, a rewarded referral) are
-- pseudonymised with the nil UUID instead of removed, so the counterpart keeps their history and the
-- 20-rewards-per-year cap of the referrer stays intact. Rows that belong to the person alone are deleted.
create or replace function private.delete_my_account(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_role text := private.current_app_role();
  c_gone constant uuid := '00000000-0000-0000-0000-000000000000'; -- "deleted account" marker, never a real user
begin
  if coalesce(payload ->> 'confirmation', '') <> 'DELETE' then
    perform private.fail('invalid-argument', 'Type DELETE to confirm account deletion.');
  end if;
  if exists (select 1 from public.investment_requests
              where user_id = v_uid and status in ('awaiting_payment', 'under_review')) then
    perform private.fail('failed-precondition', 'Cancel or complete your open investment requests before deleting the account.');
  end if;
  if exists (select 1 from public.shares where user_id = v_uid and status = 'active') then
    perform private.fail('failed-precondition', 'Your account still holds active shares. Please contact support to settle or transfer them first.');
  end if;
  if exists (select 1 from public.oil_requests where user_id = v_uid and status in ('pending', 'approved')) then
    perform private.fail('failed-precondition', 'Cancel or wait for your open oil requests before deleting the account.');
  end if;
  if v_role = 'admin' and (select count(*) from private.user_roles where role = 'admin') <= 1 then
    perform private.fail('failed-precondition', 'The last administrator account cannot delete itself. Appoint another admin first.');
  end if;

  -- Oil-delivery contacts (encrypted PII) go; requests/allocations stay as pseudonymised bookkeeping.
  delete from private.oil_request_contacts c
   using public.oil_requests r
   where c.request_id = r.id and r.user_id = v_uid;

  -- Farmer field data: unreviewed reports vanish, published ones keep the public text but lose GPS and media;
  -- every object the person uploaded to the private bucket is removed.
  delete from public.tree_events_public e
   using public.farmer_updates u
   where e.update_id = u.id and u.farmer_uid = v_uid and u.status <> 'published';
  delete from public.farmer_updates where farmer_uid = v_uid and status <> 'published';
  update public.farmer_updates
     set gps_lat = null, gps_lng = null, media_paths = '{}'
   where farmer_uid = v_uid;
  update public.tree_events_public e
     set media_count = 0
    from public.farmer_updates u
   where e.update_id = u.id and u.farmer_uid = v_uid;
  -- Objects cannot be removed from storage.objects directly (storage.protect_delete); the purge runs via the
  -- Storage API in the Edge Function purge-storage (migration 27), which removes rows AND blobs.
  perform private.enqueue_storage_purge('field-media', v_uid::text || '/', 'account_deleted');

  -- Gifts: an open code of a leaving buyer can no longer be redeemed (defensive; active shares block deletion
  -- anyway). Redeemed gifts stay for the counterpart with the leaving side pseudonymised.
  update public.gifts set status = 'cancelled' where buyer_uid = v_uid and status = 'open';
  update public.gifts set buyer_uid = c_gone where buyer_uid = v_uid;
  update public.gifts set redeemed_by_uid = c_gone where redeemed_by_uid = v_uid;

  -- Referrals: own credits vanish (they are personal and unusable after deletion); the relation row stays
  -- pseudonymised so the counterpart's rewarded/void history and the yearly cap remain correct.
  delete from public.reward_credits where user_id = v_uid;
  update public.referrals set status = 'void' where (referrer_uid = v_uid or referred_uid = v_uid) and status = 'pending';
  update public.referrals set referrer_uid = c_gone where referrer_uid = v_uid;
  update public.referrals set referred_uid = c_gone where referred_uid = v_uid;

  -- Checkout extras of the person's own requests (recipient name/message are free text they typed) and any
  -- pointer to them as referrer on other people's requests.
  update private.request_extras x
     set gift_recipient_name = null, gift_message = null
    from public.investment_requests r
   where x.request_id = r.id and r.user_id = v_uid;
  update private.request_extras set referrer_uid = null where referrer_uid = v_uid;

  -- Profile, role application, role, assignments, farmer profile cascade from auth.users.
  -- Financial records stay keyed by the orphaned uid for bookkeeping retention [PLATZHALTER: Aufbewahrungsfrist].
  perform private.audit(v_uid, 'account.deleted', 'profiles/' || v_uid, jsonb_build_object('role', v_role));
  delete from auth.users where id = v_uid;
  return jsonb_build_object('deleted', true);
end;
$$;

revoke all on function private.delete_my_account(jsonb) from public, anon, authenticated;
grant execute on function private.delete_my_account(jsonb) to authenticated;
