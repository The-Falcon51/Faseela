-- Faseela: audit run-1 fixes, part 2 — statements containing DELETE/DROP. The Supabase MCP connector blocks
-- these behind a confirmation prompt, so this file is applied once in the SQL editor (like 20261020000500).
-- Contents: F1 delete_my_account (oil contacts, farmer data, last admin),
-- prune_monitoring incl. cron history and failed outbox rows.

-- F1: account deletion covers every feature that stores the person's data.
create or replace function private.delete_my_account(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_role text := private.current_app_role();
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

  -- Oil-delivery contacts (encrypted PII) go; the requests/allocations stay as pseudonymised bookkeeping.
  delete from private.oil_request_contacts c
   using public.oil_requests r
   where c.request_id = r.id and r.user_id = v_uid;

  -- Field data of a farmer: unreviewed reports vanish, published ones keep the public text but lose
  -- GPS and media; every object the person uploaded to the private buckets is removed.
  delete from public.tree_events_public e
   using public.farmer_updates u
   where e.update_id = u.id and u.farmer_uid = v_uid and u.status <> 'published';
  delete from public.farmer_updates where farmer_uid = v_uid and status <> 'published';
  update public.farmer_updates
     set gps_lat = null, gps_lng = null, media_paths = '{}', notes = notes
   where farmer_uid = v_uid;
  update public.tree_events_public e
     set media_count = 0
    from public.farmer_updates u
   where e.update_id = u.id and u.farmer_uid = v_uid;
  delete from storage.objects
   where bucket_id = 'field-media' and name like v_uid::text || '/%';

  -- Personal data goes (profile, role application, role, assignments, farmer profile cascade from auth.users).
  -- Financial records (investment requests, transactions, shares, oil allocations/requests, payment proofs)
  -- stay keyed by the orphaned uid for bookkeeping retention [PLATZHALTER: Aufbewahrungsfrist].
  perform private.audit(v_uid, 'account.deleted', 'profiles/' || v_uid, jsonb_build_object('role', v_role));
  delete from auth.users where id = v_uid;
  return jsonb_build_object('deleted', true);
end;
$$;

-- Monitoring tables stay bounded (cron history grows ~1.4k rows/day).
create or replace function private.prune_monitoring()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.client_errors where created_at < now() - interval '14 days';
  delete from private.email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  delete from private.email_outbox where status = 'failed' and created_at < now() - interval '30 days';
  delete from private.email_skipped where hour_bucket < now() - interval '7 days';
  delete from cron.job_run_details where end_time < now() - interval '7 days';
$$;

revoke all on function private.delete_my_account(jsonb), private.prune_monitoring() from public, anon, authenticated;
grant execute on function private.delete_my_account(jsonb) to authenticated;
