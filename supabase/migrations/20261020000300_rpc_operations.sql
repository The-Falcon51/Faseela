-- Faseela RPCs part 2: field operations, reviewer queues, admin directory, DSGVO self-service,
-- operator helpers, Data API wrappers and the final privilege set. Conventions: see 20261020000200.

-- ---------------------------------------------------------------------------
-- Field operations
-- ---------------------------------------------------------------------------
create function private.submit_farmer_update(payload jsonb)
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

  if not exists (select 1 from public.farmer_assignments where farmer_uid = v_uid and tree_id = v_tree_id) then
    perform private.fail('permission-denied', 'Tree is not assigned to this farmer.');
  end if;

  insert into public.farmer_updates (farmer_uid, tree_id, event_type, notes, media_paths, gps_lat, gps_lng, status)
  values (v_uid, v_tree_id, v_event, v_notes, v_media, v_lat, v_lng, 'pending_review')
  returning id into v_id;
  return jsonb_build_object('updateId', v_id, 'status', 'pending_review');
end;
$$;

create function private.review_farmer_update(payload jsonb)
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
  v_status text := case when v_decision = 'publish' then 'published' else 'rejected' end;
  v_upd public.farmer_updates;
begin
  select * into v_upd from public.farmer_updates where id = v_id for update;
  if not found or v_upd.status <> 'pending_review' then
    perform private.fail('failed-precondition', 'Farmer update is not pending review.');
  end if;
  perform private.assert_not_self_review(v_uid, v_upd.farmer_uid);

  update public.farmer_updates
     set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now()
   where id = v_id;
  if v_decision = 'publish' then
    -- Media stays private in Storage; only the count is published.
    insert into public.tree_events_public (tree_id, event_type, notes, media_count, event_date, status)
    values (v_upd.tree_id, v_upd.event_type, v_upd.notes, cardinality(v_upd.media_paths), v_upd.created_at, 'published');
  end if;
  perform private.audit(v_uid, 'farmer_update.' || v_status, 'farmer_updates/' || v_id,
    jsonb_build_object('treeId', v_upd.tree_id, 'farmerUid', v_upd.farmer_uid, 'note', v_note));
  return jsonb_build_object('updateId', v_id, 'status', v_status);
end;
$$;

create function private.submit_pressing_batch(payload jsonb)
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
  if not exists (select 1 from public.mill_assignments where operator_uid = v_uid and mill_id = v_mill_id) then
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

create function private.certify_pressing_batch(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['quality_auditor']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_id uuid := private.req_uuid(p, 'batchId');
  v_decision text := coalesce(private.opt_text(p, 'decision', 10), 'certify');
  v_serial text := private.opt_text(p, 'certificateSerial', 120);
  v_note text := private.parse_note(p);
  v_status text;
  v_batch public.pressing_batches;
begin
  if v_decision not in ('certify', 'reject') then
    perform private.fail('invalid-argument', 'Batch review request is invalid.');
  end if;
  if v_decision = 'certify' and (v_serial is null or v_serial !~ '^[A-Za-z0-9_-]{1,120}$') then
    perform private.fail('invalid-argument', 'A certificate serial is required to certify a batch.');
  end if;
  if v_decision = 'reject' then
    v_serial := null;
  end if;
  v_status := case when v_decision = 'certify' then 'certified' else 'rejected' end;

  select * into v_batch from public.pressing_batches where id = v_id for update;
  if not found or v_batch.status <> 'pending_review' then
    perform private.fail('failed-precondition', 'Pressing batch is not pending review.');
  end if;
  perform private.assert_not_self_review(v_uid, v_batch.submitted_by_uid);

  update public.pressing_batches
     set status = v_status, certificate_serial = v_serial, review_note = v_note,
         certified_by_uid = v_uid, certified_at = now()
   where id = v_id;
  if v_decision = 'certify' then
    insert into public.tree_events_public (tree_id, event_type, batch_id, certificate_serial, oil_yield_liters,
                                           acidity_pct, peroxide_value, status)
    values (v_batch.tree_id, 'pressing_certified', v_id, v_serial, v_batch.oil_yield_liters,
            v_batch.acidity_pct, v_batch.peroxide_value, 'published');
  end if;
  perform private.audit(v_uid, 'pressing_batch.' || v_status, 'pressing_batches/' || v_id,
    jsonb_build_object('treeId', v_batch.tree_id, 'millId', v_batch.mill_id, 'certificateSerial', v_serial, 'note', v_note));
  return jsonb_build_object('batchId', v_id, 'status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reviewer queues (oldest first, max 100, with submitter contact for reviewers only)
-- ---------------------------------------------------------------------------
create function private.list_review_queue(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue text := private.req_id(coalesce(payload, '{}'::jsonb), 'queue',
    '^(payments|farmer_updates|pressing_batches|role_applications)$');
  v_items jsonb;
begin
  if v_queue = 'payments' then
    perform private.require_role(array['finance_admin']);
    select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('submitter', private.submitter(r.user_id))
                              order by r.proof_submitted_at), '[]'::jsonb)
      into v_items
      from (select * from public.investment_requests where status = 'under_review'
             order by proof_submitted_at limit 100) r;
  elsif v_queue = 'farmer_updates' then
    perform private.require_role(array['quality_auditor']);
    select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('submitter', private.submitter(r.farmer_uid))
                              order by r.created_at), '[]'::jsonb)
      into v_items
      from (select * from public.farmer_updates where status = 'pending_review'
             order by created_at limit 100) r;
  elsif v_queue = 'pressing_batches' then
    perform private.require_role(array['quality_auditor']);
    select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('submitter', private.submitter(r.submitted_by_uid))
                              order by r.created_at), '[]'::jsonb)
      into v_items
      from (select * from public.pressing_batches where status = 'pending_review'
             order by created_at limit 100) r;
  else
    perform private.require_role('{}'::text[]);
    select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('id', r.user_id, 'submitter', private.submitter(r.user_id))
                              order by r.submitted_at), '[]'::jsonb)
      into v_items
      from (select * from public.role_applications where status = 'pending'
             order by submitted_at limit 100) r;
  end if;
  return jsonb_build_object('queue', v_queue, 'items', v_items);
end;
$$;

create function private.submitter(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (select jsonb_build_object('displayName', pr.display_name, 'email', coalesce(pr.email, ''))
            from public.profiles pr where pr.id = p_uid);
$$;

-- ---------------------------------------------------------------------------
-- Admin: user directory (minimal fields)
-- ---------------------------------------------------------------------------
create function private.admin_list_users(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users jsonb;
begin
  perform private.require_role('{}'::text[]);
  select coalesce(jsonb_agg(jsonb_build_object(
           'uid', u.id,
           'displayName', coalesce(pr.display_name, ''),
           'email', coalesce(pr.email, u.email, ''),
           'phone', coalesce(pr.phone, ''),
           'region', coalesce(pr.region, ''),
           'role', coalesce(r.role, 'investor'),
           'emailVerified', u.email_confirmed_at is not null,
           'disabled', coalesce(u.banned_until > now(), false),
           'createdAt', private.epoch_ms(u.created_at)
         ) order by u.created_at), '[]'::jsonb)
    into v_users
    from (select * from auth.users order by created_at limit 500) u
    left join public.profiles pr on pr.id = u.id
    left join private.user_roles r on r.user_id = u.id;
  return jsonb_build_object('users', v_users);
end;
$$;

-- ---------------------------------------------------------------------------
-- DSGVO self-service: export (Art. 15/20) and deletion (Art. 17)
-- ---------------------------------------------------------------------------
create function private.export_my_data(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.audit(v_uid, 'account.exported', 'profiles/' || v_uid, '{}'::jsonb);
  return jsonb_build_object(
    'exportedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'format', 'faseela-data-export/v2',
    'role', private.current_app_role(),
    'profile', (select to_jsonb(pr) from public.profiles pr where pr.id = v_uid),
    'roleApplication', (select to_jsonb(ra) from public.role_applications ra where ra.user_id = v_uid),
    'investmentRequests', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.investment_requests x where x.user_id = v_uid), '[]'::jsonb),
    'transactions', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.transactions x where x.user_id = v_uid), '[]'::jsonb),
    'shares', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.shares x where x.user_id = v_uid), '[]'::jsonb),
    'farmerUpdates', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.farmer_updates x where x.farmer_uid = v_uid), '[]'::jsonb),
    'pressingBatches', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.pressing_batches x where x.submitted_by_uid = v_uid), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator-only helpers (SQL editor / service role; never callable by clients)
-- ---------------------------------------------------------------------------
create function private.admin_assign_farmer(p_email text, p_tree_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then perform private.fail('not-found', 'No user with this e-mail.'); end if;
  insert into public.farmer_assignments (farmer_uid, tree_id) values (v_uid, p_tree_id)
  on conflict do nothing;
  perform private.audit(null, 'farmer.assigned', 'farmer_assignments/' || v_uid || '/' || p_tree_id, '{}'::jsonb);
end;
$$;

create function private.admin_assign_mill(p_email text, p_mill_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then perform private.fail('not-found', 'No user with this e-mail.'); end if;
  insert into public.mill_assignments (operator_uid, mill_id) values (v_uid, p_mill_id)
  on conflict do nothing;
  perform private.audit(null, 'mill.assigned', 'mill_assignments/' || v_uid || '/' || p_mill_id, '{}'::jsonb);
end;
$$;

-- Interim privilege set (completed in 20261020000400).
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_app_role(), private.has_any_role(text[]) to authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin;
