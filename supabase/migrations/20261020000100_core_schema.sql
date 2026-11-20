-- Faseela core schema on Supabase (port of Firestore `faseela-prod`, see docs/SUPABASE_MIGRATION.md).
--
-- Security model (deny-by-default):
--   * Every table in `public` has RLS enabled and only SELECT policies. No client role holds
--     INSERT/UPDATE/DELETE privileges; all business writes go through RPCs (002 migration).
--   * Roles live in `private.user_roles` (not exposed by the Data API, never user_metadata).
--   * SECURITY DEFINER functions exist only in `private` and always pin `search_path = ''`.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create table private.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('investor', 'farmer', 'mill_operator', 'finance_admin', 'quality_auditor', 'admin')),
  granted_by uuid,
  granted_at timestamptz not null default now()
);
revoke all on private.user_roles from public, anon, authenticated;

create function private.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.role from private.user_roles r where r.user_id = (select auth.uid())),
    'investor'
  );
$$;

-- Admin passes every role check (same semantics as the former requireRole helper).
-- An empty array therefore means "admin only".
create function private.has_any_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and (private.current_app_role() = 'admin' or private.current_app_role() = any (roles));
$$;

-- ---------------------------------------------------------------------------
-- Profiles & role applications
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text not null default '' check (char_length(display_name) <= 120),
  phone text not null default '' check (char_length(phone) <= 40),
  region text not null default '' check (char_length(region) <= 120),
  requested_role text not null default 'investor' check (requested_role in ('investor', 'farmer', 'mill_operator')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.role_applications (
  user_id uuid primary key references auth.users (id) on delete cascade,
  requested_role text not null check (requested_role in ('farmer', 'mill_operator')),
  region text not null check (char_length(region) between 2 and 120),
  organization_name text not null default '' check (char_length(organization_name) <= 160),
  message text not null default '' check (char_length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_uid uuid,
  review_note text not null default '' check (char_length(review_note) <= 500)
);
create index role_applications_status_idx on public.role_applications (status, submitted_at);

-- ---------------------------------------------------------------------------
-- Trees: public listing + private inventory (farmer data, exact parcel corners)
-- ---------------------------------------------------------------------------
create table public.trees_public (
  tree_id text primary key check (tree_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  status text not null default 'listed' check (status in ('listed', 'unlisted')),
  crop_category text not null default 'olive',
  name text not null default '',
  name_en text not null default '',
  region text not null default '',
  region_en text not null default '',
  tree_type text not null default '',
  tree_type_en text not null default '',
  planted_year integer,
  estimated_annual_yield_kg numeric,
  carbon_offset_kg_year numeric,
  images text[] not null default '{}' check (cardinality(images) <= 6),
  total_shares integer not null check (total_shares > 0),
  available_shares integer not null check (available_shares >= 0 and available_shares <= total_shares),
  price_per_share_minor bigint not null check (price_per_share_minor > 0),
  land_price_minor bigint not null default 0 check (land_price_minor >= 0),
  has_land_option boolean not null default false,
  land_area_sqm numeric not null default 0 check (land_area_sqm >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz not null default now()
);
create index trees_public_status_idx on public.trees_public (status);

create table private.trees (
  tree_id text primary key references public.trees_public (tree_id) on delete cascade,
  farm_id text,
  mill_id text,
  total_shares integer not null check (total_shares > 0),
  sold_shares integer not null default 0 check (sold_shares >= 0),
  reserved_shares integer not null default 0 check (reserved_shares >= 0),
  price_per_share_minor bigint not null check (price_per_share_minor > 0),
  land_price_minor bigint not null default 0 check (land_price_minor >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  land_parcel jsonb,
  gps jsonb,
  updated_at timestamptz not null default now(),
  -- Inventory invariant enforced by the database itself: never oversell.
  constraint trees_inventory_bounds check (sold_shares + reserved_shares <= total_shares)
);
revoke all on private.trees from public, anon, authenticated;

create table public.tree_events_public (
  id uuid primary key default gen_random_uuid(),
  tree_id text not null references public.trees_public (tree_id) on delete cascade,
  event_type text not null check (char_length(event_type) <= 40),
  notes text not null default '' check (char_length(notes) <= 1200),
  media_count integer not null default 0 check (media_count between 0 and 5),
  batch_id uuid,
  certificate_serial text,
  oil_yield_liters numeric,
  acidity_pct numeric,
  peroxide_value numeric,
  event_date timestamptz,
  status text not null default 'published' check (status in ('published', 'retracted')),
  created_at timestamptz not null default now()
);
create index tree_events_public_tree_idx on public.tree_events_public (tree_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Investments. user_id deliberately has no FK to auth.users: after an account
-- deletion the financial records stay pseudonymised for bookkeeping retention.
-- ---------------------------------------------------------------------------
create table public.investment_requests (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  user_id uuid not null,
  tree_id text not null references public.trees_public (tree_id),
  share_count integer not null check (share_count between 1 and 1000),
  includes_land boolean not null default false,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('awaiting_payment', 'under_review', 'approved', 'rejected', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  payment_proof_path text,
  proof_submitted_at timestamptz,
  reviewed_by_uid uuid,
  reviewed_at timestamptz,
  review_note text not null default '' check (char_length(review_note) <= 500),
  sla_breached boolean not null default false,
  sla_breached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index investment_requests_user_status_idx on public.investment_requests (user_id, status);
create index investment_requests_status_expires_idx on public.investment_requests (status, expires_at);
create index investment_requests_status_proof_idx on public.investment_requests (status, proof_submitted_at);
create index investment_requests_tree_idx on public.investment_requests (tree_id);

create table public.transactions (
  id text primary key references public.investment_requests (id),
  request_id text not null references public.investment_requests (id),
  user_id uuid not null,
  type text not null default 'share_purchase' check (type in ('share_purchase')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending', 'under_review', 'settled', 'rejected', 'cancelled', 'expired')),
  reviewed_by_uid uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index transactions_user_idx on public.transactions (user_id);
create index transactions_request_idx on public.transactions (request_id);

create table public.shares (
  id text primary key references public.investment_requests (id),
  request_id text not null references public.investment_requests (id),
  user_id uuid not null,
  tree_id text not null references public.trees_public (tree_id),
  share_count integer not null check (share_count > 0),
  includes_land boolean not null default false,
  purchase_price_minor bigint not null check (purchase_price_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active', 'transferred', 'settled')),
  created_at timestamptz not null default now()
);
create index shares_user_status_idx on public.shares (user_id, status);
create index shares_request_idx on public.shares (request_id);
create index shares_tree_idx on public.shares (tree_id);

-- ---------------------------------------------------------------------------
-- Field operations
-- ---------------------------------------------------------------------------
create table public.farmer_assignments (
  farmer_uid uuid not null references auth.users (id) on delete cascade,
  tree_id text not null references public.trees_public (tree_id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (farmer_uid, tree_id)
);
create index farmer_assignments_tree_idx on public.farmer_assignments (tree_id);

create table public.mill_assignments (
  operator_uid uuid not null references auth.users (id) on delete cascade,
  mill_id text not null check (mill_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  assigned_at timestamptz not null default now(),
  primary key (operator_uid, mill_id)
);

create table public.farmer_updates (
  id uuid primary key default gen_random_uuid(),
  farmer_uid uuid not null,
  tree_id text not null references public.trees_public (tree_id),
  event_type text not null check (event_type in ('watering', 'pruning', 'fertilizing', 'pest_control', 'harvest', 'other')),
  notes text not null default '' check (char_length(notes) <= 1200),
  media_paths text[] not null default '{}' check (cardinality(media_paths) <= 5),
  gps_lat double precision check (gps_lat between -90 and 90),
  gps_lng double precision check (gps_lng between -180 and 180),
  status text not null default 'pending_review' check (status in ('pending_review', 'published', 'rejected')),
  review_note text not null default '' check (char_length(review_note) <= 500),
  reviewed_by_uid uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index farmer_updates_farmer_idx on public.farmer_updates (farmer_uid);
create index farmer_updates_status_idx on public.farmer_updates (status, created_at);
create index farmer_updates_tree_idx on public.farmer_updates (tree_id);

create table public.pressing_batches (
  id uuid primary key default gen_random_uuid(),
  submitted_by_uid uuid not null,
  tree_id text not null references public.trees_public (tree_id),
  mill_id text not null check (mill_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  olives_weight_kg numeric not null check (olives_weight_kg > 0),
  oil_yield_liters numeric not null check (oil_yield_liters >= 0),
  temperature_celsius numeric not null check (temperature_celsius between 0 and 40),
  acidity_pct numeric not null check (acidity_pct between 0 and 100),
  peroxide_value numeric not null check (peroxide_value between 0 and 100),
  season_year integer not null,
  status text not null default 'pending_review' check (status in ('pending_review', 'certified', 'rejected')),
  certificate_serial text check (certificate_serial ~ '^[A-Za-z0-9_-]{1,120}$'),
  review_note text not null default '' check (char_length(review_note) <= 500),
  certified_by_uid uuid,
  certified_at timestamptz,
  created_at timestamptz not null default now()
);
create index pressing_batches_submitter_idx on public.pressing_batches (submitted_by_uid);
create index pressing_batches_status_idx on public.pressing_batches (status, created_at);
create index pressing_batches_tree_idx on public.pressing_batches (tree_id);

-- ---------------------------------------------------------------------------
-- Audit log (append-only; actor_uid is null for system jobs)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_uid uuid,
  action text not null,
  target text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- Privileges: read-only for clients, writes only through RPCs
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.role_applications, public.trees_public, public.tree_events_public,
  public.investment_requests, public.transactions, public.shares, public.farmer_assignments,
  public.mill_assignments, public.farmer_updates, public.pressing_batches, public.audit_logs
  from public, anon, authenticated;

grant select on public.profiles, public.role_applications, public.trees_public, public.tree_events_public,
  public.investment_requests, public.transactions, public.shares, public.farmer_assignments,
  public.mill_assignments, public.farmer_updates, public.pressing_batches, public.audit_logs
  to authenticated;
grant select on public.trees_public, public.tree_events_public to anon;

alter table public.profiles enable row level security;
alter table public.role_applications enable row level security;
alter table public.trees_public enable row level security;
alter table public.tree_events_public enable row level security;
alter table public.investment_requests enable row level security;
alter table public.transactions enable row level security;
alter table public.shares enable row level security;
alter table public.farmer_assignments enable row level security;
alter table public.mill_assignments enable row level security;
alter table public.farmer_updates enable row level security;
alter table public.pressing_batches enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.has_any_role('{}'::text[])));

create policy role_applications_select on public.role_applications for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_any_role('{}'::text[])));

create policy trees_public_select on public.trees_public for select to anon, authenticated
  using (status = 'listed');

create policy tree_events_public_select on public.tree_events_public for select to anon, authenticated
  using (status = 'published');

create policy investment_requests_select on public.investment_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_any_role(array['finance_admin'])));

create policy transactions_select on public.transactions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_any_role(array['finance_admin'])));

create policy shares_select on public.shares for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_any_role(array['finance_admin'])));

create policy farmer_assignments_select on public.farmer_assignments for select to authenticated
  using (farmer_uid = (select auth.uid()) or (select private.has_any_role('{}'::text[])));

create policy mill_assignments_select on public.mill_assignments for select to authenticated
  using (operator_uid = (select auth.uid()) or (select private.has_any_role('{}'::text[])));

create policy farmer_updates_select on public.farmer_updates for select to authenticated
  using (farmer_uid = (select auth.uid()) or (select private.has_any_role(array['quality_auditor'])));

create policy pressing_batches_select on public.pressing_batches for select to authenticated
  using (submitted_by_uid = (select auth.uid()) or (select private.has_any_role(array['quality_auditor'])));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using ((select private.has_any_role('{}'::text[])));

-- Realtime: changes are delivered only to subscribers whose RLS SELECT policy matches.
alter publication supabase_realtime add table
  public.investment_requests, public.transactions, public.shares, public.role_applications,
  public.farmer_updates, public.pressing_batches, public.trees_public;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_app_role() to authenticated;
grant execute on function private.has_any_role(text[]) to authenticated;
