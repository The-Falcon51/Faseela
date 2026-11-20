-- Public tree profiles (Welle 1 of the growth plan): everything a visitor may see about a tree without
-- an account — published events with photos, the farmer's portrait (only with explicit consent), the last
-- certified pressing, availability. Media stays in the private bucket; the Edge Function `tree-media` signs
-- URLs for published media only. No DELETE anywhere.

-- 1) Link public events to their source update so published media can be found.
alter table public.tree_events_public add column if not exists update_id uuid;
create index if not exists tree_events_public_update_idx on public.tree_events_public (update_id);

-- 2) Farmer profiles: written by the farmer, public only with consent (revocable).
create table if not exists public.farmer_profiles (
  farmer_uid uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  village text not null default '' check (char_length(village) <= 120),
  region text not null default '' check (char_length(region) <= 120),
  years_farming integer check (years_farming between 0 and 90),
  bio text not null default '' check (char_length(bio) <= 600),
  bio_en text not null default '' check (char_length(bio_en) <= 600),
  photo_path text check (photo_path is null or photo_path ~ '^[0-9a-f-]{36}/profile/[A-Za-z0-9._-]{1,120}$'),
  consent_public boolean not null default false,
  consent_at timestamptz,
  consent_version text,
  updated_at timestamptz not null default now()
);
alter table public.farmer_profiles enable row level security;
revoke all on public.farmer_profiles from public, anon, authenticated;
grant select on public.farmer_profiles to anon, authenticated;
-- Visitors see consented profiles; the farmer always sees their own row.
create policy farmer_profiles_select on public.farmer_profiles for select to anon, authenticated
  using (consent_public or farmer_uid = (select auth.uid()));

create or replace function private.update_farmer_profile(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['farmer']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_name text := btrim(coalesce(private.opt_text(p, 'displayName', 80), ''));
  v_village text := btrim(coalesce(private.opt_text(p, 'village', 120), ''));
  v_region text := btrim(coalesce(private.opt_text(p, 'region', 120), ''));
  v_bio text := btrim(coalesce(private.opt_text(p, 'bio', 600), ''));
  v_bio_en text := btrim(coalesce(private.opt_text(p, 'bioEn', 600), ''));
  v_photo text := private.opt_text(p, 'photoPath', 200);
  v_years integer;
  v_consent boolean;
  v_row public.farmer_profiles;
begin
  if p ? 'yearsFarming' then
    if jsonb_typeof(p->'yearsFarming') <> 'number' then perform private.fail('invalid-argument', 'yearsFarming must be a number.'); end if;
    v_years := (p->>'yearsFarming')::numeric::integer;
  end if;
  if p ? 'consentPublic' then
    if jsonb_typeof(p->'consentPublic') <> 'boolean' then perform private.fail('invalid-argument', 'consentPublic must be a boolean.'); end if;
    v_consent := (p->>'consentPublic')::boolean;
  end if;
  if v_photo is not null and v_photo !~ ('^' || v_uid::text || '/profile/[A-Za-z0-9._-]{1,120}$') then
    perform private.fail('invalid-argument', 'Profile photo must be in your own profile folder.');
  end if;
  if v_consent and char_length(v_name) < 2 then
    perform private.fail('invalid-argument', 'A display name is required for a public profile.');
  end if;

  insert into public.farmer_profiles as fp (farmer_uid, display_name, village, region, years_farming, bio, bio_en, photo_path,
                                             consent_public, consent_at, consent_version, updated_at)
  values (v_uid, v_name, v_village, v_region, v_years, v_bio, v_bio_en, v_photo,
          coalesce(v_consent, false), case when v_consent then now() end, case when v_consent then 'farmer-public-v1' end, now())
  on conflict (farmer_uid) do update
     set display_name = excluded.display_name, village = excluded.village, region = excluded.region,
         years_farming = coalesce(excluded.years_farming, fp.years_farming), bio = excluded.bio, bio_en = excluded.bio_en,
         photo_path = coalesce(excluded.photo_path, fp.photo_path),
         consent_public = coalesce(v_consent, fp.consent_public),
         consent_at = case when v_consent is true and not fp.consent_public then now() else fp.consent_at end,
         consent_version = case when v_consent is true then 'farmer-public-v1' else fp.consent_version end,
         updated_at = now()
  returning * into v_row;
  perform private.audit(v_uid, case when v_consent is true then 'farmer_profile.published' when v_consent is false then 'farmer_profile.withdrawn' else 'farmer_profile.updated' end,
    'farmer_profiles/' || v_uid, jsonb_build_object('consentPublic', v_row.consent_public));
  return jsonb_build_object('displayName', v_row.display_name, 'village', v_row.village, 'region', v_row.region,
    'yearsFarming', v_row.years_farming, 'bio', v_row.bio, 'bioEn', v_row.bio_en, 'photoPath', v_row.photo_path,
    'consentPublic', v_row.consent_public);
end;
$$;

-- 3) review_farmer_update now records the source update on the public event (re-emitted from 20261026000300).
create or replace function private.review_farmer_update(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['quality_auditor']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_id uuid := private.req_uuid(p, 'updateId');
  v_decision text := coalesce(private.opt_text(p, 'decision', 10), 'publish');
  v_note text := private.parse_note(p);
  v_status text;
  v_upd public.farmer_updates;
begin
  if v_decision not in ('publish', 'reject') then
    perform private.fail('invalid-argument', 'Review request is invalid.');
  end if;
  v_status := case when v_decision = 'publish' then 'published' else 'rejected' end;

  select * into v_upd from public.farmer_updates where id = v_id for update;
  if not found or v_upd.status <> 'pending_review' then
    perform private.fail('failed-precondition', 'Field report is not pending review.');
  end if;
  perform private.assert_not_self_review(v_uid, v_upd.farmer_uid);

  update public.farmer_updates
     set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now()
   where id = v_id;
  if v_decision = 'publish' then
    insert into public.tree_events_public (tree_id, event_type, notes, media_count, event_date, status, update_id)
    values (v_upd.tree_id, v_upd.event_type, v_upd.notes, cardinality(v_upd.media_paths), v_upd.created_at, 'published', v_id);
  end if;
  perform private.audit(v_uid, 'farmer_update.' || v_status, 'farmer_updates/' || v_id,
    jsonb_build_object('treeId', v_upd.tree_id, 'farmerUid', v_upd.farmer_uid, 'note', v_note));
  perform private.notify_user(v_upd.farmer_uid, 'farmer_update_' || v_status, jsonb_build_object('treeId', v_upd.tree_id, 'eventType', v_upd.event_type, 'note', v_note));
  return jsonb_build_object('updateId', v_id, 'status', v_status);
end;
$$;

-- 4) Public tree profile (anon): tree + consented farmer + published events + last certified pressing.
create or replace function private.public_tree_profile(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tree_id text := private.req_id(coalesce(payload, '{}'::jsonb), 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_tree public.trees_public;
  v_farmer jsonb;
  v_events jsonb;
  v_pressing jsonb;
begin
  select * into v_tree from public.trees_public where tree_id = v_tree_id;
  if not found then
    perform private.fail('not-found', 'Tree not found.');
  end if;
  select jsonb_build_object('displayName', fp.display_name, 'village', fp.village, 'region', fp.region,
                            'yearsFarming', fp.years_farming, 'bio', fp.bio, 'bioEn', fp.bio_en, 'hasPhoto', fp.photo_path is not null)
    into v_farmer
    from public.farmer_assignments a
    join public.farmer_profiles fp on fp.farmer_uid = a.farmer_uid and fp.consent_public
   where a.tree_id = v_tree_id and a.revoked_at is null
   order by a.assigned_at desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'eventType', e.event_type, 'notes', e.notes, 'mediaCount', e.media_count,
                            'eventDate', private.epoch_ms(coalesce(e.event_date, e.created_at)), 'certificateSerial', e.certificate_serial,
                            'oilYieldLiters', e.oil_yield_liters, 'acidityPct', e.acidity_pct, 'peroxideValue', e.peroxide_value)
                  order by coalesce(e.event_date, e.created_at) desc), '[]'::jsonb)
    into v_events
    from (select * from public.tree_events_public where tree_id = v_tree_id and status = 'published'
           order by coalesce(event_date, created_at) desc limit 30) e;
  select jsonb_build_object('certificateSerial', e.certificate_serial, 'oilYieldLiters', e.oil_yield_liters,
                            'acidityPct', e.acidity_pct, 'peroxideValue', e.peroxide_value,
                            'certifiedAt', private.epoch_ms(e.created_at),
                            'extraVirgin', (e.acidity_pct <= 0.8 and e.peroxide_value <= 20))
    into v_pressing
    from public.tree_events_public e
   where e.tree_id = v_tree_id and e.event_type = 'pressing_certified' and e.status = 'published'
   order by e.created_at desc limit 1;
  return jsonb_build_object(
    'tree', jsonb_build_object('treeId', v_tree.tree_id, 'status', v_tree.status, 'name', v_tree.name, 'nameEn', v_tree.name_en,
      'region', v_tree.region, 'regionEn', v_tree.region_en, 'treeType', v_tree.tree_type, 'treeTypeEn', v_tree.tree_type_en,
      'plantedYear', v_tree.planted_year, 'estimatedAnnualYieldKg', v_tree.estimated_annual_yield_kg,
      'totalShares', v_tree.total_shares, 'availableShares', v_tree.available_shares,
      'pricePerShareMinor', v_tree.price_per_share_minor, 'landPriceMinor', v_tree.land_price_minor,
      'hasLandOption', v_tree.has_land_option, 'landAreaSqm', v_tree.land_area_sqm, 'currency', v_tree.currency, 'images', v_tree.images),
    'farmer', v_farmer,
    'events', v_events,
    'lastPressing', v_pressing,
    'stats', jsonb_build_object(
      'publishedEvents', (select count(*) from public.tree_events_public where tree_id = v_tree_id and status = 'published'),
      'certifiedPressings', (select count(*) from public.tree_events_public where tree_id = v_tree_id and event_type = 'pressing_certified' and status = 'published'))
  );
end;
$$;

-- 5) Media paths of published events (service_role only; the Edge Function signs them).
create or replace function private.tree_media_paths(p_tree_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object('eventId', e.id, 'paths', u.media_paths) order by e.created_at desc)
                          from public.tree_events_public e join public.farmer_updates u on u.id = e.update_id
                         where e.tree_id = p_tree_id and e.status = 'published' and u.status = 'published'
                           and cardinality(u.media_paths) > 0), '[]'::jsonb),
    'farmerPhoto', (select fp.photo_path from public.farmer_assignments a
                      join public.farmer_profiles fp on fp.farmer_uid = a.farmer_uid and fp.consent_public
                     where a.tree_id = p_tree_id and a.revoked_at is null order by a.assigned_at desc limit 1));
$$;

create or replace function public.update_farmer_profile(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.update_farmer_profile(payload); $$;
create or replace function public.public_tree_profile(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.public_tree_profile(payload); $$;
create or replace function public.tree_media_paths(p_tree_id text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.tree_media_paths(p_tree_id); $$;

revoke all on function private.update_farmer_profile(jsonb), private.public_tree_profile(jsonb), private.tree_media_paths(text),
  private.review_farmer_update(jsonb), public.update_farmer_profile(jsonb), public.public_tree_profile(jsonb), public.tree_media_paths(text)
  from public, anon, authenticated;
grant execute on function private.update_farmer_profile(jsonb), public.update_farmer_profile(jsonb), private.review_farmer_update(jsonb) to authenticated;
grant execute on function private.public_tree_profile(jsonb), public.public_tree_profile(jsonb) to anon, authenticated;
grant execute on function private.tree_media_paths(text), public.tree_media_paths(text) to service_role;

-- Farmers may upload a profile photo into <uid>/profile/ of the field-media bucket (same guard, one more folder).
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
     and (
       (storage.foldername(p_name))[2] = 'profile'
       or private.farmer_has_tree((select auth.uid()), (storage.foldername(p_name))[2])
     )
     and (select count(*) from storage.objects o
           where o.bucket_id = 'field-media'
             and o.name like (storage.foldername(p_name))[1] || '/' || (storage.foldername(p_name))[2] || '/%') < 30;
$$;

-- service_role resolves names in private for the SECURITY INVOKER wrapper (execute stays per function).
grant usage on schema private to service_role;
