-- Faseela (migration 48): master data for a multi-country catalogue.
-- Until now a tree knew its origin only as free text (region) and its farm and mill as free-text ids without
-- a record behind them; "Syria" and "USD" were assumptions in the code. This migration adds:
--   public.currencies  ISO 4217 codes with their number of minor units (the app must not assume /100)
--   public.countries   origin countries; 'planned' ones are prepared but invisible until an admin activates them
--   public.farms       one record per farm, in one country; public once listed
--   public.mills       one record per mill
--   trees_public.country_code / farm_id, profiles.locale
-- Existing trees are assigned to Syria, and a farm / mill record is created for every id already in use.
-- Farm owners are not stored here: who works a tree stays in farmer_assignments (no new personal data).
-- Rollback: drop the functions below and their public wrappers, restore admin_set_tree_mill from migration 42,
--   alter table private.trees drop constraint trees_farm_id_fkey, drop constraint trees_mill_id_fkey;
--   alter table public.trees_public drop column farm_id, drop column country_code;
--   alter table public.profiles drop column locale; drop table public.mills, public.farms, public.countries, public.currencies;

create table public.currencies (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  minor_units smallint not null check (minor_units between 0 and 3),
  name_en text not null check (char_length(name_en) between 2 and 60)
);
alter table public.currencies enable row level security;
create policy currencies_select on public.currencies for select to anon, authenticated using (true);
revoke all on public.currencies from public, anon, authenticated;
grant select on public.currencies to anon, authenticated;
insert into public.currencies (code, minor_units, name_en) values
  ('USD', 2, 'US dollar'), ('EUR', 2, 'Euro'), ('GBP', 2, 'Pound sterling'), ('SYP', 2, 'Syrian pound'),
  ('TRY', 2, 'Turkish lira'), ('TND', 3, 'Tunisian dinar'), ('MAD', 2, 'Moroccan dirham');

create table public.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null check (char_length(name) between 2 and 60),
  name_en text not null check (char_length(name_en) between 2 and 60),
  name_de text not null check (char_length(name_de) between 2 and 60),
  currency text not null references public.currencies (code),
  status text not null default 'planned' check (status in ('active', 'planned')),
  updated_at timestamptz not null default now()
);
alter table public.countries enable row level security;
create policy countries_select on public.countries for select to anon, authenticated using (status = 'active');
revoke all on public.countries from public, anon, authenticated;
grant select on public.countries to anon, authenticated;
-- currency = the currency offers from this country are listed in by default (an admin decides per tree).
insert into public.countries (code, name, name_en, name_de, currency, status) values
  ('SY', 'سوريا', 'Syria', 'Syrien', 'USD', 'active'),
  ('ES', 'إسبانيا', 'Spain', 'Spanien', 'EUR', 'planned'),
  ('IT', 'إيطاليا', 'Italy', 'Italien', 'EUR', 'planned'),
  ('GR', 'اليونان', 'Greece', 'Griechenland', 'EUR', 'planned'),
  ('TN', 'تونس', 'Tunisia', 'Tunesien', 'EUR', 'planned'),
  ('TR', 'تركيا', 'Türkiye', 'Türkei', 'EUR', 'planned'),
  ('MA', 'المغرب', 'Morocco', 'Marokko', 'EUR', 'planned');

create table public.farms (
  farm_id text primary key check (farm_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  country_code text not null references public.countries (code),
  name text not null default '',
  name_en text not null default '',
  region text not null default '',
  region_en text not null default '',
  status text not null default 'unlisted' check (status in ('listed', 'unlisted')),
  updated_at timestamptz not null default now()
);
create index farms_country_idx on public.farms (country_code);
alter table public.farms enable row level security;
create policy farms_select on public.farms for select to anon, authenticated using (status = 'listed');
revoke all on public.farms from public, anon, authenticated;
grant select on public.farms to anon, authenticated;

create table public.mills (
  mill_id text primary key check (mill_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  country_code text not null references public.countries (code),
  name text not null default '',
  name_en text not null default '',
  region text not null default '',
  region_en text not null default '',
  status text not null default 'unlisted' check (status in ('listed', 'unlisted')),
  updated_at timestamptz not null default now()
);
create index mills_country_idx on public.mills (country_code);
alter table public.mills enable row level security;
create policy mills_select on public.mills for select to anon, authenticated using (status = 'listed');
revoke all on public.mills from public, anon, authenticated;
grant select on public.mills to anon, authenticated;

-- Records for the ids already in use (names are filled in by an admin; they start unlisted).
update private.trees set farm_id = null where farm_id is not null and btrim(farm_id) = '';
update private.trees set mill_id = null where mill_id is not null and btrim(mill_id) = '';
insert into public.farms (farm_id, country_code)
  select distinct farm_id, 'SY' from private.trees where farm_id is not null
  on conflict (farm_id) do nothing;
insert into public.mills (mill_id, country_code)
  select mill_id, 'SY' from (
    select mill_id from private.trees where mill_id is not null
    union
    select mill_id from public.mill_assignments
  ) m
  on conflict (mill_id) do nothing;
alter table private.trees add constraint trees_farm_id_fkey foreign key (farm_id) references public.farms (farm_id);
alter table private.trees add constraint trees_mill_id_fkey foreign key (mill_id) references public.mills (mill_id);

-- The column may already exist: the country registry applied to the live project created it as "country"
-- (renamed in 20261117000050_country_column_bridge.sql). The foreign key is added either way.
alter table public.trees_public add column if not exists country_code text not null default 'SY';
-- A tree may carry a code that is not seeded above (the applied registry accepted every registered code, and
-- unlisted trees were not checked). Such a code becomes a planned country with the code as a neutral name and USD,
-- so the foreign key holds; an admin completes it under master data. Nothing changes for SY.
insert into public.countries (code, name, name_en, name_de, currency, status)
  select distinct p.country_code, p.country_code, p.country_code, p.country_code, 'USD', 'planned'
    from public.trees_public p
   where not exists (select 1 from public.countries c where c.code = p.country_code)
  on conflict (code) do nothing;
alter table public.trees_public add constraint trees_public_country_code_fkey foreign key (country_code) references public.countries (code);
alter table public.trees_public add column farm_id text references public.farms (farm_id);
update public.trees_public p set farm_id = t.farm_id from private.trees t where t.tree_id = p.tree_id and t.farm_id is not null;
create index trees_public_country_idx on public.trees_public (country_code);
create index trees_public_farm_idx on public.trees_public (farm_id);

alter table public.profiles add column locale text check (locale in ('ar', 'en', 'de'));

-- ---------------------------------------------------------------- admin functions
/** Everything the admin panel needs for its origin fields, including planned countries and unlisted records. */
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
    'currencies', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'minorUnits', minor_units, 'nameEn', name_en) order by code) from public.currencies), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'nameEn', name_en, 'nameDe', name_de, 'currency', currency, 'status', status,
        'trees', (select count(*) from public.trees_public t where t.country_code = c.code)) order by code) from public.countries c), '[]'::jsonb),
    'farms', coalesce((select jsonb_agg(jsonb_build_object('farmId', farm_id, 'countryCode', country_code, 'name', name, 'nameEn', name_en, 'region', region,
        'regionEn', region_en, 'status', status, 'trees', (select count(*) from private.trees t where t.farm_id = f.farm_id)) order by farm_id) from public.farms f), '[]'::jsonb),
    'mills', coalesce((select jsonb_agg(jsonb_build_object('millId', mill_id, 'countryCode', country_code, 'name', name, 'nameEn', name_en, 'region', region,
        'regionEn', region_en, 'status', status, 'trees', (select count(*) from private.trees t where t.mill_id = m.mill_id)) order by mill_id) from public.mills m), '[]'::jsonb));
end;
$$;

/** Activates a planned country or sets it back. A country with listed trees cannot be set back. */
create or replace function private.admin_set_country_status(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_code text := private.req_id(p, 'code', '^[A-Z]{2}$');
  v_status text := private.req_id(p, 'status', '^(active|planned)$');
  v_before text;
begin
  select status into v_before from public.countries where code = v_code for update;
  if not found then
    perform private.fail('not-found', 'Country was not found.');
  end if;
  if v_status = 'planned' and exists (select 1 from public.trees_public where country_code = v_code and status = 'listed') then
    perform private.fail('failed-precondition', 'A country with listed trees cannot be set back to planned.');
  end if;
  update public.countries set status = v_status, updated_at = now() where code = v_code;
  perform private.audit(v_uid, 'country.status_changed', 'countries/' || v_code, jsonb_build_object('before', v_before, 'after', v_status));
  return jsonb_build_object('code', v_code, 'status', v_status);
end;
$$;

/** Shared by farms and mills: p_kind is 'farm' or 'mill' (set by the two wrappers below, never by the caller). */
create or replace function private.admin_upsert_site(p_kind text, payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_id text := private.req_id(p, p_kind || 'Id', '^[a-z0-9_]{3,40}$');
  v_country text := private.req_id(p, 'countryCode', '^[A-Z]{2}$');
  v_name text := private.tree_text(p, 'name', 120, true);
  v_name_en text := private.tree_text(p, 'nameEn', 120, true);
  v_region text := coalesce(private.tree_text(p, 'region', 120, false), '');
  v_region_en text := coalesce(private.tree_text(p, 'regionEn', 120, false), '');
  v_status text := coalesce(private.opt_text(p, 'status', 10), 'unlisted');
  v_old_country text;
  v_created boolean;
begin
  if p_kind not in ('farm', 'mill') then
    perform private.fail('invalid-argument', 'Unknown site kind.');
  end if;
  if v_status not in ('listed', 'unlisted') then
    perform private.fail('invalid-argument', 'Field status is invalid.');
  end if;
  if not exists (select 1 from public.countries where code = v_country) then
    perform private.fail('not-found', 'Country was not found.');
  end if;
  if p_kind = 'farm' then
    select country_code into v_old_country from public.farms where farm_id = v_id for update;
    v_created := not found;
    -- A farm does not move to another country while trees are attached to it: their origin would change with it.
    if not v_created and v_old_country <> v_country and exists (select 1 from private.trees where farm_id = v_id) then
      perform private.fail('failed-precondition', 'The country of a farm with trees cannot change.');
    end if;
    insert into public.farms (farm_id, country_code, name, name_en, region, region_en, status, updated_at)
    values (v_id, v_country, v_name, v_name_en, v_region, v_region_en, v_status, now())
    on conflict (farm_id) do update set country_code = excluded.country_code, name = excluded.name, name_en = excluded.name_en,
      region = excluded.region, region_en = excluded.region_en, status = excluded.status, updated_at = now();
  else
    select country_code into v_old_country from public.mills where mill_id = v_id for update;
    v_created := not found;
    insert into public.mills (mill_id, country_code, name, name_en, region, region_en, status, updated_at)
    values (v_id, v_country, v_name, v_name_en, v_region, v_region_en, v_status, now())
    on conflict (mill_id) do update set country_code = excluded.country_code, name = excluded.name, name_en = excluded.name_en,
      region = excluded.region, region_en = excluded.region_en, status = excluded.status, updated_at = now();
  end if;
  perform private.audit(v_uid, p_kind || case when v_created then '.created' else '.updated' end, p_kind || 's/' || v_id,
    jsonb_build_object('countryCode', v_country, 'status', v_status));
  return jsonb_build_object(p_kind || 'Id', v_id, 'countryCode', v_country, 'status', v_status, 'created', v_created);
end;
$$;

/**
 * Sets the origin of a tree: its country and, optionally, its farm (farmId null clears it; an absent key keeps it).
 * The farm must lie in the same country. The country is fixed once shares are sold or reserved, like the crop.
 */
create or replace function private.admin_set_tree_origin(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_country text := private.req_id(p, 'countryCode', '^[A-Z]{2}$');
  v_farm text;
  v_row private.trees;
  v_before_country text;
  v_before_farm text;
begin
  select * into v_row from private.trees where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  select country_code, farm_id into v_before_country, v_before_farm from public.trees_public where tree_id = v_tree;
  if not exists (select 1 from public.countries where code = v_country) then
    perform private.fail('not-found', 'Country was not found.');
  end if;
  if v_before_country <> v_country and v_row.sold_shares + v_row.reserved_shares > 0 then
    perform private.fail('failed-precondition', 'The country cannot change once shares are sold or reserved.');
  end if;
  if p ? 'farmId' then
    v_farm := nullif(btrim(coalesce(private.opt_text(p, 'farmId', 80), '')), '');
  else
    v_farm := v_before_farm;
  end if;
  if v_farm is not null and not exists (select 1 from public.farms where farm_id = v_farm and country_code = v_country) then
    perform private.fail('failed-precondition', 'The farm does not exist in this country.');
  end if;
  update public.trees_public set country_code = v_country, farm_id = v_farm, updated_at = now() where tree_id = v_tree;
  update private.trees set farm_id = v_farm, updated_at = now() where tree_id = v_tree;
  perform private.audit(v_uid, 'tree.origin_changed', 'trees_public/' || v_tree,
    jsonb_build_object('countryBefore', v_before_country, 'countryAfter', v_country, 'farmBefore', v_before_farm, 'farmAfter', v_farm));
  return jsonb_build_object('treeId', v_tree, 'countryCode', v_country, 'farmId', v_farm);
end;
$$;

create or replace function private.admin_get_tree_origin(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_tree text := private.req_id(coalesce(payload, '{}'::jsonb), 'treeId', '^[A-Za-z0-9_-]{1,80}$');
begin
  return (select jsonb_build_object('treeId', tree_id, 'countryCode', country_code, 'farmId', farm_id) from public.trees_public where tree_id = v_tree);
end;
$$;

/** As migration 42, but the mill must exist: private.trees.mill_id now references public.mills. */
create or replace function private.admin_set_tree_mill(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_mill text := nullif(btrim(coalesce(private.opt_text(p, 'millId', 80), '')), '');
  v_before text;
begin
  if v_mill is not null and v_mill !~ '^[A-Za-z0-9_-]{1,80}$' then
    perform private.fail('invalid-argument', 'Field millId is invalid.');
  end if;
  select mill_id into v_before from private.trees where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  if v_mill is not null and not exists (select 1 from public.mills where mill_id = v_mill) then
    perform private.fail('not-found', 'Mill was not found. Create it under master data first.');
  end if;
  update private.trees set mill_id = v_mill, updated_at = now() where tree_id = v_tree;
  perform private.audit(v_uid, 'tree.mill_changed', 'trees_public/' || v_tree, jsonb_build_object('before', v_before, 'after', v_mill));
  return jsonb_build_object('treeId', v_tree, 'millId', v_mill);
end;
$$;

/** Language the signed-in user wants to be addressed in (interface and, later, e-mails). */
create or replace function private.set_my_locale(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_locale text := private.req_id(coalesce(payload, '{}'::jsonb), 'locale', '^(ar|en|de)$');
begin
  update public.profiles set locale = v_locale, updated_at = now() where id = v_uid;
  if not found then
    perform private.fail('failed-precondition', 'Profile does not exist yet.');
  end if;
  return jsonb_build_object('locale', v_locale);
end;
$$;

create or replace function public.admin_list_master_data() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_list_master_data(); $$;
create or replace function public.admin_set_country_status(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_country_status(payload); $$;
create or replace function public.admin_upsert_farm(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_upsert_site('farm', payload); $$;
create or replace function public.admin_upsert_mill(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_upsert_site('mill', payload); $$;
create or replace function public.admin_set_tree_origin(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_tree_origin(payload); $$;
create or replace function public.admin_get_tree_origin(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_get_tree_origin(payload); $$;
create or replace function public.set_my_locale(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('set_my_locale', 20, 60); select private.set_my_locale(payload); $$;

revoke all on function private.admin_list_master_data(), private.admin_set_country_status(jsonb), private.admin_upsert_site(text, jsonb),
  private.admin_set_tree_origin(jsonb), private.admin_get_tree_origin(jsonb), private.set_my_locale(jsonb),
  public.admin_list_master_data(), public.admin_set_country_status(jsonb), public.admin_upsert_farm(jsonb), public.admin_upsert_mill(jsonb),
  public.admin_set_tree_origin(jsonb), public.admin_get_tree_origin(jsonb), public.set_my_locale(jsonb) from public, anon, authenticated;
grant execute on function private.admin_list_master_data(), private.admin_set_country_status(jsonb), private.admin_upsert_site(text, jsonb),
  private.admin_set_tree_origin(jsonb), private.admin_get_tree_origin(jsonb), private.set_my_locale(jsonb),
  public.admin_list_master_data(), public.admin_set_country_status(jsonb), public.admin_upsert_farm(jsonb), public.admin_upsert_mill(jsonb),
  public.admin_set_tree_origin(jsonb), public.admin_get_tree_origin(jsonb), public.set_my_locale(jsonb) to authenticated;
