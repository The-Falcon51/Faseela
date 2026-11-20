-- Faseela (migration 46): the land / parcel option is refused on the server while the offer is switched off.
-- The web app already hides it (LAND_OFFER_ENABLED in public/app.js); without this gate a caller could still
-- send includesLand directly to the API, or an admin could create a tree with a parcel option.
-- The switch is private.app_settings('land_offer_enabled') and is OFF unless the row holds JSON true. It has no
-- screen on purpose: it is turned on by SQL after legal sign-off:
--   insert into private.app_settings (key, value) values ('land_offer_enabled', 'true')
--   on conflict (key) do update set value = 'true', updated_at = now();
-- Shares that already include land are not touched.
-- Rollback: restore the two public wrappers to "select private.<name>(payload);" and drop the two helpers.
create or replace function private.land_offer_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select value = 'true'::jsonb from private.app_settings where key = 'land_offer_enabled'), false);
$$;

/**
 * Fails closed: while the offer is off, any value other than JSON false / null under the given key is refused
 * (the request function casts text such as "true" or "yes" to boolean, so only an exact false is harmless).
 */
create or replace function private.assert_land_offer(payload jsonb, p_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(payload, '{}'::jsonb) ? p_key
     and (payload -> p_key) not in ('false'::jsonb, 'null'::jsonb)
     and not private.land_offer_enabled() then
    perform private.fail('failed-precondition', 'The land option is currently not offered.');
  end if;
end;
$$;

create or replace function public.create_investment_request(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.assert_land_offer(payload, 'includesLand');
  select private.create_investment_request(payload);
$$;
create or replace function public.admin_create_tree(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.assert_land_offer(payload, 'hasLandOption');
  select private.admin_create_tree(payload);
$$;

revoke all on function private.land_offer_enabled(), private.assert_land_offer(jsonb, text) from public, anon, authenticated;
grant execute on function private.land_offer_enabled(), private.assert_land_offer(jsonb, text) to authenticated;
