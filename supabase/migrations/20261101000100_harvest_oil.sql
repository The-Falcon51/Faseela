-- Harvest & oil allocation: closes the investor loop (share -> tree -> certified pressing -> oil).
--  * On certification of a pressing batch every active share of the tree receives its pro-rata oil (ml).
--  * Investors bundle available allocations into one request: delivery, pickup at the mill, or donation.
--  * Contact data (name, phone, address) is PII: stored only in private.oil_request_contacts, encrypted
--    with pgp_sym_encrypt and a key held in Supabase Vault (never in a client, never in public).
--  * Finance reviews requests in the approvals desk (four-eyes, audit log) and marks them fulfilled.
-- No DELETE anywhere; rejected requests release their allocations.

-- ---------------------------------------------------------------------------
-- Encryption key for PII at rest (application-level, on top of disk encryption)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'pii_key') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'pii_key', 'Faseela: pgp_sym_encrypt key for contact data');
  end if;
end $$;

create or replace function private.pii_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'pii_key' limit 1; $$;
revoke all on function private.pii_key() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.oil_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.pressing_batches (id),
  tree_id text not null references public.trees_public (tree_id),
  user_id uuid not null,
  share_id text not null references public.shares (id),
  share_count integer not null check (share_count > 0),
  liters_ml integer not null check (liters_ml >= 0),
  season_year integer not null,
  certificate_serial text,
  status text not null default 'available' check (status in ('available', 'requested', 'fulfilled')),
  request_id uuid,
  created_at timestamptz not null default now(),
  unique (batch_id, share_id)
);
create index if not exists oil_allocations_user_status_idx on public.oil_allocations (user_id, status);
create index if not exists oil_allocations_request_idx on public.oil_allocations (request_id);

create table if not exists public.oil_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('delivery', 'pickup', 'donate')),
  liters_ml integer not null check (liters_ml > 0),
  allocation_count integer not null check (allocation_count > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'fulfilled', 'rejected', 'cancelled')),
  review_note text not null default '' check (char_length(review_note) <= 500),
  reviewed_by_uid uuid,
  reviewed_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oil_requests_user_idx on public.oil_requests (user_id, created_at desc);
create index if not exists oil_requests_status_idx on public.oil_requests (status, created_at);

alter table public.oil_allocations add constraint oil_allocations_request_fk
  foreign key (request_id) references public.oil_requests (id) deferrable initially deferred;

create table if not exists private.oil_request_contacts (
  request_id uuid primary key references public.oil_requests (id),
  contact_enc bytea not null,
  created_at timestamptz not null default now()
);

alter table public.oil_allocations enable row level security;
alter table public.oil_requests enable row level security;
alter table private.oil_request_contacts enable row level security;
revoke all on public.oil_allocations, public.oil_requests from public, anon, authenticated;
revoke all on private.oil_request_contacts from public, anon, authenticated;
grant select on public.oil_allocations, public.oil_requests to authenticated;

create policy oil_allocations_select on public.oil_allocations for select to authenticated
  using (user_id = (select auth.uid()) or private.has_any_role(array['finance_admin', 'quality_auditor']));
create policy oil_requests_select on public.oil_requests for select to authenticated
  using (user_id = (select auth.uid()) or private.has_any_role(array['finance_admin']));

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'oil_allocations') then
    alter publication supabase_realtime add table public.oil_allocations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'oil_requests') then
    alter publication supabase_realtime add table public.oil_requests;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Allocation on certification (called from certify_pressing_batch, same transaction)
-- Pro-rata by share_count over the tree's total shares; unsold shares stay with the platform.
-- ---------------------------------------------------------------------------
create or replace function private.allocate_oil(p_batch public.pressing_batches, p_serial text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_count integer := 0;
  v_share record;
  v_ml integer;
begin
  select total_shares into v_total from private.trees where tree_id = p_batch.tree_id;
  if v_total is null or v_total <= 0 then
    return 0;
  end if;
  for v_share in
    select id, user_id, share_count from public.shares
     where tree_id = p_batch.tree_id and status = 'active'
     order by created_at
  loop
    v_ml := floor(p_batch.oil_yield_liters * 1000 * v_share.share_count / v_total)::integer;
    insert into public.oil_allocations (batch_id, tree_id, user_id, share_id, share_count, liters_ml, season_year, certificate_serial)
    values (p_batch.id, p_batch.tree_id, v_share.user_id, v_share.id, v_share.share_count, v_ml, p_batch.season_year, p_serial)
    on conflict (batch_id, share_id) do nothing;
    if found then
      v_count := v_count + 1;
      perform private.notify_user(v_share.user_id, 'oil_allocated', jsonb_build_object(
        'treeId', p_batch.tree_id, 'litersMl', v_ml, 'seasonYear', p_batch.season_year, 'certificateSerial', p_serial));
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function private.certify_pressing_batch(payload jsonb)
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
  v_allocated integer := 0;
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
    v_allocated := private.allocate_oil(v_batch, v_serial);
  end if;
  perform private.audit(v_uid, 'pressing_batch.' || v_status, 'pressing_batches/' || v_id,
    jsonb_build_object('treeId', v_batch.tree_id, 'millId', v_batch.mill_id, 'certificateSerial', v_serial, 'note', v_note,
                       'allocations', v_allocated));
  perform private.notify_user(v_batch.submitted_by_uid, 'batch_' || v_status, jsonb_build_object('batchId', v_id, 'treeId', v_batch.tree_id, 'certificateSerial', v_serial, 'note', v_note));
  return jsonb_build_object('batchId', v_id, 'status', v_status, 'allocations', v_allocated);
end;
$$;

-- ---------------------------------------------------------------------------
-- request_oil: {allocationIds: uuid[], kind: delivery|pickup|donate, contact: {...}}
-- ---------------------------------------------------------------------------
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

  -- One open request at a time keeps the review queue unambiguous.
  select count(*) into v_open from public.oil_requests where user_id = v_uid and status in ('pending', 'approved');
  if v_open >= 3 then
    perform private.fail('resource-exhausted', 'Too many open oil requests. Wait for the current ones to be processed.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('faseela:oil:' || v_uid::text, 0));
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

-- ---------------------------------------------------------------------------
-- cancel_oil_request (owner, pending only) — releases the allocations
-- ---------------------------------------------------------------------------
create or replace function private.cancel_oil_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id uuid := private.req_uuid(coalesce(payload, '{}'::jsonb), 'requestId');
  v_req public.oil_requests;
begin
  select * into v_req from public.oil_requests where id = v_id and user_id = v_uid for update;
  if not found then
    perform private.fail('not-found', 'Oil request not found.');
  end if;
  if v_req.status <> 'pending' then
    perform private.fail('failed-precondition', 'Only pending requests can be cancelled.');
  end if;
  update public.oil_requests set status = 'cancelled' where id = v_id;
  update public.oil_allocations set status = 'available', request_id = null where request_id = v_id;
  perform private.audit(v_uid, 'oil_request.cancelled', 'oil_requests/' || v_id, '{}'::jsonb);
  return jsonb_build_object('requestId', v_id, 'status', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------------
-- review_oil_request (finance_admin / admin): approve | reject | fulfil
-- ---------------------------------------------------------------------------
create or replace function private.review_oil_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_id uuid := private.req_uuid(p, 'requestId');
  v_decision text := private.opt_text(p, 'decision', 10);
  v_note text := private.parse_note(p);
  v_req public.oil_requests;
  v_status text;
begin
  if v_decision is null or v_decision not in ('approve', 'reject', 'fulfil') then
    perform private.fail('invalid-argument', 'Decision is invalid.');
  end if;
  if v_decision = 'reject' and char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A rejection needs a note.');
  end if;
  select * into v_req from public.oil_requests where id = v_id for update;
  if not found then
    perform private.fail('not-found', 'Oil request not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_req.user_id);

  if v_decision = 'approve' then
    if v_req.status <> 'pending' then perform private.fail('failed-precondition', 'Request is not pending.'); end if;
    v_status := 'approved';
    update public.oil_requests set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now() where id = v_id;
  elsif v_decision = 'fulfil' then
    if v_req.status not in ('pending', 'approved') then perform private.fail('failed-precondition', 'Request is not open.'); end if;
    v_status := 'fulfilled';
    update public.oil_requests set status = v_status, review_note = coalesce(nullif(v_note, ''), review_note),
           reviewed_by_uid = coalesce(reviewed_by_uid, v_uid), reviewed_at = coalesce(reviewed_at, now()), fulfilled_at = now()
     where id = v_id;
    update public.oil_allocations set status = 'fulfilled' where request_id = v_id;
  else
    if v_req.status not in ('pending', 'approved') then perform private.fail('failed-precondition', 'Request is not open.'); end if;
    v_status := 'rejected';
    update public.oil_requests set status = v_status, review_note = v_note, reviewed_by_uid = v_uid, reviewed_at = now() where id = v_id;
    update public.oil_allocations set status = 'available', request_id = null where request_id = v_id;
  end if;

  perform private.audit(v_uid, 'oil_request.' || v_status, 'oil_requests/' || v_id,
    jsonb_build_object('kind', v_req.kind, 'litersMl', v_req.liters_ml, 'note', v_note));
  perform private.notify_user(v_req.user_id, 'oil_request_' || v_status, jsonb_build_object(
    'requestId', v_id, 'kind', v_req.kind, 'litersMl', v_req.liters_ml, 'note', v_note));
  return jsonb_build_object('requestId', v_id, 'status', v_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- list_review_queue: + oil_requests (pending) and oil_fulfilment (approved), finance only.
-- Contact data is decrypted here and only here; never stored in the response tables.
-- ---------------------------------------------------------------------------
create or replace function private.oil_contact(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(extensions.pgp_sym_decrypt(c.contact_enc, private.pii_key())::jsonb, '{}'::jsonb)
    from private.oil_request_contacts c where c.request_id = p_request_id;
$$;
revoke all on function private.oil_contact(uuid) from public, anon, authenticated;

create or replace function private.list_review_queue(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue text := private.req_id(coalesce(payload, '{}'::jsonb), 'queue',
    '^(payments|farmer_updates|pressing_batches|role_applications|oil_requests|oil_fulfilment)$');
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
  elsif v_queue in ('oil_requests', 'oil_fulfilment') then
    perform private.require_role(array['finance_admin']);
    select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('submitter', private.submitter(r.user_id),
                                                               'contact', private.oil_contact(r.id))
                              order by r.created_at), '[]'::jsonb)
      into v_items
      from (select * from public.oil_requests
             where status = case when v_queue = 'oil_requests' then 'pending' else 'approved' end
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

-- ---------------------------------------------------------------------------
-- export_my_data: include oil allocations and requests (DSGVO Art. 15/20)
-- ---------------------------------------------------------------------------
create or replace function private.export_my_oil()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'oilAllocations', coalesce((select jsonb_agg(to_jsonb(a)) from public.oil_allocations a where a.user_id = (select auth.uid())), '[]'::jsonb),
    'oilRequests', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('contact', private.oil_contact(r.id)))
                               from public.oil_requests r where r.user_id = (select auth.uid())), '[]'::jsonb));
$$;
revoke all on function private.export_my_oil() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- API surface + privileges
-- ---------------------------------------------------------------------------
create or replace function public.request_oil(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.request_oil(payload); $$;
create or replace function public.cancel_oil_request(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.cancel_oil_request(payload); $$;
create or replace function public.review_oil_request(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.review_oil_request(payload); $$;
create or replace function public.export_my_oil() returns jsonb
language sql security invoker set search_path = '' as $$ select private.export_my_oil(); $$;

revoke all on function private.allocate_oil(public.pressing_batches, text), private.request_oil(jsonb), private.cancel_oil_request(jsonb),
  private.review_oil_request(jsonb), private.certify_pressing_batch(jsonb), private.list_review_queue(jsonb)
  from public, anon, authenticated;
revoke all on function public.request_oil(jsonb), public.cancel_oil_request(jsonb), public.review_oil_request(jsonb), public.export_my_oil()
  from public, anon, authenticated;
grant execute on function private.request_oil(jsonb), private.cancel_oil_request(jsonb), private.review_oil_request(jsonb),
  private.certify_pressing_batch(jsonb), private.list_review_queue(jsonb), private.export_my_oil(),
  public.request_oil(jsonb), public.cancel_oil_request(jsonb), public.review_oil_request(jsonb), public.export_my_oil()
  to authenticated;
