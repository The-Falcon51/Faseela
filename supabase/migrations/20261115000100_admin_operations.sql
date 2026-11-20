-- Faseela (migration 38): operating functions for the admin panel — tree catalogue (create/edit), user record,
-- ownership register and the e-mail queue. Role-checked, validated at the boundary, audited where data changes
-- or a single person's record is opened.

/** Optional number from a payload: null when absent, error when not a finite number inside [p_min, p_max]. */
create or replace function private.opt_num(p jsonb, p_key text, p_min numeric, p_max numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> p_key;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' then
    perform private.fail('invalid-argument', format('Field %s is invalid.', p_key));
  end if;
  n := (v #>> '{}')::numeric;
  if n < p_min or n > p_max then
    perform private.fail('invalid-argument', format('Field %s is out of range.', p_key));
  end if;
  return n;
end;
$$;

/** Optional whole number from a payload (see opt_num); fractions are rejected instead of rounded. */
create or replace function private.opt_int(p jsonb, p_key text, p_min numeric, p_max numeric)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  n numeric := private.opt_num(p, p_key, p_min, p_max);
begin
  if n is not null and n <> trunc(n) then
    perform private.fail('invalid-argument', format('Field %s must be a whole number.', p_key));
  end if;
  return n::bigint;
end;
$$;

/** Catalogue text: trimmed, 2..p_max characters, no control characters or angle brackets. */
create or replace function private.tree_text(p jsonb, p_key text, p_max integer, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(private.opt_text(p, p_key, p_max), ''));
begin
  if v = '' then
    if p_required then
      perform private.fail('invalid-argument', format('Field %s is required.', p_key));
    end if;
    return null;
  end if;
  if char_length(v) < 2 or v ~ '[<>[:cntrl:]]' then
    perform private.fail('invalid-argument', format('Field %s is invalid.', p_key));
  end if;
  return v;
end;
$$;

/** Image list for a tree: up to 6 paths of images shipped with the app (no remote URLs). */
create or replace function private.tree_images(p jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p -> 'images';
  v_out text[];
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) < 1 or jsonb_array_length(v) > 6 then
    perform private.fail('invalid-argument', 'Field images is invalid.');
  end if;
  select array_agg(e #>> '{}') into v_out from jsonb_array_elements(v) e;
  if exists (select 1 from unnest(v_out) x where x is null or x !~ '^images/[A-Za-z0-9_-]{1,80}\.(webp|png|jpg|jpeg)$') then
    perform private.fail('invalid-argument', 'Field images is invalid.');
  end if;
  return v_out;
end;
$$;

/** Creates a tree. It starts unlisted, so it can be checked before buyers see it. */
create or replace function private.admin_create_tree(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[a-z0-9_]{3,40}$');
  v_name text := private.tree_text(p, 'name', 120, true);
  v_name_en text := private.tree_text(p, 'nameEn', 120, true);
  v_region text := private.tree_text(p, 'region', 120, true);
  v_region_en text := private.tree_text(p, 'regionEn', 120, true);
  v_type text := private.tree_text(p, 'treeType', 120, true);
  v_type_en text := private.tree_text(p, 'treeTypeEn', 120, true);
  v_total integer := private.opt_int(p, 'totalShares', 1, 10000)::integer;
  v_price bigint := private.opt_int(p, 'pricePerShareMinor', 100, 100000000)::bigint;
  v_land bigint := coalesce(private.opt_int(p, 'landPriceMinor', 0, 100000000), 0)::bigint;
  v_area numeric := coalesce(private.opt_num(p, 'landAreaSqm', 0, 100000), 0);
  v_year integer := private.opt_int(p, 'plantedYear', 1000, extract(year from now())::numeric)::integer;
  v_yield numeric := private.opt_num(p, 'estimatedAnnualYieldKg', 0, 5000);
  v_images text[] := coalesce(private.tree_images(p), array['images/olive_branches_macro.webp']);
  v_land_option boolean := coalesce((p -> 'hasLandOption') = 'true'::jsonb, false);
begin
  if v_total is null or v_price is null then
    perform private.fail('invalid-argument', 'Share count and price are required.');
  end if;
  if v_land_option and (v_land <= 0 or v_area <= 0) then
    perform private.fail('invalid-argument', 'A land option needs a land price and an area.');
  end if;
  if exists (select 1 from public.trees_public where tree_id = v_tree) then
    perform private.fail('already-exists', 'A tree with this id already exists.');
  end if;
  insert into public.trees_public (tree_id, status, crop_category, name, name_en, region, region_en, tree_type, tree_type_en,
    planted_year, estimated_annual_yield_kg, images, total_shares, available_shares, price_per_share_minor,
    land_price_minor, has_land_option, land_area_sqm, currency, updated_at)
  values (v_tree, 'unlisted', 'olive', v_name, v_name_en, v_region, v_region_en, v_type, v_type_en,
    v_year, v_yield, v_images, v_total, v_total, v_price,
    case when v_land_option then v_land else 0 end, v_land_option, case when v_land_option then v_area else 0 end, 'USD', now());
  insert into private.trees (tree_id, total_shares, price_per_share_minor, land_price_minor, currency)
  values (v_tree, v_total, v_price, case when v_land_option then v_land else 0 end, 'USD');
  perform private.audit(v_uid, 'tree.created', 'trees_public/' || v_tree,
    jsonb_build_object('totalShares', v_total, 'pricePerShareMinor', v_price, 'hasLandOption', v_land_option));
  return jsonb_build_object('treeId', v_tree, 'status', 'unlisted');
end;
$$;

/**
 * Edits a tree. Texts, images, yield and year can always change. A new price applies to future requests only
 * (open requests keep the amount they were created with). The share count can never drop below what is sold
 * or reserved.
 */
create or replace function private.admin_update_tree(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_total integer := private.opt_int(p, 'totalShares', 1, 10000)::integer;
  v_price bigint := private.opt_int(p, 'pricePerShareMinor', 100, 100000000)::bigint;
  v_land bigint := private.opt_int(p, 'landPriceMinor', 0, 100000000)::bigint;
  v_area numeric := private.opt_num(p, 'landAreaSqm', 0, 100000);
  v_year integer := private.opt_int(p, 'plantedYear', 1000, extract(year from now())::numeric)::integer;
  v_yield numeric := private.opt_num(p, 'estimatedAnnualYieldKg', 0, 5000);
  v_images text[] := private.tree_images(p);
  v_row private.trees;
  v_changed text[];
begin
  select * into v_row from private.trees where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  if v_total is not null and v_total < v_row.sold_shares + v_row.reserved_shares then
    perform private.fail('failed-precondition', 'The share count cannot be lower than the shares already sold or reserved.');
  end if;
  update public.trees_public t set
    name = coalesce(private.tree_text(p, 'name', 120, false), t.name),
    name_en = coalesce(private.tree_text(p, 'nameEn', 120, false), t.name_en),
    region = coalesce(private.tree_text(p, 'region', 120, false), t.region),
    region_en = coalesce(private.tree_text(p, 'regionEn', 120, false), t.region_en),
    tree_type = coalesce(private.tree_text(p, 'treeType', 120, false), t.tree_type),
    tree_type_en = coalesce(private.tree_text(p, 'treeTypeEn', 120, false), t.tree_type_en),
    planted_year = coalesce(v_year, t.planted_year),
    estimated_annual_yield_kg = coalesce(v_yield, t.estimated_annual_yield_kg),
    images = coalesce(v_images, t.images),
    total_shares = coalesce(v_total, t.total_shares),
    available_shares = coalesce(v_total, v_row.total_shares) - v_row.sold_shares - v_row.reserved_shares,
    price_per_share_minor = coalesce(v_price, t.price_per_share_minor),
    land_price_minor = case when t.has_land_option then coalesce(v_land, t.land_price_minor) else t.land_price_minor end,
    land_area_sqm = case when t.has_land_option then coalesce(v_area, t.land_area_sqm) else t.land_area_sqm end,
    updated_at = now()
   where t.tree_id = v_tree;
  update private.trees t set
    total_shares = coalesce(v_total, t.total_shares),
    price_per_share_minor = coalesce(v_price, t.price_per_share_minor),
    land_price_minor = case when (select has_land_option from public.trees_public where tree_id = v_tree) then coalesce(v_land, t.land_price_minor) else t.land_price_minor end,
    updated_at = now()
   where t.tree_id = v_tree;
  select array_agg(k order by k) into v_changed from jsonb_object_keys(p) k where k <> 'treeId';
  perform private.audit(v_uid, 'tree.updated', 'trees_public/' || v_tree, jsonb_build_object('fields', coalesce(to_jsonb(v_changed), '[]'::jsonb),
    'priceBefore', v_row.price_per_share_minor, 'priceAfter', coalesce(v_price, v_row.price_per_share_minor),
    'sharesBefore', v_row.total_shares, 'sharesAfter', coalesce(v_total, v_row.total_shares)));
  return jsonb_build_object('treeId', v_tree, 'updated', true);
end;
$$;

/** Full editable record of one tree (for the edit form). */
create or replace function private.admin_get_tree(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_tree text := private.req_id(coalesce(payload, '{}'::jsonb), 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_out jsonb;
begin
  select jsonb_build_object('treeId', p.tree_id, 'status', p.status, 'name', p.name, 'nameEn', p.name_en, 'region', p.region,
      'regionEn', p.region_en, 'treeType', p.tree_type, 'treeTypeEn', p.tree_type_en, 'plantedYear', p.planted_year,
      'estimatedAnnualYieldKg', p.estimated_annual_yield_kg, 'images', to_jsonb(p.images), 'totalShares', t.total_shares,
      'soldShares', t.sold_shares, 'reservedShares', t.reserved_shares, 'pricePerShareMinor', t.price_per_share_minor,
      'landPriceMinor', t.land_price_minor, 'hasLandOption', p.has_land_option, 'landAreaSqm', p.land_area_sqm, 'currency', t.currency)
    into v_out from private.trees t join public.trees_public p on p.tree_id = t.tree_id where t.tree_id = v_tree;
  if v_out is null then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  return v_out;
end;
$$;

/** One person's record for support and reviews. Opening it is written to the audit log. */
create or replace function private.admin_user_detail(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_target uuid := private.req_uuid(coalesce(payload, '{}'::jsonb), 'userId');
  v_out jsonb;
begin
  select jsonb_build_object(
      'userId', u.id, 'email', u.email, 'displayName', pr.display_name, 'phone', pr.phone, 'region', pr.region,
      'role', coalesce((select r.role from private.user_roles r where r.user_id = u.id), 'investor'),
      'requestedRole', pr.requested_role, 'createdAt', private.epoch_ms(u.created_at),
      'emailConfirmedAt', private.epoch_ms(u.email_confirmed_at), 'lastSignInAt', private.epoch_ms(u.last_sign_in_at),
      'suspended', u.banned_until is not null and u.banned_until > now(), 'marketingOptIn', coalesce(pr.marketing_opt_in, false),
      'requests', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
          select i.created_at, jsonb_build_object('id', i.id, 'treeId', i.tree_id, 'shareCount', i.share_count, 'amountMinor', i.amount_minor,
            'currency', i.currency, 'status', i.status, 'createdAt', private.epoch_ms(i.created_at)) as j
            from public.investment_requests i where i.user_id = u.id order by i.created_at desc limit 20) x), '[]'::jsonb),
      'shares', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'treeId', s.tree_id, 'shareCount', s.share_count, 'includesLand', s.includes_land,
            'status', s.status, 'createdAt', private.epoch_ms(s.created_at)) order by s.created_at desc)
            from public.shares s where s.user_id = u.id), '[]'::jsonb),
      'assignments', jsonb_build_object(
          'trees', coalesce((select jsonb_agg(a.tree_id order by a.tree_id) from public.farmer_assignments a where a.farmer_uid = u.id and a.revoked_at is null), '[]'::jsonb),
          'mills', coalesce((select jsonb_agg(m.mill_id order by m.mill_id) from public.mill_assignments m where m.operator_uid = u.id and m.revoked_at is null), '[]'::jsonb)),
      'counts', jsonb_build_object(
          'requests', (select count(*) from public.investment_requests i where i.user_id = u.id),
          'referralsMade', (select count(*) from public.referrals r where r.referrer_uid = u.id),
          'oilAllocatedMl', (select coalesce(sum(o.liters_ml), 0) from public.oil_allocations o where o.user_id = u.id),
          'pushDevices', (select count(*) from private.push_tokens t where t.user_id = u.id and t.disabled_at is null)))
    into v_out
    from auth.users u left join public.profiles pr on pr.id = u.id
   where u.id = v_target and u.deleted_at is null;
  if v_out is null then
    perform private.fail('not-found', 'User was not found.');
  end if;
  perform private.audit(v_uid, 'user.viewed', 'users/' || v_target::text, '{}'::jsonb);
  return v_out;
end;
$$;

/** Ownership register: who holds which shares. Paged (max 100), optional tree filter. */
create or replace function private.admin_list_shares(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := nullif(p ->> 'treeId', '');
  v_limit integer := coalesce(private.opt_int(p, 'limit', 1, 100), 50)::integer;
  v_offset integer := coalesce(private.opt_int(p, 'offset', 0, 1000000), 0)::integer;
begin
  if v_tree is not null and v_tree !~ '^[A-Za-z0-9_-]{1,80}$' then
    perform private.fail('invalid-argument', 'Field treeId is invalid.');
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.shares s where v_tree is null or s.tree_id = v_tree),
    'limit', v_limit, 'offset', v_offset,
    'rows', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
        select s.created_at, jsonb_build_object('id', s.id, 'ownerName', pr.display_name, 'ownerEmail', pr.email, 'userId', s.user_id,
          'treeId', s.tree_id, 'shareCount', s.share_count, 'includesLand', s.includes_land, 'purchasePriceMinor', s.purchase_price_minor,
          'currency', s.currency, 'status', s.status, 'createdAt', private.epoch_ms(s.created_at)) as j
          from public.shares s left join public.profiles pr on pr.id = s.user_id
         where v_tree is null or s.tree_id = v_tree
         order by s.created_at desc limit v_limit offset v_offset) x), '[]'::jsonb));
end;
$$;

/** Latest e-mails in the queue. Recipients are masked; the panel does not need full addresses here. */
create or replace function private.admin_list_outbox()
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
    'counts', coalesce((select jsonb_object_agg(s.status, s.n) from (select status, count(*) n from private.email_outbox group by status) s), '{}'::jsonb),
    'rows', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
        select o.created_at, jsonb_build_object('id', o.id, 'template', o.template, 'status', o.status, 'attempts', o.attempts,
          'recipient', left(o.recipient, 1) || '***@' || split_part(o.recipient, '@', 2),
          'lastError', left(o.last_error, 200), 'createdAt', private.epoch_ms(o.created_at), 'sentAt', private.epoch_ms(o.sent_at)) as j
          from private.email_outbox o order by o.created_at desc limit 100) x), '[]'::jsonb));
end;
$$;

/** Puts failed e-mails back into the queue: one by id, or all failures of the last 7 days. */
create or replace function private.admin_retry_email(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_id bigint := private.opt_int(p, 'id', 1, 9000000000000000)::bigint;
  v_all boolean := coalesce((p -> 'all') = 'true'::jsonb, false);
  v_n integer;
begin
  if (v_id is null) = (not v_all) then
    perform private.fail('invalid-argument', 'Pass either an id or all=true.');
  end if;
  update private.email_outbox
     set status = 'pending', attempts = 0, last_error = null, claimed_at = null
   where status = 'failed'
     and ((v_id is not null and id = v_id) or (v_all and created_at > now() - interval '7 days'));
  get diagnostics v_n = row_count;
  perform private.audit(v_uid, 'outbox.retry', 'email_outbox', jsonb_build_object('count', v_n, 'all', v_all));
  return jsonb_build_object('requeued', v_n);
end;
$$;

create or replace function public.admin_create_tree(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_create_tree(payload); $$;
create or replace function public.admin_update_tree(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_update_tree(payload); $$;
create or replace function public.admin_get_tree(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_get_tree(payload);
$$;
create or replace function public.admin_user_detail(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_user_detail', 60, 60);
  select private.admin_user_detail(payload);
$$;
create or replace function public.admin_list_shares(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_list_shares(payload);
$$;
create or replace function public.admin_list_outbox() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_list_outbox();
$$;
create or replace function public.admin_retry_email(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_retry_email(payload); $$;

revoke all on function private.opt_num(jsonb, text, numeric, numeric), private.opt_int(jsonb, text, numeric, numeric), private.tree_text(jsonb, text, integer, boolean), private.tree_images(jsonb),
  private.admin_create_tree(jsonb), private.admin_update_tree(jsonb), private.admin_get_tree(jsonb), private.admin_user_detail(jsonb),
  private.admin_list_shares(jsonb), private.admin_list_outbox(), private.admin_retry_email(jsonb),
  public.admin_create_tree(jsonb), public.admin_update_tree(jsonb), public.admin_get_tree(jsonb), public.admin_user_detail(jsonb),
  public.admin_list_shares(jsonb), public.admin_list_outbox(), public.admin_retry_email(jsonb)
  from public, anon, authenticated;
grant execute on function private.admin_create_tree(jsonb), private.admin_update_tree(jsonb), private.admin_get_tree(jsonb), private.admin_user_detail(jsonb),
  private.admin_list_shares(jsonb), private.admin_list_outbox(), private.admin_retry_email(jsonb),
  public.admin_create_tree(jsonb), public.admin_update_tree(jsonb), public.admin_get_tree(jsonb), public.admin_user_detail(jsonb),
  public.admin_list_shares(jsonb), public.admin_list_outbox(), public.admin_retry_email(jsonb)
  to authenticated;
