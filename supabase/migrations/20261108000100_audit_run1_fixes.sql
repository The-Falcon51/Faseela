-- Faseela: fixes from security audit run-1 (2026-11-08). One migration, idempotent re-emits.
--  F1 (medium) account removal → see 20261108000110 (applied via SQL editor).
--  F2 (medium) review gate publishes content the auditor never saw → decision mandatory, media bound to
--             existing objects at publish time (the client now shows notes + photos; see data-mappers/app.js).
--  F3 (low)    anon SELECT on farmer_profiles → owner-only table reads; the public page uses the RPC.
--  F4 (low)    public_tree_profile / tree_media_paths ignore status='listed' → predicate re-applied.
--  L1 lead    suspension not enforced → require_user rejects banned users.
--  L2 lead    outbox has no per-recipient quota → 40 mails / recipient / hour, surplus skipped + counted.
--  L3 lead    Realtime removal events bypass RLS → publication limited to insert/update.
--  H  hardening: request_oil counts under the lock; helper grants revoked; cron.job_run_details pruned.

-- ---------------------------------------------------------------------------
-- L1: suspended accounts lose RPC access immediately (RLS reads stay owner-scoped; the JWT itself expires).
-- ---------------------------------------------------------------------------
create or replace function private.require_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    perform private.fail('unauthenticated', 'Sign in is required.');
  end if;
  if exists (select 1 from auth.users u where u.id = v_uid and u.banned_until is not null and u.banned_until > now()) then
    perform private.fail('permission-denied', 'This account is suspended.');
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- L2: per-recipient enqueue budget (transactional mail of other users must never wait behind one actor).
-- ---------------------------------------------------------------------------
create table if not exists private.email_skipped (
  hour_bucket timestamptz not null,
  recipient text not null,
  skipped integer not null default 0,
  primary key (hour_bucket, recipient)
);
revoke all on private.email_skipped from public, anon, authenticated;

create or replace function private.enqueue_email(p_recipient text, p_template text, p_params jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_per_hour constant integer := 40;
  v_recent integer;
begin
  if p_recipient is null or p_recipient !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return;
  end if;
  select count(*) into v_recent from private.email_outbox
   where recipient = p_recipient and created_at > now() - interval '1 hour';
  if v_recent >= c_per_hour then
    insert into private.email_skipped (hour_bucket, recipient, skipped)
    values (date_trunc('hour', now()), p_recipient, 1)
    on conflict (hour_bucket, recipient) do update set skipped = private.email_skipped.skipped + 1;
    return;
  end if;
  insert into private.email_outbox (recipient, template, params)
  values (p_recipient, p_template, coalesce(p_params, '{}'::jsonb));
end;
$$;
create index if not exists email_outbox_recipient_created_idx on private.email_outbox (recipient, created_at);

-- ---------------------------------------------------------------------------
-- L3: Realtime delivers INSERT/UPDATE under RLS; removal old-records cannot be policy-checked → not published.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime set (publish = 'insert, update');

-- ---------------------------------------------------------------------------
-- F3: farmer_profiles is readable by its owner only; visitors get the consented projection via public_tree_profile.
-- ---------------------------------------------------------------------------
revoke select on public.farmer_profiles from anon;
alter policy farmer_profiles_select on public.farmer_profiles to authenticated using (farmer_uid = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- F4: definer functions repeat the row policy (status = 'listed'); unlisted ids look like unknown ids.
-- ---------------------------------------------------------------------------
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
  select * into v_tree from public.trees_public where tree_id = v_tree_id and status = 'listed';
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

create or replace function private.tree_media_paths(p_tree_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object('eventId', e.id, 'paths', u.media_paths) order by e.created_at desc)
                          from public.tree_events_public e
                          join public.farmer_updates u on u.id = e.update_id
                          join public.trees_public t on t.tree_id = e.tree_id and t.status = 'listed'
                         where e.tree_id = p_tree_id and e.status = 'published' and u.status = 'published'
                           and cardinality(u.media_paths) > 0), '[]'::jsonb),
    'farmerPhoto', (select fp.photo_path from public.farmer_assignments a
                      join public.farmer_profiles fp on fp.farmer_uid = a.farmer_uid and fp.consent_public
                      join public.trees_public t on t.tree_id = a.tree_id and t.status = 'listed'
                     where a.tree_id = p_tree_id and a.revoked_at is null order by a.assigned_at desc limit 1));
$$;

-- ---------------------------------------------------------------------------
-- F2: the publish decision binds the content. decision is mandatory; media paths that have no object in the
--     private bucket at publish time are left out of the published report (nothing unseen can be signed later).
-- ---------------------------------------------------------------------------
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
  v_decision text := private.req_id(p, 'decision', '^(publish|reject)$');
  v_note text := private.parse_note(p);
  v_status text;
  v_upd public.farmer_updates;
  v_media text[];
begin
  v_status := case when v_decision = 'publish' then 'published' else 'rejected' end;

  select * into v_upd from public.farmer_updates where id = v_id for update;
  if not found or v_upd.status <> 'pending_review' then
    perform private.fail('failed-precondition', 'Field report is not pending review.');
  end if;
  perform private.assert_not_self_review(v_uid, v_upd.farmer_uid);

  -- Only objects that exist now (and were therefore reviewable) stay attached to the published report.
  select coalesce(array_agg(m.path order by m.ord), '{}')
    into v_media
    from unnest(v_upd.media_paths) with ordinality as m(path, ord)
   where exists (select 1 from storage.objects o where o.bucket_id = 'field-media' and o.name = m.path);

  update public.farmer_updates
     set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now(),
         media_paths = case when v_decision = 'publish' then v_media else media_paths end
   where id = v_id;
  if v_decision = 'publish' then
    insert into public.tree_events_public (tree_id, event_type, notes, media_count, event_date, status, update_id)
    values (v_upd.tree_id, v_upd.event_type, v_upd.notes, cardinality(v_media), v_upd.created_at, 'published', v_id);
  end if;
  perform private.audit(v_uid, 'farmer_update.' || v_status, 'farmer_updates/' || v_id,
    jsonb_build_object('treeId', v_upd.tree_id, 'farmerUid', v_upd.farmer_uid, 'note', v_note,
                       'mediaSubmitted', cardinality(v_upd.media_paths), 'mediaPublished', cardinality(v_media)));
  perform private.notify_user(v_upd.farmer_uid, 'farmer_update_' || v_status, jsonb_build_object('treeId', v_upd.tree_id, 'eventType', v_upd.event_type, 'note', v_note));
  return jsonb_build_object('updateId', v_id, 'status', v_status, 'mediaPublished', cardinality(v_media));
end;
$$;

-- ---------------------------------------------------------------------------
-- Hardening
-- ---------------------------------------------------------------------------
-- request_oil: the open-request count is read under the per-user lock (TOCTOU on the 3-open cap).
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

  insert into public.oil_requests (user_id, kind, liters_ml, allocation_count)
  values (v_uid, v_kind, v_ml, v_n) returning id into v_request_id;
  update public.oil_allocations set status = 'requested', request_id = v_request_id
   where id = any(v_ids) and user_id = v_uid and status = 'available';

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
  return jsonb_build_object('requestId', v_request_id, 'status', 'pending', 'litersMl', v_ml, 'kind', v_kind);
end;
$$;

-- Assignment helpers are only ever called from definer code; no direct execute for users.
revoke execute on function private.farmer_has_tree(uuid, text) from authenticated;
revoke execute on function private.operator_has_mill(uuid, text) from authenticated;


-- Privileges of everything (re)created here: deny-by-default, then the intended grants.
revoke all on function private.require_user(), private.enqueue_email(text, text, jsonb), private.public_tree_profile(jsonb),
  private.tree_media_paths(text), private.review_farmer_update(jsonb), private.request_oil(jsonb) from public, anon, authenticated;
grant execute on function private.public_tree_profile(jsonb) to anon, authenticated;
grant execute on function private.tree_media_paths(text) to service_role;
grant execute on function private.review_farmer_update(jsonb), private.request_oil(jsonb) to authenticated;
