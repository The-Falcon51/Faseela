-- Faseela (migration 35): server-side switch for push notifications.
-- The native app must not offer push before the Firebase project is wired in (without google-services.json the
-- push plugin cannot initialise). The switch lives in private.app_settings (key 'push_enabled', value true) and is
-- off by default; registration is refused while it is off, and push_state() tells the client whether to show the card.
create or replace function private.push_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.value = 'true'::jsonb from private.app_settings s where s.key = 'push_enabled'), false);
$$;

create or replace function private.assert_push_enabled()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.push_enabled() then
    perform private.fail('failed-precondition', 'Push notifications are not switched on yet.');
  end if;
end;
$$;

create or replace function private.push_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return jsonb_build_object(
    'enabled', private.push_enabled(),
    'activeDevices', (select count(*) from private.push_tokens where user_id = v_uid and disabled_at is null));
end;
$$;

create or replace function public.register_push_token(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('register_push_token', 20, 600);
  select private.assert_push_enabled();
  select private.register_push_token(payload);
$$;

revoke all on function private.push_enabled(), private.assert_push_enabled() from public, anon, authenticated;
grant execute on function private.assert_push_enabled() to authenticated;
