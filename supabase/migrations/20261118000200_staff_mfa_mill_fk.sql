-- Faseela (migration 49): optional second factor for staff accounts, and mill assignments bound to mill records.
--
-- 1. Second factor. Until now a password alone was enough to approve payments or change the receiving accounts.
--    private.require_role is the gate of every staff function; while private.app_settings('staff_mfa_required')
--    holds JSON true it also demands a session that was verified with a second factor (JWT claim aal = aal2)
--    from every account with a staff role (admin, finance_admin, quality_auditor). Sponsors, farmers and mill
--    operators are not affected by the switch. The rule of 20261116000120_launch_hardening.sql stays: any account
--    that has a verified factor must present it (aal2), switch on or off.
--    The switch is OFF by default. An admin can only turn it on from a session that already is aal2, so the
--    switch cannot lock out the person who flips it. Other staff accounts must enrol a factor before they can
--    work again; the panel leads them there.
-- 2. public.mill_assignments.mill_id now references public.mills, and admin_assign refuses unknown mills.
--
-- Rollback: restore private.require_role and private.admin_assign from their previous definitions, drop
--   private.staff_mfa_required(), private.staff_security_state(), private.admin_set_staff_mfa(jsonb) and their public
--   wrappers, delete the app_settings row, alter table public.mill_assignments drop constraint mill_assignments_mill_id_fkey.

create or replace function private.staff_mfa_required()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select value = 'true'::jsonb from private.app_settings where key = 'staff_mfa_required'), false);
$$;

create or replace function private.require_role(roles text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.has_any_role(roles) then
    perform private.fail('permission-denied', 'This operation is not permitted for this account.');
  end if;
  -- An account that has enrolled a verified factor must always present it (20261116000120_launch_hardening.sql,
  -- applied on live). Kept here because this function replaces that definition.
  if coalesce((select auth.jwt()) ->> 'aal', 'aal1') <> 'aal2'
     and exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified') then
    perform private.fail('mfa-required', 'Confirm the second factor to continue.');
  end if;
  -- Staff accounts need a second factor once the switch is on (see header).
  if private.staff_mfa_required()
     and private.has_any_role(array['finance_admin', 'quality_auditor'])
     and coalesce((select auth.jwt()) ->> 'aal', 'aal1') <> 'aal2' then
    perform private.fail('mfa-required', 'A second factor is required for this account. Sign in again and confirm with your authenticator app.');
  end if;
  return v_uid;
end;
$$;

/** What the panel needs before any staff function works: is a second factor demanded, and does this session have one. */
create or replace function private.staff_security_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.has_any_role(array['finance_admin', 'quality_auditor']) then
    perform private.fail('permission-denied', 'This operation is not permitted for this account.');
  end if;
  return jsonb_build_object('mfaRequired', private.staff_mfa_required(),
    'sessionLevel', coalesce((select auth.jwt()) ->> 'aal', 'aal1'));
end;
$$;

/** Turns the staff second-factor requirement on or off. Turning it on needs a session that already has one. */
create or replace function private.admin_set_staff_mfa(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_required boolean;
begin
  if jsonb_typeof(p -> 'required') is distinct from 'boolean' then
    perform private.fail('invalid-argument', 'Field required is invalid.');
  end if;
  v_required := (p ->> 'required')::boolean;
  if v_required and coalesce((select auth.jwt()) ->> 'aal', 'aal1') <> 'aal2' then
    perform private.fail('failed-precondition', 'Set up and confirm your own second factor before requiring it for everyone.');
  end if;
  insert into private.app_settings (key, value, updated_at, updated_by)
  values ('staff_mfa_required', to_jsonb(v_required), now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  perform private.audit(v_uid, 'settings.staff_mfa', 'app_settings/staff_mfa_required', jsonb_build_object('required', v_required));
  return jsonb_build_object('mfaRequired', v_required);
end;
$$;

create or replace function public.staff_security_state() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.staff_security_state(); $$;
create or replace function public.admin_set_staff_mfa(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_staff_mfa(payload); $$;
revoke all on function private.staff_mfa_required(), private.staff_security_state(), private.admin_set_staff_mfa(jsonb),
  public.staff_security_state(), public.admin_set_staff_mfa(jsonb) from public, anon, authenticated;
grant execute on function private.staff_mfa_required(), private.staff_security_state(), private.admin_set_staff_mfa(jsonb),
  public.staff_security_state(), public.admin_set_staff_mfa(jsonb) to authenticated;

-- ---------------------------------------------------------------- mill assignments
insert into public.mills (mill_id, country_code)
  select distinct mill_id, 'SY' from public.mill_assignments
  on conflict (mill_id) do nothing;
alter table public.mill_assignments add constraint mill_assignments_mill_id_fkey foreign key (mill_id) references public.mills (mill_id);

create or replace function private.admin_assign(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_target uuid := private.admin_target(p);
  v_kind text := private.req_id(p, 'kind', '^(farmer_tree|mill)$');
  v_action text := private.req_id(p, 'action', '^(add|remove)$');
  v_id text := private.req_id(p, 'targetId', '^[A-Za-z0-9_-]{1,80}$');
  v_admin uuid := (select auth.uid());
begin
  if v_kind = 'farmer_tree' then
    if v_action = 'add' then
      if not exists (select 1 from public.trees_public where tree_id = v_id) then
        perform private.fail('not-found', 'Tree was not found.');
      end if;
      insert into public.farmer_assignments (farmer_uid, tree_id, assigned_at, revoked_at)
      values (v_target, v_id, now(), null)
      on conflict (farmer_uid, tree_id) do update set revoked_at = null, assigned_at = now();
    else
      update public.farmer_assignments set revoked_at = now()
       where farmer_uid = v_target and tree_id = v_id and revoked_at is null;
    end if;
  else
    if v_action = 'add' then
      if not exists (select 1 from public.mills where mill_id = v_id) then
        perform private.fail('not-found', 'Mill was not found. Create it under master data first.');
      end if;
      insert into public.mill_assignments (operator_uid, mill_id, assigned_at, revoked_at)
      values (v_target, v_id, now(), null)
      on conflict (operator_uid, mill_id) do update set revoked_at = null, assigned_at = now();
    else
      update public.mill_assignments set revoked_at = now()
       where operator_uid = v_target and mill_id = v_id and revoked_at is null;
    end if;
  end if;
  perform private.audit(v_admin, 'assignment.' || v_kind || '.' || v_action, 'users/' || v_target, jsonb_build_object('targetId', v_id));
  return jsonb_build_object(
    'userId', v_target,
    'trees', coalesce((select jsonb_agg(tree_id order by tree_id) from public.farmer_assignments where farmer_uid = v_target and revoked_at is null), '[]'::jsonb),
    'mills', coalesce((select jsonb_agg(mill_id order by mill_id) from public.mill_assignments where operator_uid = v_target and revoked_at is null), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------- admin overview knows whether land may be offered
-- The tree form hides its parcel option while the land offer is off (migration 46), instead of offering a field
-- the server refuses. Same function as in migration 48 plus the flag.
create or replace function private.admin_list_master_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
begin
  return jsonb_build_object(
    'landOfferEnabled', private.land_offer_enabled(),
    'currencies', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'minorUnits', minor_units, 'nameEn', name_en) order by code) from public.currencies), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'nameEn', name_en, 'nameDe', name_de, 'currency', currency, 'status', status,
        'trees', (select count(*) from public.trees_public t where t.country_code = c.code)) order by code) from public.countries c), '[]'::jsonb),
    'farms', coalesce((select jsonb_agg(jsonb_build_object('farmId', farm_id, 'countryCode', country_code, 'name', name, 'nameEn', name_en, 'region', region,
        'regionEn', region_en, 'status', status, 'trees', (select count(*) from private.trees t where t.farm_id = f.farm_id)) order by farm_id) from public.farms f), '[]'::jsonb),
    'mills', coalesce((select jsonb_agg(jsonb_build_object('millId', mill_id, 'countryCode', country_code, 'name', name, 'nameEn', name_en, 'region', region,
        'regionEn', region_en, 'status', status, 'trees', (select count(*) from private.trees t where t.mill_id = m.mill_id)) order by mill_id) from public.mills m), '[]'::jsonb));
end;
$$;
