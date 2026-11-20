-- Admin tools callable from the app (replaces the SQL-editor-only helpers for day-to-day work):
-- role changes, account suspension, farmer/mill assignments. All admin-only, never on the caller's
-- own account (four-eyes), every change audited. Also caps the number of uploads per folder.

create function private.admin_target(p jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin uuid := private.require_role('{}'::text[]);
  v_target uuid := private.req_uuid(p, 'userId');
begin
  if v_target = v_admin then
    perform private.fail('permission-denied', 'Administrators cannot change their own account here.');
  end if;
  if not exists (select 1 from auth.users where id = v_target) then
    perform private.fail('not-found', 'User was not found.');
  end if;
  return v_target;
end;
$$;

create function private.admin_set_user_role(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_target uuid := private.admin_target(p);
  v_role text := private.req_id(p, 'role', '^(investor|farmer|mill_operator|finance_admin|quality_auditor|admin)$');
  v_admin uuid := (select auth.uid());
begin
  insert into private.user_roles (user_id, role, granted_by, granted_at)
  values (v_target, v_role, v_admin, now())
  on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by, granted_at = now();
  perform private.audit(v_admin, 'role.set', 'user_roles/' || v_target, jsonb_build_object('role', v_role));
  return jsonb_build_object('userId', v_target, 'role', v_role);
end;
$$;

-- status: 'active' lifts a suspension, 'suspended' blocks sign-in and token refresh (auth.users.banned_until).
create function private.admin_set_user_status(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_target uuid := private.admin_target(p);
  v_status text := private.req_id(p, 'status', '^(active|suspended)$');
  v_admin uuid := (select auth.uid());
begin
  update auth.users
     set banned_until = case when v_status = 'suspended' then 'infinity'::timestamptz else null end,
         updated_at = now()
   where id = v_target;
  perform private.audit(v_admin, 'account.' || v_status, 'users/' || v_target, '{}'::jsonb);
  return jsonb_build_object('userId', v_target, 'status', v_status);
end;
$$;

-- Assignments are revoked, never deleted (history stays auditable); active = revoked_at is null.
alter table public.farmer_assignments add column revoked_at timestamptz;
alter table public.mill_assignments add column revoked_at timestamptz;

create function private.farmer_has_tree(p_uid uuid, p_tree_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.farmer_assignments a
                  where a.farmer_uid = p_uid and a.tree_id = p_tree_id and a.revoked_at is null);
$$;

create function private.operator_has_mill(p_uid uuid, p_mill_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.mill_assignments a
                  where a.operator_uid = p_uid and a.mill_id = p_mill_id and a.revoked_at is null);
$$;

-- kind: 'farmer_tree' (target = tree id) | 'mill' (target = mill id); action: 'add' | 'remove'.
create function private.admin_assign(payload jsonb)
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

create function public.admin_set_user_role(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_user_role(payload); $$;
create function public.admin_set_user_status(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_user_status(payload); $$;
create function public.admin_assign(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_assign(payload); $$;

revoke all on function private.farmer_has_tree(uuid, text), private.operator_has_mill(uuid, text) from public, anon;
grant execute on function private.farmer_has_tree(uuid, text), private.operator_has_mill(uuid, text) to authenticated;
revoke all on function private.admin_target(jsonb), private.admin_set_user_role(jsonb), private.admin_set_user_status(jsonb),
  private.admin_assign(jsonb), public.admin_set_user_role(jsonb), public.admin_set_user_status(jsonb), public.admin_assign(jsonb)
  from public, anon;
grant execute on function private.admin_set_user_role(jsonb), private.admin_set_user_status(jsonb), private.admin_assign(jsonb),
  public.admin_set_user_role(jsonb), public.admin_set_user_status(jsonb), public.admin_assign(jsonb)
  to authenticated;

-- Upload caps: at most 5 receipt files per request folder, 30 media files per farmer/tree folder.
create or replace function private.can_upload_payment_proof(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and array_length(storage.foldername(p_name), 1) = 2
     and (storage.foldername(p_name))[1] = (select auth.uid())::text
     and storage.filename(p_name) ~ '^[A-Za-z0-9._-]{1,120}$'
     and exists (
       select 1 from public.investment_requests r
        where r.id = (storage.foldername(p_name))[2]
          and r.user_id = (select auth.uid())
          and r.status = 'awaiting_payment'
          and r.expires_at > now()
     )
     and (select count(*) from storage.objects o
           where o.bucket_id = 'payment-proofs'
             and o.name like (storage.foldername(p_name))[1] || '/' || (storage.foldername(p_name))[2] || '/%') < 5;
$$;

create or replace function private.can_upload_field_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_any_role(array['farmer'])
     and array_length(storage.foldername(p_name), 1) = 2
     and (storage.foldername(p_name))[1] = (select auth.uid())::text
     and storage.filename(p_name) ~ '^[A-Za-z0-9._-]{1,120}$'
     and private.farmer_has_tree((select auth.uid()), (storage.foldername(p_name))[2])
     and (select count(*) from storage.objects o
           where o.bucket_id = 'field-media'
             and o.name like (storage.foldername(p_name))[1] || '/' || (storage.foldername(p_name))[2] || '/%') < 30;
$$;

-- Submission checks now ignore revoked assignments.
create or replace function private.submit_farmer_update(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['farmer']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree_id text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_event text := private.req_id(p, 'eventType', '^(watering|pruning|fertilizing|pest_control|harvest|other)$');
  v_notes text;
  v_media text[] := '{}';
  v_item jsonb;
  v_lat double precision;
  v_lng double precision;
  v_id uuid;
begin
  if jsonb_typeof(p -> 'notes') is distinct from 'string' or char_length(p ->> 'notes') > 1200 then
    perform private.fail('invalid-argument', 'Farmer update data is invalid.');
  end if;
  v_notes := p ->> 'notes';
  if jsonb_typeof(p -> 'mediaPaths') is distinct from 'array' or jsonb_array_length(p -> 'mediaPaths') > 5 then
    perform private.fail('invalid-argument', 'Farmer update data is invalid.');
  end if;
  for v_item in select value from jsonb_array_elements(p -> 'mediaPaths') loop
    -- Object names inside bucket `field-media`: {uid}/{treeId}/{file}
    if jsonb_typeof(v_item) <> 'string' or char_length(v_item #>> '{}') > 300
       or (v_item #>> '{}') not like v_uid::text || '/' || v_tree_id || '/%'
       or position('..' in (v_item #>> '{}')) > 0 then
      perform private.fail('invalid-argument', 'Media must be uploaded to your own field-media folder for this tree.');
    end if;
    v_media := v_media || (v_item #>> '{}');
  end loop;
  if p ? 'gpsLat' and jsonb_typeof(p -> 'gpsLat') <> 'null' then
    v_lat := private.req_number(p, 'gpsLat');
    if v_lat not between -90 and 90 then perform private.fail('invalid-argument', 'GPS coordinates are invalid.'); end if;
  end if;
  if p ? 'gpsLng' and jsonb_typeof(p -> 'gpsLng') <> 'null' then
    v_lng := private.req_number(p, 'gpsLng');
    if v_lng not between -180 and 180 then perform private.fail('invalid-argument', 'GPS coordinates are invalid.'); end if;
  end if;

  if not private.farmer_has_tree(v_uid, v_tree_id) then
    perform private.fail('permission-denied', 'Tree is not assigned to this farmer.');
  end if;

  insert into public.farmer_updates (farmer_uid, tree_id, event_type, notes, media_paths, gps_lat, gps_lng, status)
  values (v_uid, v_tree_id, v_event, v_notes, v_media, v_lat, v_lng, 'pending_review')
  returning id into v_id;
  return jsonb_build_object('updateId', v_id, 'status', 'pending_review');
end;
$$;

create or replace function private.submit_pressing_batch(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['mill_operator']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree_id text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_mill_id text := private.req_id(p, 'millId', '^[A-Za-z0-9_-]{1,80}$');
  v_weight numeric := private.req_number(p, 'olivesWeightKg');
  v_oil numeric := private.req_number(p, 'oilYieldLiters');
  v_temp numeric := private.req_number(p, 'temperatureCelsius');
  v_acid numeric := private.req_number(p, 'acidityPct');
  v_perox numeric := private.req_number(p, 'peroxideValue');
  v_id uuid;
begin
  if v_weight <= 0 or v_oil < 0 or v_temp not between 0 and 40
     or v_acid not between 0 and 100 or v_perox not between 0 and 100 then
    perform private.fail('invalid-argument', 'Pressing batch values are outside allowed bounds.');
  end if;
  if not private.operator_has_mill(v_uid, v_mill_id) then
    perform private.fail('permission-denied', 'Mill is not assigned to this operator.');
  end if;
  if not exists (select 1 from public.trees_public where tree_id = v_tree_id and status = 'listed') then
    perform private.fail('not-found', 'This tree is not available for pressing records.');
  end if;

  insert into public.pressing_batches (submitted_by_uid, tree_id, mill_id, olives_weight_kg, oil_yield_liters,
                                       temperature_celsius, acidity_pct, peroxide_value, season_year, status)
  values (v_uid, v_tree_id, v_mill_id, v_weight, v_oil, v_temp, v_acid, v_perox,
          extract(year from (now() at time zone 'utc'))::integer, 'pending_review')
  returning id into v_id;
  return jsonb_build_object('batchId', v_id, 'status', 'pending_review');
end;
$$;
