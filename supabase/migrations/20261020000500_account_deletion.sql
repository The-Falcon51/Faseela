-- Faseela: functions that delete rows (applied separately because they need an explicit
-- confirmation of the destructive statement). DSGVO Art. 17 self-service.

create function private.delete_my_account(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
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

  -- Personal data goes (profile, role application, role, assignments cascade from auth.users).
  -- Financial records stay keyed by the orphaned uid (pseudonymised) for bookkeeping
  -- retention [PLATZHALTER: Aufbewahrungsfrist].
  perform private.audit(v_uid, 'account.deleted', 'profiles/' || v_uid, '{}'::jsonb);
  delete from auth.users where id = v_uid;
  return jsonb_build_object('deleted', true);
end;
$$;

create function public.delete_my_account(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.delete_my_account(payload); $$;

revoke all on function private.delete_my_account(jsonb) from public, anon;
grant execute on function private.delete_my_account(jsonb) to authenticated;
revoke all on function public.delete_my_account(jsonb) from public, anon;
grant execute on function public.delete_my_account(jsonb) to authenticated;
