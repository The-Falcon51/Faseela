-- Faseela business RPCs (port of the 18 Cloud Functions in legacy functions/index.js).
--
-- Layout: implementation = `private.<name>(payload jsonb)` SECURITY DEFINER with an empty
-- search_path; the Data API only sees the thin SECURITY INVOKER wrapper `public.<name>`.
-- Errors: SQLSTATE P0001, `message` = human text, `hint` = stable code
-- (unauthenticated | permission-denied | invalid-argument | not-found | already-exists |
--  failed-precondition | resource-exhausted). The client maps `hint` to `error.code`.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.fail(code text, msg text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = msg, hint = code;
end;
$$;

create function private.require_user()
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
  return v_uid;
end;
$$;

create function private.require_role(roles text[])
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
  return v_uid;
end;
$$;

create function private.require_verified_email(p_uid uuid, p_message text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from auth.users u where u.id = p_uid and u.email_confirmed_at is not null) then
    perform private.fail('failed-precondition', p_message);
  end if;
end;
$$;

-- Optional string field: null when absent/null, error when not a string or too long.
create function private.opt_text(p jsonb, p_key text, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > p_max then
    perform private.fail('invalid-argument', format('Field %s is invalid.', p_key));
  end if;
  return v #>> '{}';
end;
$$;

create function private.req_id(p jsonb, p_key text, p_pattern text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
begin
  if v is null or jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ p_pattern then
    perform private.fail('invalid-argument', format('Field %s is invalid.', p_key));
  end if;
  return v #>> '{}';
end;
$$;

create function private.req_uuid(p jsonb, p_key text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return private.req_id(p, p_key, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')::uuid;
end;
$$;

-- Finite JSON number (JSON cannot encode NaN/Infinity, so jsonb numbers are always finite).
create function private.req_number(p jsonb, p_key text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
begin
  if v is null or jsonb_typeof(v) <> 'number' then
    perform private.fail('invalid-argument', format('Field %s must be a number.', p_key));
  end if;
  return (v #>> '{}')::numeric;
end;
$$;

create function private.parse_note(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := private.opt_text(p, 'note', 500);
begin
  return coalesce(btrim(v), '');
end;
$$;

create function private.assert_not_self_review(p_reviewer uuid, p_owner uuid)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_reviewer is null or p_owner is null or p_reviewer = p_owner then
    perform private.fail('permission-denied', 'Reviewers cannot decide on their own submissions.');
  end if;
end;
$$;

create function private.audit(p_actor uuid, p_action text, p_target text, p_details jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (actor_uid, action, target, details)
  values (p_actor, p_action, p_target, coalesce(p_details, '{}'::jsonb));
$$;

create function private.epoch_ms(p timestamptz)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p is null then null else (extract(epoch from p) * 1000)::bigint end;
$$;

-- Keeps the public listing counter derived from the private inventory (single source of truth).
create function private.sync_available(p_tree_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.trees_public p
     set available_shares = t.total_shares - t.sold_shares - t.reserved_shares,
         updated_at = now()
    from private.trees t
   where t.tree_id = p.tree_id
     and p.tree_id = p_tree_id;
$$;

-- ---------------------------------------------------------------------------
-- New auth user -> profile (signUp has no session before e-mail confirmation).
-- user_metadata is used only as profile input, never for authorization.
-- ---------------------------------------------------------------------------
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role text := meta ->> 'requested_role';
begin
  insert into public.profiles (id, email, display_name, phone, region, requested_role)
  values (
    new.id,
    new.email,
    left(btrim(coalesce(meta ->> 'display_name', meta ->> 'full_name', meta ->> 'name', '')), 120),
    left(btrim(coalesce(meta ->> 'phone', '')), 40),
    left(btrim(coalesce(meta ->> 'region', '')), 120),
    case when v_role in ('farmer', 'mill_operator') then v_role else 'investor' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
-- The Auth server (supabase_auth_admin) inserts into auth.users and therefore fires the trigger.
grant usage on schema private to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Profiles & roles
-- ---------------------------------------------------------------------------
create function private.ensure_profile(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_display text := private.opt_text(p, 'displayName', 120);
  v_phone text := private.opt_text(p, 'phone', 40);
  v_region text := private.opt_text(p, 'region', 120);
  v_requested text := private.opt_text(p, 'requestedRole', 20);
  v_email text;
  v_profile public.profiles;
begin
  if v_requested is not null and v_requested not in ('investor', 'farmer', 'mill_operator') then
    perform private.fail('invalid-argument', 'Profile data is invalid.');
  end if;
  select u.email into v_email from auth.users u where u.id = v_uid;

  insert into public.profiles as pr (id, email, display_name, phone, region, requested_role)
  values (v_uid, v_email, coalesce(btrim(v_display), ''), coalesce(btrim(v_phone), ''),
          coalesce(btrim(v_region), ''), coalesce(v_requested, 'investor'))
  on conflict (id) do update
     set email = coalesce(excluded.email, pr.email),
         display_name = coalesce(btrim(v_display), pr.display_name),
         phone = coalesce(btrim(v_phone), pr.phone),
         region = coalesce(btrim(v_region), pr.region),
         requested_role = coalesce(v_requested, pr.requested_role),
         updated_at = now()
  returning * into v_profile;

  return jsonb_build_object(
    'uid', v_uid,
    'role', private.current_app_role(),
    'profile', jsonb_build_object(
      'uid', v_uid,
      'email', v_profile.email,
      'displayName', v_profile.display_name,
      'phone', v_profile.phone,
      'region', v_profile.region,
      'requestedRole', v_profile.requested_role,
      'role', private.current_app_role()
    )
  );
end;
$$;

create function private.submit_role_application(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_role text := private.opt_text(p, 'requestedRole', 20);
  v_region text := private.opt_text(p, 'region', 120);
  v_org text := coalesce(btrim(private.opt_text(p, 'organizationName', 160)), '');
  v_msg text := coalesce(btrim(private.opt_text(p, 'message', 1000)), '');
  v_existing public.role_applications;
begin
  perform private.require_verified_email(v_uid, 'Verify your email before requesting an operator role.');
  if v_role is null or v_role not in ('farmer', 'mill_operator')
     or v_region is null or char_length(btrim(v_region)) < 2 then
    perform private.fail('invalid-argument', 'Role application data is invalid.');
  end if;

  select * into v_existing from public.role_applications where user_id = v_uid for update;
  if found then
    if v_existing.status = 'pending' then
      return jsonb_build_object('status', 'pending', 'requestedRole', v_existing.requested_role);
    end if;
    if v_existing.status = 'approved' and v_existing.requested_role = v_role then
      return jsonb_build_object('status', 'approved', 'requestedRole', v_existing.requested_role);
    end if;
  end if;

  insert into public.role_applications (user_id, requested_role, region, organization_name, message, status,
                                        submitted_at, reviewed_at, reviewed_by_uid, review_note)
  values (v_uid, v_role, btrim(v_region), v_org, v_msg, 'pending', now(), null, null, '')
  on conflict (user_id) do update
     set requested_role = excluded.requested_role,
         region = excluded.region,
         organization_name = excluded.organization_name,
         message = excluded.message,
         status = 'pending',
         submitted_at = now(),
         reviewed_at = null,
         reviewed_by_uid = null,
         review_note = '';
  return jsonb_build_object('status', 'pending', 'requestedRole', v_role);
end;
$$;

create function private.review_role_application(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_target uuid := private.req_uuid(p, 'userId');
  v_decision text := private.req_id(p, 'decision', '^(approve|reject)$');
  v_note text := private.parse_note(p);
  v_status text := case when v_decision = 'approve' then 'approved' else 'rejected' end;
  v_app public.role_applications;
begin
  perform private.assert_not_self_review(v_uid, v_target);
  select * into v_app from public.role_applications where user_id = v_target for update;
  if not found or v_app.status <> 'pending' then
    perform private.fail('failed-precondition', 'Role application is not pending.');
  end if;

  update public.role_applications
     set status = v_status, reviewed_by_uid = v_uid, review_note = v_note, reviewed_at = now()
   where user_id = v_target;

  -- Role grant and decision commit atomically (no separate claims step to roll back).
  if v_decision = 'approve' then
    insert into private.user_roles (user_id, role, granted_by, granted_at)
    values (v_target, v_app.requested_role, v_uid, now())
    on conflict (user_id) do update
       set role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at;
  end if;

  perform private.audit(v_uid, 'role_application.' || v_status, 'role_applications/' || v_target,
    jsonb_build_object('userId', v_target, 'requestedRole', v_app.requested_role, 'note', v_note));
  return jsonb_build_object('userId', v_target, 'status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Investments
-- ---------------------------------------------------------------------------
create function private.create_investment_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Reservation policy (review F-03): open = awaiting_payment | under_review.
  c_max_open_requests constant integer := 3;
  c_max_open_shares constant integer := 8;
  c_ttl constant interval := interval '30 minutes';
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree_id text;
  v_share_count integer;
  v_includes_land boolean := false;
  v_key text;
  v_request_id text;
  v_existing public.investment_requests;
  v_tree private.trees;
  v_has_land boolean;
  v_open_count integer;
  v_open_shares integer;
  v_available integer;
  v_amount bigint;
  v_expires timestamptz;
begin
  perform private.require_verified_email(v_uid, 'Verify your email before requesting an investment.');

  v_tree_id := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  -- Nested checks: never cast before the JSON type is known (NULL-safe, no cast errors).
  if jsonb_typeof(p -> 'shareCount') is distinct from 'number' then
    perform private.fail('invalid-argument', 'Share count must be between 1 and 1000.');
  end if;
  if (p ->> 'shareCount')::numeric <> trunc((p ->> 'shareCount')::numeric)
     or (p ->> 'shareCount')::numeric not between 1 and 1000 then
    perform private.fail('invalid-argument', 'Share count must be between 1 and 1000.');
  end if;
  v_share_count := (p ->> 'shareCount')::integer;
  if p ? 'includesLand' then
    if jsonb_typeof(p -> 'includesLand') <> 'boolean' then
      perform private.fail('invalid-argument', 'includesLand must be a boolean.');
    end if;
    v_includes_land := (p ->> 'includesLand')::boolean;
  end if;
  if jsonb_typeof(p -> 'idempotencyKey') is distinct from 'string'
     or char_length(p ->> 'idempotencyKey') not between 16 and 120 then
    perform private.fail('invalid-argument', 'A valid idempotency key is required.');
  end if;
  v_key := p ->> 'idempotencyKey';

  -- Deterministic id: same user + key always maps to one request (safe client retries).
  v_request_id := encode(sha256(convert_to(v_uid::text || ':' || v_key, 'UTF8')), 'hex');

  -- Serialize all reservations of this user so the quota check cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('faseela:reserve:' || v_uid::text, 0));

  select * into v_existing from public.investment_requests where id = v_request_id;
  if found then
    if v_existing.user_id <> v_uid then
      perform private.fail('permission-denied', 'Request key is already in use.');
    end if;
    return jsonb_build_object('requestId', v_existing.id, 'status', v_existing.status,
      'amountMinor', v_existing.amount_minor, 'expiresAt', private.epoch_ms(v_existing.expires_at));
  end if;

  select pt.has_land_option into v_has_land
    from public.trees_public pt
   where pt.tree_id = v_tree_id and pt.status = 'listed';
  if not found then
    perform private.fail('not-found', 'This tree is not currently available.');
  end if;
  -- Row lock on the inventory serializes concurrent reservations of the same tree.
  select t.* into v_tree from private.trees t where t.tree_id = v_tree_id for update;
  if not found then
    perform private.fail('not-found', 'This tree is not currently available.');
  end if;

  if exists (select 1 from public.investment_requests
              where user_id = v_uid and status in ('awaiting_payment', 'under_review') and tree_id = v_tree_id) then
    perform private.fail('already-exists', 'You already have an open request for this tree. Complete or cancel it first.');
  end if;
  select count(*), coalesce(sum(share_count), 0) into v_open_count, v_open_shares
    from public.investment_requests
   where user_id = v_uid and status in ('awaiting_payment', 'under_review');
  if v_open_count >= c_max_open_requests then
    perform private.fail('resource-exhausted', 'Too many open investment requests. Complete or cancel one first.');
  end if;
  if v_open_shares + v_share_count > c_max_open_shares then
    perform private.fail('resource-exhausted', 'This request exceeds the number of shares you can reserve at once.');
  end if;

  v_available := v_tree.total_shares - v_tree.sold_shares - v_tree.reserved_shares;
  if v_share_count > v_available then
    perform private.fail('failed-precondition', 'Not enough shares are available.');
  end if;
  if v_share_count > v_tree.total_shares then
    perform private.fail('invalid-argument', 'Requested shares exceed the tree total.');
  end if;
  if v_includes_land and (not v_has_land or v_share_count <> v_tree.total_shares) then
    perform private.fail('failed-precondition', 'Land can currently be reserved only with a complete tree.');
  end if;

  v_amount := v_share_count::bigint * v_tree.price_per_share_minor
              + case when v_includes_land then v_tree.land_price_minor else 0 end;
  v_expires := now() + c_ttl;

  update private.trees set reserved_shares = reserved_shares + v_share_count, updated_at = now()
   where tree_id = v_tree_id;
  perform private.sync_available(v_tree_id);

  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor,
                                          currency, status, expires_at)
  values (v_request_id, v_uid, v_tree_id, v_share_count, v_includes_land, v_amount,
          v_tree.currency, 'awaiting_payment', v_expires);
  insert into public.transactions (id, request_id, user_id, type, amount_minor, currency, status)
  values (v_request_id, v_request_id, v_uid, 'share_purchase', v_amount, v_tree.currency, 'pending');

  return jsonb_build_object('requestId', v_request_id, 'status', 'awaiting_payment',
    'amountMinor', v_amount, 'expiresAt', private.epoch_ms(v_expires));
end;
$$;

-- Releases a reservation that is still held for a request (inside the caller's transaction).
create function private.release_reservation(p_tree_id text, p_share_count integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.trees
     set reserved_shares = reserved_shares - p_share_count, updated_at = now()
   where tree_id = p_tree_id and reserved_shares >= p_share_count;
  perform private.sync_available(p_tree_id);
end;
$$;

create function private.cancel_investment_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_request_id text := private.req_id(coalesce(payload, '{}'::jsonb), 'requestId', '^[a-f0-9]{64}$');
  v_req public.investment_requests;
begin
  select * into v_req from public.investment_requests where id = v_request_id and user_id = v_uid for update;
  if not found then
    perform private.fail('not-found', 'Investment request was not found.');
  end if;
  if v_req.status <> 'awaiting_payment' then
    perform private.fail('failed-precondition', 'Only requests awaiting payment can be cancelled.');
  end if;
  perform 1 from private.trees where tree_id = v_req.tree_id for update;
  perform private.release_reservation(v_req.tree_id, v_req.share_count);
  update public.investment_requests set status = 'cancelled', updated_at = now() where id = v_request_id;
  update public.transactions set status = 'cancelled', updated_at = now() where id = v_request_id;
  return jsonb_build_object('requestId', v_request_id, 'status', 'cancelled');
end;
$$;

create function private.submit_investment_payment_proof(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_request_id text := private.req_id(p, 'requestId', '^[a-f0-9]{64}$');
  v_path text := private.req_id(p, 'storagePath', '^[A-Za-z0-9._/-]{1,240}$');
  v_req public.investment_requests;
begin
  -- Object name inside bucket `payment-proofs`: {uid}/{requestId}/{file}
  if v_path not like v_uid::text || '/' || v_request_id || '/%'
     or position('..' in v_path) > 0
     or v_path !~ '^[0-9a-f-]{36}/[a-f0-9]{64}/[A-Za-z0-9._-]{1,120}$' then
    perform private.fail('invalid-argument', 'Payment proof reference is invalid.');
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'payment-proofs'
       and o.name = v_path
       and o.owner_id = v_uid::text
       and o.metadata ->> 'mimetype' in ('image/jpeg', 'image/png', 'application/pdf')
       and coalesce(o.is_delete_marker, false) = false
  ) then
    perform private.fail('failed-precondition', 'Upload a supported payment receipt first.');
  end if;

  select * into v_req from public.investment_requests where id = v_request_id and user_id = v_uid for update;
  if not found then
    perform private.fail('not-found', 'Investment request was not found.');
  end if;
  if v_req.status <> 'awaiting_payment' or v_req.expires_at <= now() then
    perform private.fail('failed-precondition', 'This payment request has expired or was already submitted.');
  end if;

  update public.investment_requests
     set status = 'under_review', payment_proof_path = v_path, proof_submitted_at = now(), updated_at = now()
   where id = v_request_id;
  update public.transactions set status = 'under_review', updated_at = now() where id = v_request_id;
  return jsonb_build_object('requestId', v_request_id, 'status', 'under_review');
end;
$$;

create function private.review_investment_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_request_id text := private.req_id(p, 'requestId', '^[a-f0-9]{64}$');
  v_decision text := private.req_id(p, 'decision', '^(approve|reject)$');
  v_note text := private.parse_note(p);
  v_status text := case when v_decision = 'approve' then 'approved' else 'rejected' end;
  v_req public.investment_requests;
  v_reserved integer;
begin
  select * into v_req from public.investment_requests where id = v_request_id for update;
  if not found then
    perform private.fail('not-found', 'Investment request was not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_req.user_id);
  if v_req.status <> 'under_review' then
    perform private.fail('failed-precondition', 'Only reviewed payment requests can be decided.');
  end if;
  if exists (select 1 from public.shares where id = v_request_id) then
    perform private.fail('already-exists', 'A share record already exists for this request.');
  end if;

  select reserved_shares into v_reserved from private.trees where tree_id = v_req.tree_id for update;
  if not found or v_reserved < v_req.share_count then
    perform private.fail('failed-precondition', 'Reserved inventory is inconsistent.');
  end if;

  update private.trees
     set reserved_shares = reserved_shares - v_req.share_count,
         sold_shares = sold_shares + case when v_decision = 'approve' then v_req.share_count else 0 end,
         updated_at = now()
   where tree_id = v_req.tree_id;
  perform private.sync_available(v_req.tree_id);

  update public.investment_requests
     set status = v_status, reviewed_by_uid = v_uid, review_note = v_note, reviewed_at = now(), updated_at = now()
   where id = v_request_id;
  update public.transactions
     set status = case when v_decision = 'approve' then 'settled' else 'rejected' end,
         reviewed_by_uid = v_uid, reviewed_at = now(), updated_at = now()
   where id = v_request_id;

  if v_decision = 'approve' then
    insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land,
                               purchase_price_minor, currency, status)
    values (v_request_id, v_request_id, v_req.user_id, v_req.tree_id, v_req.share_count, v_req.includes_land,
            v_req.amount_minor, v_req.currency, 'active');
  end if;

  perform private.audit(v_uid, 'investment_request.' || v_status, 'investment_requests/' || v_request_id,
    jsonb_build_object('userId', v_req.user_id, 'treeId', v_req.tree_id, 'shareCount', v_req.share_count,
                       'amountMinor', v_req.amount_minor, 'note', v_note));
  return jsonb_build_object('requestId', v_request_id, 'status', v_status);
end;
$$;

-- Scheduled (pg_cron, every 10 min): release expired reservations.
create function private.expire_investment_requests()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req record;
  v_count integer := 0;
begin
  for v_req in
    select id, tree_id, share_count from public.investment_requests
     where status = 'awaiting_payment' and expires_at <= now()
     order by expires_at
     limit 100
     for update skip locked
  loop
    perform 1 from private.trees where tree_id = v_req.tree_id for update;
    perform private.release_reservation(v_req.tree_id, v_req.share_count);
    update public.investment_requests set status = 'expired', updated_at = now() where id = v_req.id;
    update public.transactions set status = 'expired', updated_at = now() where id = v_req.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Scheduled (pg_cron, every 6 h): flag finance reviews older than the 72 h SLA (review F-17).
create function private.flag_overdue_reviews()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req record;
  v_count integer := 0;
begin
  for v_req in
    update public.investment_requests
       set sla_breached = true, sla_breached_at = now()
     where status = 'under_review'
       and sla_breached = false
       and proof_submitted_at <= now() - interval '72 hours'
    returning id, tree_id, share_count
  loop
    perform private.audit(null, 'investment_request.review_sla_breached', 'investment_requests/' || v_req.id,
      jsonb_build_object('treeId', v_req.tree_id, 'shareCount', v_req.share_count));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Interim privilege set (completed in 20261020000300): nothing in `private` is callable by clients yet.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_app_role(), private.has_any_role(text[]) to authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin;
