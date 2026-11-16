-- Faseela (migration 50): marketplace core. Farms offer products, customers order them, the platform adds an
-- openly shown service fee.
--
-- Model
--  * public.farm_members      which accounts act for a farm (assigned by an admin).
--  * public.products          a farm's goods. A farm member writes them; they are visible in the shop only after an
--                             admin listed them (status 'listed') and only while the farm itself is listed. Every
--                             change of content or price sends a product back to review. stock_units is the number of
--                             units that can still be ordered: an order takes its units out immediately and gives
--                             them back when it is cancelled, rejected or expires.
--  * public.shipping_rates    flat price per order from a farm's country to a destination country. No active rate
--                             means that destination cannot be ordered (fail-closed).
--  * public.orders / public.order_items   one order holds products of exactly one farm in one currency. Prices,
--                             names, shipping and the fee rate are copied into the order, so later changes of the
--                             catalogue never alter an existing order. total = items + shipping (constraint).
--  * private.order_contacts   delivery name and address, encrypted like oil-delivery contacts. Farm members never
--                             get it; staff read it through an audited function while the order must be shipped.
--  * private.farm_ledger      what the platform owes a farm: one 'sale' credit per paid order (items minus the
--                             service fee), a negative 'adjustment' when a paid order is refunded, and a negative
--                             'payout' for every transfer to the farm that finance records (bank reference, once).
--  * private.order_screenings sanctions screening of the payer; a payment is only confirmed after a recent
--                             screening with the result 'clear' (same rule as for sponsorship payments).
--
-- Money flow in this step: bank transfer, as for sponsorships. The customer orders (awaiting_payment, 72 h), reports
-- the transfer (under_review), finance confirms it (paid) or rejects it; the reviewer must not be the customer.
-- Service fee: private.app_settings('platform_fee_bps'), default 1500 = 15 %. It is INCLUDED in the product price:
-- the customer pays the listed price plus shipping and nothing is added at checkout; the farm is credited the price
-- minus the fee. The split is shown openly to customer and farm, and each order keeps the rate it was placed with.
-- The shop is CLOSED by default: private.app_settings('shop_open') must be true before anyone can order, and only
-- an admin can set it. VAT is NOT calculated here. [PLATZHALTER: Umsatzsteuer, Widerrufsrecht und AGB für den
-- Warenverkauf, Verkäuferstellung (Hof oder Plattform) – rechtlich zu klären, bevor der Laden geöffnet wird.]
--
-- Rollback: unschedule the jobs 'faseela-expire-orders' and 'faseela-purge-order-contacts'; restore
--   private.delete_my_account from migration 20261110000210 and private.export_my_data from 20261111000100; drop the public and private functions created below;
--   drop table private.order_screenings, private.farm_ledger, private.order_contacts, public.order_items, public.orders, public.shipping_rates,
--   public.products, public.farm_members (in this order); delete the app_settings rows 'platform_fee_bps' and 'shop_open'.
--   Dropping the tables discards orders: export them first if any exist.

-- ---------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------

create table if not exists public.farm_members (
  farm_id text not null references public.farms (farm_id),
  user_id uuid not null references auth.users (id) on delete cascade,
  added_by uuid,
  added_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (farm_id, user_id)
);
create index if not exists farm_members_user_idx on public.farm_members (user_id);

create or replace function private.is_farm_member(p_farm_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.farm_members m
                  where m.farm_id = p_farm_id and m.user_id = (select auth.uid()) and m.revoked_at is null);
$$;

create or replace function private.platform_fee_bps()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' and (s.value #>> '{}')::numeric between 0 and 3000
                               then trunc((s.value #>> '{}')::numeric)::integer end
                     from private.app_settings s where s.key = 'platform_fee_bps'), 1500);
$$;

create or replace function private.shop_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select value = 'true'::jsonb from private.app_settings where key = 'shop_open'), false);
$$;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  farm_id text not null references public.farms (farm_id),
  category text not null check (category in ('oil', 'olives', 'dates', 'nuts', 'fruit', 'preserves', 'other')),
  name text not null check (char_length(name) between 2 and 120),
  name_en text not null default '' check (char_length(name_en) <= 120),
  description text not null default '' check (char_length(description) <= 1000),
  description_en text not null default '' check (char_length(description_en) <= 1000),
  unit text not null check (char_length(unit) between 1 and 40),
  price_minor bigint not null check (price_minor between 1 and 100000000),
  currency text not null references public.currencies (code),
  stock_units integer not null default 0 check (stock_units between 0 and 1000000),
  status text not null default 'pending_review' check (status in ('pending_review', 'listed', 'unlisted', 'rejected')),
  review_note text not null default '' check (char_length(review_note) <= 500),
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_farm_idx on public.products (farm_id);
create index if not exists products_status_idx on public.products (status);

create table if not exists public.shipping_rates (
  origin_country text not null references public.countries (code),
  dest_country text not null check (dest_country ~ '^[A-Z]{2}$'),
  amount_minor bigint not null check (amount_minor between 0 and 10000000),
  currency text not null references public.currencies (code),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (origin_country, dest_country)
);

create table if not exists public.orders (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  user_id uuid not null,
  farm_id text not null references public.farms (farm_id),
  status text not null check (status in ('awaiting_payment', 'under_review', 'paid', 'shipped', 'delivered',
                                         'cancelled', 'expired', 'rejected', 'refunded')),
  currency text not null references public.currencies (code),
  items_minor bigint not null check (items_minor > 0),
  shipping_minor bigint not null check (shipping_minor >= 0),
  fee_bps integer not null check (fee_bps between 0 and 3000),
  fee_minor bigint not null check (fee_minor >= 0),
  total_minor bigint not null,
  dest_country text not null check (dest_country ~ '^[A-Z]{2}$'),
  payment_reference text not null unique,
  expires_at timestamptz not null,
  reviewed_by_uid uuid,
  reviewed_at timestamptz,
  review_note text not null default '' check (char_length(review_note) <= 500),
  tracking_code text not null default '' check (char_length(tracking_code) <= 80),
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_total_check check (total_minor = items_minor + shipping_minor),
  constraint orders_fee_check check (fee_minor <= items_minor)
);
create index if not exists orders_user_idx on public.orders (user_id, created_at desc);
create index if not exists orders_farm_idx on public.orders (farm_id, status);
create index if not exists orders_expiry_idx on public.orders (expires_at) where status = 'awaiting_payment';

create table if not exists public.order_items (
  order_id text not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id),
  name text not null,
  unit text not null,
  unit_price_minor bigint not null check (unit_price_minor > 0),
  quantity integer not null check (quantity between 1 and 50),
  line_minor bigint not null,
  primary key (order_id, product_id),
  constraint order_items_line_check check (line_minor = unit_price_minor * quantity)
);
create index if not exists order_items_product_idx on public.order_items (product_id);

create table if not exists private.order_contacts (
  order_id text primary key references public.orders (id) on delete cascade,
  contact_enc bytea not null,
  created_at timestamptz not null default now()
);

create table if not exists private.farm_ledger (
  id bigint generated always as identity primary key,
  farm_id text not null references public.farms (farm_id),
  order_id text references public.orders (id),
  kind text not null check (kind in ('sale', 'payout', 'adjustment')),
  amount_minor bigint not null check (amount_minor <> 0),
  currency text not null references public.currencies (code),
  note text not null default '' check (char_length(note) <= 300),
  ref text check (char_length(ref) between 3 and 80),
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists farm_ledger_sale_once on private.farm_ledger (order_id) where kind = 'sale';
create unique index if not exists farm_ledger_refund_once on private.farm_ledger (order_id) where kind = 'adjustment' and order_id is not null;
create unique index if not exists farm_ledger_ref_once on private.farm_ledger (farm_id, ref) where ref is not null;
create index if not exists farm_ledger_farm_idx on private.farm_ledger (farm_id);

create table if not exists private.order_screenings (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders (id),
  result text not null check (result in ('clear', 'hit', 'unclear')),
  lists_checked text not null check (char_length(lists_checked) between 3 and 300),
  reference text check (char_length(reference) <= 120),
  note text not null default '' check (char_length(note) <= 500),
  checked_by uuid not null,
  checked_at timestamptz not null default now()
);
create index if not exists order_screenings_order_idx on private.order_screenings (order_id, checked_at desc);

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security: read-only for clients, every write goes through the functions below.
-- Internal columns (who created or reviewed something, the customer's account id) are not granted at all.
-- ---------------------------------------------------------------------------------------------------------------

alter table public.farm_members enable row level security;
alter table public.products enable row level security;
alter table public.shipping_rates enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table private.order_contacts enable row level security;
alter table private.farm_ledger enable row level security;
alter table private.order_screenings enable row level security;

revoke all on public.farm_members, public.products, public.shipping_rates, public.orders, public.order_items
  from public, anon, authenticated;
revoke all on private.order_contacts, private.farm_ledger, private.order_screenings from public, anon, authenticated;

grant select (farm_id, user_id, added_at, revoked_at) on public.farm_members to authenticated;
grant select (id, farm_id, category, name, name_en, description, description_en, unit, price_minor, currency,
              stock_units, status, updated_at) on public.products to anon, authenticated;
grant select on public.shipping_rates to anon, authenticated;
grant select (id, farm_id, status, currency, items_minor, shipping_minor, fee_bps, fee_minor, total_minor,
              dest_country, payment_reference, expires_at, review_note, tracking_code, shipped_at, delivered_at,
              created_at, updated_at) on public.orders to authenticated;
grant select on public.order_items to authenticated;

drop policy if exists farm_members_select on public.farm_members;
create policy farm_members_select on public.farm_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_any_role('{}'::text[])));

drop policy if exists products_select_listed on public.products;
create policy products_select_listed on public.products for select to anon, authenticated
  using (status = 'listed' and exists (select 1 from public.farms f where f.farm_id = products.farm_id and f.status = 'listed'));

drop policy if exists products_select_own_farm on public.products;
create policy products_select_own_farm on public.products for select to authenticated
  using ((select private.is_farm_member(products.farm_id)) or (select private.has_any_role('{}'::text[])));

drop policy if exists shipping_rates_select on public.shipping_rates;
create policy shipping_rates_select on public.shipping_rates for select to anon, authenticated
  using (active);

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated
  using (user_id = (select auth.uid())
         or (select private.has_any_role(array['finance_admin']))
         or (select private.is_farm_member(orders.farm_id)));

drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_items.order_id));

-- ---------------------------------------------------------------------------------------------------------------
-- Shared building blocks
-- ---------------------------------------------------------------------------------------------------------------

/** Prices an order. Reads products, the farm's shipping rate and the fee rate; with p_lock it also locks the
    product rows (in id order, so two orders never wait on each other in a circle). Never writes. */
create or replace function private.order_quote(p jsonb, p_lock boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb := p -> 'items';
  v_dest text := upper(btrim(coalesce(private.opt_text(p, 'destCountry', 2), '')));
  v_item jsonb;
  v_id uuid;
  v_qty integer;
  v_ids uuid[] := '{}';
  v_wanted jsonb := '{}'::jsonb;
  v_prod record;
  v_found integer := 0;
  v_farm text;
  v_origin text;
  v_currency text;
  v_lines jsonb := '[]'::jsonb;
  v_items_minor bigint := 0;
  v_rate public.shipping_rates;
  v_bps integer := private.platform_fee_bps();
  v_fee bigint;
begin
  if not private.shop_open() then
    perform private.fail('shop-closed', 'The farm shop does not take orders yet.');
  end if;
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) not between 1 and 20 then
    perform private.fail('invalid-argument', 'An order needs between 1 and 20 different products.');
  end if;
  if v_dest !~ '^[A-Z]{2}$' then
    perform private.fail('invalid-argument', 'A destination country is required.');
  end if;

  for v_item in select value from jsonb_array_elements(v_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      perform private.fail('invalid-argument', 'Field items is invalid.');
    end if;
    v_id := private.req_uuid(v_item, 'productId');
    v_qty := private.opt_int(v_item, 'quantity', 1, 50);
    if v_qty is null then
      perform private.fail('invalid-argument', 'Field quantity is required.');
    end if;
    if v_id = any (v_ids) then
      perform private.fail('invalid-argument', 'A product may appear only once in an order.');
    end if;
    v_ids := v_ids || v_id;
    v_wanted := v_wanted || jsonb_build_object(v_id::text, v_qty);
  end loop;

  if p_lock then
    perform 1 from public.products where id = any (v_ids) order by id for update;
  end if;

  for v_prod in
    select pr.id, pr.farm_id, pr.name, pr.unit, pr.price_minor, pr.currency, pr.stock_units, pr.status,
           f.status as farm_status, f.country_code
      from public.products pr join public.farms f on f.farm_id = pr.farm_id
     where pr.id = any (v_ids)
     order by pr.id
  loop
    v_found := v_found + 1;
    v_qty := (v_wanted ->> v_prod.id::text)::integer;
    if v_prod.status <> 'listed' or v_prod.farm_status <> 'listed' then
      perform private.fail('product-unavailable', 'A product in this order is no longer offered.');
    end if;
    if v_farm is null then
      v_farm := v_prod.farm_id;
      v_origin := v_prod.country_code;
      v_currency := v_prod.currency;
    elsif v_prod.farm_id <> v_farm or v_prod.currency <> v_currency then
      perform private.fail('mixed-farms', 'One order can only hold products of a single farm.');
    end if;
    if v_prod.stock_units < v_qty then
      perform private.fail('out-of-stock', format('Only %s units of "%s" are left.', v_prod.stock_units, v_prod.name));
    end if;
    v_items_minor := v_items_minor + v_prod.price_minor * v_qty;
    v_lines := v_lines || jsonb_build_object('productId', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit,
      'unitPriceMinor', v_prod.price_minor, 'quantity', v_qty, 'lineMinor', v_prod.price_minor * v_qty);
  end loop;
  if v_found <> coalesce(array_length(v_ids, 1), 0) then
    perform private.fail('product-unavailable', 'A product in this order is no longer offered.');
  end if;

  select * into v_rate from public.shipping_rates
   where origin_country = v_origin and dest_country = v_dest and active and currency = v_currency;
  if not found then
    perform private.fail('no-shipping-rate', 'This farm does not ship to the chosen country yet.');
  end if;

  -- The fee is part of the listed price: nothing is added for the customer, the farm receives items minus fee.
  v_fee := round(v_items_minor * v_bps / 10000.0)::bigint;
  return jsonb_build_object('farmId', v_farm, 'originCountry', v_origin, 'destCountry', v_dest, 'currency', v_currency,
    'lines', v_lines, 'itemsMinor', v_items_minor, 'shippingMinor', v_rate.amount_minor, 'feeBps', v_bps,
    'feeMinor', v_fee, 'farmNetMinor', v_items_minor - v_fee, 'totalMinor', v_items_minor + v_rate.amount_minor);
end;
$$;

/** Gives the units of an order back to the shop. The caller holds the order row lock. */
create or replace function private.order_release_stock(p_order_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products pr
     set stock_units = least(pr.stock_units + i.quantity, 1000000), updated_at = now()
    from public.order_items i
   where i.order_id = p_order_id and pr.id = i.product_id;
$$;

create or replace function private.order_summary(o public.orders)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('orderId', o.id, 'status', o.status, 'farmId', o.farm_id, 'currency', o.currency,
    'itemsMinor', o.items_minor, 'shippingMinor', o.shipping_minor, 'feeBps', o.fee_bps, 'feeMinor', o.fee_minor,
    'farmNetMinor', o.items_minor - o.fee_minor, 'totalMinor', o.total_minor, 'destCountry', o.dest_country, 'paymentReference', o.payment_reference,
    'expiresAt', private.epoch_ms(o.expires_at), 'createdAt', private.epoch_ms(o.created_at),
    'reviewNote', o.review_note, 'trackingCode', o.tracking_code,
    'shippedAt', private.epoch_ms(o.shipped_at), 'deliveredAt', private.epoch_ms(o.delivered_at),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('productId', i.product_id, 'name', i.name, 'unit', i.unit,
                         'unitPriceMinor', i.unit_price_minor, 'quantity', i.quantity, 'lineMinor', i.line_minor)
                         order by i.name, i.product_id)
                         from public.order_items i where i.order_id = o.id), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Customer
-- ---------------------------------------------------------------------------------------------------------------

create or replace function private.marketplace_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('feeBps', private.platform_fee_bps(), 'shopOpen', private.shop_open());
$$;

create or replace function private.quote_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_user();
  return private.order_quote(coalesce(payload, '{}'::jsonb), false);
end;
$$;

create or replace function private.create_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_ttl constant interval := interval '72 hours';
  c_max_open constant integer := 5;
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_key text;
  v_id text;
  v_existing public.orders;
  v_contact jsonb := coalesce(p -> 'contact', '{}'::jsonb);
  v_name text;
  v_phone text;
  v_line1 text;
  v_line2 text;
  v_postal text;
  v_city text;
  v_country text;
  v_quote jsonb;
  v_line jsonb;
  v_order public.orders;
begin
  perform private.require_verified_email(v_uid, 'Verify your email before ordering.');
  if jsonb_typeof(p -> 'idempotencyKey') is distinct from 'string'
     or char_length(p ->> 'idempotencyKey') not between 16 and 120 then
    perform private.fail('invalid-argument', 'Field idempotencyKey is invalid.');
  end if;
  v_key := p ->> 'idempotencyKey';
  v_id := encode(sha256(convert_to(v_uid::text || ':order:' || v_key, 'UTF8')), 'hex');

  -- One order at a time per account: a double click or a retry finds the first order instead of creating a second.
  perform pg_advisory_xact_lock(hashtextextended('faseela:order:' || v_uid::text, 0));
  select * into v_existing from public.orders where id = v_id;
  if found then
    return private.order_summary(v_existing) || jsonb_build_object('replayed', true);
  end if;

  if jsonb_typeof(v_contact) <> 'object' then
    perform private.fail('invalid-argument', 'Field contact is invalid.');
  end if;
  v_name := btrim(coalesce(private.opt_text(v_contact, 'name', 120), ''));
  v_phone := btrim(coalesce(private.opt_text(v_contact, 'phone', 40), ''));
  v_line1 := btrim(coalesce(private.opt_text(v_contact, 'addressLine1', 200), ''));
  v_line2 := btrim(coalesce(private.opt_text(v_contact, 'addressLine2', 200), ''));
  v_postal := btrim(coalesce(private.opt_text(v_contact, 'postalCode', 20), ''));
  v_city := btrim(coalesce(private.opt_text(v_contact, 'city', 120), ''));
  v_country := upper(btrim(coalesce(private.opt_text(v_contact, 'country', 2), '')));
  if char_length(v_name) < 2 or char_length(v_line1) < 3 or char_length(v_city) < 2 or v_country !~ '^[A-Z]{2}$' then
    perform private.fail('invalid-argument', 'A delivery name and an address with city and country are required.');
  end if;

  if (select count(*) from public.orders where user_id = v_uid and status = 'awaiting_payment') >= c_max_open then
    perform private.fail('resource-exhausted', 'Pay or cancel your open orders before placing another one.');
  end if;

  v_quote := private.order_quote(jsonb_build_object('items', p -> 'items', 'destCountry', v_country), true);

  insert into public.orders (id, user_id, farm_id, status, currency, items_minor, shipping_minor, fee_bps, fee_minor,
                             total_minor, dest_country, payment_reference, expires_at)
  values (v_id, v_uid, v_quote ->> 'farmId', 'awaiting_payment', v_quote ->> 'currency',
          (v_quote ->> 'itemsMinor')::bigint, (v_quote ->> 'shippingMinor')::bigint, (v_quote ->> 'feeBps')::integer,
          (v_quote ->> 'feeMinor')::bigint, (v_quote ->> 'totalMinor')::bigint, v_country,
          'FO-' || upper(substr(v_id, 1, 10)), now() + c_ttl)
  returning * into v_order;

  for v_line in select value from jsonb_array_elements(v_quote -> 'lines') loop
    insert into public.order_items (order_id, product_id, name, unit, unit_price_minor, quantity, line_minor)
    values (v_id, (v_line ->> 'productId')::uuid, v_line ->> 'name', v_line ->> 'unit',
            (v_line ->> 'unitPriceMinor')::bigint, (v_line ->> 'quantity')::integer, (v_line ->> 'lineMinor')::bigint);
    update public.products
       set stock_units = stock_units - (v_line ->> 'quantity')::integer, updated_at = now()
     where id = (v_line ->> 'productId')::uuid;
  end loop;

  insert into private.order_contacts (order_id, contact_enc)
  values (v_id, extensions.pgp_sym_encrypt(jsonb_build_object('name', v_name, 'phone', v_phone,
    'addressLine1', v_line1, 'addressLine2', v_line2, 'postalCode', v_postal, 'city', v_city,
    'country', v_country)::text, private.pii_key()));

  perform private.audit(v_uid, 'order.created', 'orders/' || v_id, jsonb_build_object(
    'farmId', v_order.farm_id, 'totalMinor', v_order.total_minor, 'currency', v_order.currency,
    'feeBps', v_order.fee_bps, 'destCountry', v_country));
  perform private.notify_user(v_uid, 'order_placed', jsonb_build_object('orderId', v_id,
    'amountMinor', v_order.total_minor, 'currency', v_order.currency,
    'paymentReference', v_order.payment_reference, 'expiresAt', private.epoch_ms(v_order.expires_at)));
  return private.order_summary(v_order) || jsonb_build_object('replayed', false);
end;
$$;

/** Locks one of the caller's own orders. Someone else's order looks exactly like a missing one. */
create or replace function private.own_order_for_update(p jsonb, p_uid uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders
   where id = private.req_id(p, 'orderId', '^[a-f0-9]{64}$') and user_id = p_uid for update;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  return v_order;
end;
$$;

create or replace function private.report_order_payment(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_order public.orders := private.own_order_for_update(coalesce(payload, '{}'::jsonb), v_uid);
begin
  if v_order.status = 'under_review' then
    return private.order_summary(v_order);
  end if;
  if v_order.status <> 'awaiting_payment' or v_order.expires_at <= now() then
    perform private.fail('failed-precondition', 'This order is no longer waiting for a payment.');
  end if;
  update public.orders set status = 'under_review', updated_at = now() where id = v_order.id returning * into v_order;
  perform private.audit(v_uid, 'order.payment_reported', 'orders/' || v_order.id, '{}'::jsonb);
  perform private.notify_role('finance_admin', 'review_needed', jsonb_build_object('queue', 'orders',
    'orderId', v_order.id, 'amountMinor', v_order.total_minor, 'currency', v_order.currency));
  return private.order_summary(v_order);
end;
$$;

create or replace function private.cancel_my_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_order public.orders := private.own_order_for_update(coalesce(payload, '{}'::jsonb), v_uid);
begin
  if v_order.status = 'cancelled' then
    return private.order_summary(v_order);
  end if;
  if v_order.status <> 'awaiting_payment' then
    perform private.fail('failed-precondition', 'Only an order that is still waiting for payment can be cancelled here.');
  end if;
  perform 1 from public.products where id in (select product_id from public.order_items where order_id = v_order.id)
    order by id for update;
  perform private.order_release_stock(v_order.id);
  update public.orders set status = 'cancelled', updated_at = now() where id = v_order.id returning * into v_order;
  perform private.audit(v_uid, 'order.cancelled', 'orders/' || v_order.id, '{}'::jsonb);
  return private.order_summary(v_order);
end;
$$;

create or replace function private.list_my_orders()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('orders', coalesce((
    select jsonb_agg(private.order_summary(o) order by o.created_at desc)
      from (select * from public.orders where user_id = private.require_user()
             order by created_at desc limit 100) o), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Farm members
-- ---------------------------------------------------------------------------------------------------------------

/** Create or change a product of the caller's farm. Content and price changes always go (back) to review. */
create or replace function private.farmer_upsert_product(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_farm text := private.req_id(p, 'farmId', '^[A-Za-z0-9_-]{1,80}$');
  v_product_id uuid;
  v_category text := private.req_id(p, 'category', '^(oil|olives|dates|nuts|fruit|preserves|other)$');
  v_name text := btrim(coalesce(private.opt_text(p, 'name', 120), ''));
  v_name_en text := btrim(coalesce(private.opt_text(p, 'nameEn', 120), ''));
  v_desc text := btrim(coalesce(private.opt_text(p, 'description', 1000), ''));
  v_desc_en text := btrim(coalesce(private.opt_text(p, 'descriptionEn', 1000), ''));
  v_unit text := btrim(coalesce(private.opt_text(p, 'unit', 40), ''));
  v_price bigint := private.opt_int(p, 'priceMinor', 1, 100000000);
  v_currency text := private.req_id(p, 'currency', '^[A-Z]{3}$');
  v_stock integer := private.opt_int(p, 'stockUnits', 0, 1000000);
  v_row public.products;
begin
  if not (private.is_farm_member(v_farm) or private.has_any_role('{}'::text[])) then
    perform private.fail('permission-denied', 'This operation is not permitted for this account.');
  end if;
  if not exists (select 1 from public.farms where farm_id = v_farm) then
    perform private.fail('not-found', 'Farm was not found.');
  end if;
  if char_length(v_name) < 2 or char_length(v_unit) < 1 or v_price is null then
    perform private.fail('invalid-argument', 'A product needs a name, a unit and a price.');
  end if;
  if not exists (select 1 from public.currencies where code = v_currency) then
    perform private.fail('invalid-argument', 'This currency is not supported.');
  end if;

  if p ? 'productId' and jsonb_typeof(p -> 'productId') <> 'null' then
    v_product_id := private.req_uuid(p, 'productId');
    select * into v_row from public.products where id = v_product_id and farm_id = v_farm for update;
    if not found then
      perform private.fail('not-found', 'Product was not found.');
    end if;
    -- The currency of a product that was ever ordered stays as it is: its orders are priced in it.
    if v_row.currency <> v_currency and exists (select 1 from public.order_items where product_id = v_product_id) then
      perform private.fail('failed-precondition', 'The currency of a product that has orders cannot be changed.');
    end if;
    update public.products
       set category = v_category, name = v_name, name_en = v_name_en, description = v_desc, description_en = v_desc_en,
           unit = v_unit, price_minor = v_price, currency = v_currency,
           stock_units = coalesce(v_stock, stock_units), status = 'pending_review', review_note = '',
           reviewed_by = null, reviewed_at = null, updated_at = now()
     where id = v_product_id
    returning * into v_row;
  else
    if (select count(*) from public.products where farm_id = v_farm) >= 200 then
      perform private.fail('resource-exhausted', 'This farm already has the maximum number of products.');
    end if;
    insert into public.products (farm_id, category, name, name_en, description, description_en, unit, price_minor,
                                 currency, stock_units, status, created_by)
    values (v_farm, v_category, v_name, v_name_en, v_desc, v_desc_en, v_unit, v_price, v_currency,
            coalesce(v_stock, 0), 'pending_review', v_uid)
    returning * into v_row;
  end if;

  perform private.audit(v_uid, 'product.submitted', 'products/' || v_row.id, jsonb_build_object(
    'farmId', v_farm, 'priceMinor', v_price, 'currency', v_currency));
  perform private.notify_role('admin', 'review_needed', jsonb_build_object('queue', 'products'));
  return jsonb_build_object('productId', v_row.id, 'status', v_row.status);
end;
$$;

/** Stock and taking a product out of the shop need no review: neither can mislead a customer. */
create or replace function private.farmer_set_product_stock(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_product_id uuid := private.req_uuid(p, 'productId');
  v_stock integer := private.opt_int(p, 'stockUnits', 0, 1000000);
  v_unlist boolean := coalesce(p -> 'unlist' = 'true'::jsonb, false);
  v_row public.products;
begin
  select * into v_row from public.products where id = v_product_id for update;
  if not found or not (private.is_farm_member(v_row.farm_id) or private.has_any_role('{}'::text[])) then
    perform private.fail('not-found', 'Product was not found.');
  end if;
  if v_stock is null and not v_unlist then
    perform private.fail('invalid-argument', 'Field stockUnits is required.');
  end if;
  update public.products
     set stock_units = coalesce(v_stock, stock_units),
         status = case when v_unlist and status = 'listed' then 'unlisted' else status end,
         updated_at = now()
   where id = v_product_id
  returning * into v_row;
  perform private.audit(v_uid, 'product.stock_set', 'products/' || v_row.id, jsonb_build_object(
    'stockUnits', v_row.stock_units, 'status', v_row.status));
  return jsonb_build_object('productId', v_row.id, 'stockUnits', v_row.stock_units, 'status', v_row.status);
end;
$$;

/** Everything a farm member needs: own farms, their products (with review notes), their orders without any
    customer data, and what the platform owes the farm. */
create or replace function private.farm_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return jsonb_build_object('farms', coalesce((
    select jsonb_agg(jsonb_build_object(
      'farmId', f.farm_id, 'name', f.name, 'nameEn', f.name_en, 'countryCode', f.country_code, 'listed', f.status = 'listed',
      'products', coalesce((select jsonb_agg(jsonb_build_object('productId', pr.id, 'category', pr.category,
          'name', pr.name, 'nameEn', pr.name_en, 'description', pr.description, 'descriptionEn', pr.description_en,
          'unit', pr.unit, 'priceMinor', pr.price_minor, 'currency', pr.currency, 'stockUnits', pr.stock_units,
          'status', pr.status, 'reviewNote', pr.review_note) order by pr.name, pr.id)
          from public.products pr where pr.farm_id = f.farm_id), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(private.order_summary(o) - 'paymentReference' order by o.created_at desc)
          from (select * from public.orders o2 where o2.farm_id = f.farm_id
                   and o2.status in ('paid', 'shipped', 'delivered', 'refunded') order by o2.created_at desc limit 100) o), '[]'::jsonb),
      'balances', coalesce((select jsonb_agg(jsonb_build_object('currency', b.currency, 'amountMinor', b.amount_minor) order by b.currency)
          from (select l.currency, sum(l.amount_minor)::bigint as amount_minor from private.farm_ledger l
                 where l.farm_id = f.farm_id group by l.currency) b), '[]'::jsonb)
    ) order by f.name, f.farm_id)
      from public.farms f
      join public.farm_members m on m.farm_id = f.farm_id and m.user_id = v_uid and m.revoked_at is null), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------------------------------------------

create or replace function private.admin_set_farm_member(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_farm text := private.req_id(p, 'farmId', '^[A-Za-z0-9_-]{1,80}$');
  v_member uuid := private.req_uuid(p, 'userId');
  v_active boolean := coalesce(p -> 'active' <> 'false'::jsonb, true);
begin
  if not exists (select 1 from public.farms where farm_id = v_farm) then
    perform private.fail('not-found', 'Farm was not found.');
  end if;
  if v_active and not exists (select 1 from private.user_roles where user_id = v_member and role = 'farmer') then
    perform private.fail('failed-precondition', 'Only an account with the farmer role can act for a farm.');
  end if;
  if v_active then
    insert into public.farm_members (farm_id, user_id, added_by) values (v_farm, v_member, v_uid)
    on conflict (farm_id, user_id) do update set revoked_at = null, added_by = excluded.added_by, added_at = now();
  else
    update public.farm_members set revoked_at = now()
     where farm_id = v_farm and user_id = v_member and revoked_at is null;
  end if;
  perform private.audit(v_uid, case when v_active then 'farm.member_added' else 'farm.member_removed' end,
    'farms/' || v_farm, jsonb_build_object('userId', v_member));
  return jsonb_build_object('farmId', v_farm, 'userId', v_member, 'active', v_active);
end;
$$;

create or replace function private.admin_review_product(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_product_id uuid := private.req_uuid(p, 'productId');
  v_decision text := private.req_id(p, 'decision', '^(list|reject|unlist)$');
  v_note text := btrim(coalesce(private.opt_text(p, 'note', 500), ''));
  v_row public.products;
begin
  select * into v_row from public.products where id = v_product_id for update;
  if not found then
    perform private.fail('not-found', 'Product was not found.');
  end if;
  if v_decision = 'reject' and char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A rejection needs a reason the farm can act on.');
  end if;
  update public.products
     set status = case v_decision when 'list' then 'listed' when 'reject' then 'rejected' else 'unlisted' end,
         review_note = v_note, reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
   where id = v_product_id
  returning * into v_row;
  perform private.audit(v_uid, 'product.' || v_decision, 'products/' || v_row.id, jsonb_build_object(
    'farmId', v_row.farm_id, 'priceMinor', v_row.price_minor, 'currency', v_row.currency, 'note', v_note));
  return jsonb_build_object('productId', v_row.id, 'status', v_row.status);
end;
$$;

create or replace function private.admin_set_shipping_rate(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_origin text := private.req_id(p, 'originCountry', '^[A-Z]{2}$');
  v_dest text := private.req_id(p, 'destCountry', '^[A-Z]{2}$');
  v_amount bigint := private.opt_int(p, 'amountMinor', 0, 10000000);
  v_currency text := private.req_id(p, 'currency', '^[A-Z]{3}$');
  v_active boolean := coalesce(p -> 'active' <> 'false'::jsonb, true);
begin
  if v_amount is null then
    perform private.fail('invalid-argument', 'Field amountMinor is required.');
  end if;
  if not exists (select 1 from public.countries where code = v_origin) then
    perform private.fail('not-found', 'Origin country was not found.');
  end if;
  if not exists (select 1 from public.currencies where code = v_currency) then
    perform private.fail('invalid-argument', 'This currency is not supported.');
  end if;
  insert into public.shipping_rates (origin_country, dest_country, amount_minor, currency, active)
  values (v_origin, v_dest, v_amount, v_currency, v_active)
  on conflict (origin_country, dest_country) do update
    set amount_minor = excluded.amount_minor, currency = excluded.currency, active = excluded.active, updated_at = now();
  perform private.audit(v_uid, 'shipping_rate.set', 'shipping_rates/' || v_origin || '-' || v_dest, jsonb_build_object(
    'amountMinor', v_amount, 'currency', v_currency, 'active', v_active));
  return jsonb_build_object('originCountry', v_origin, 'destCountry', v_dest, 'amountMinor', v_amount,
    'currency', v_currency, 'active', v_active);
end;
$$;

create or replace function private.admin_set_platform_fee(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_bps integer := private.opt_int(coalesce(payload, '{}'::jsonb), 'feeBps', 0, 3000);
  v_before integer := private.platform_fee_bps();
begin
  if v_bps is null then
    perform private.fail('invalid-argument', 'Field feeBps is required.');
  end if;
  insert into private.app_settings (key, value, updated_by) values ('platform_fee_bps', to_jsonb(v_bps), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  perform private.audit(v_uid, 'platform_fee.set', 'app_settings/platform_fee_bps', jsonb_build_object(
    'before', v_before, 'after', v_bps));
  return jsonb_build_object('feeBps', v_bps);
end;
$$;

/** The payment decision. Finance confirms that the transfer with the order's reference arrived, or rejects it. */
create or replace function private.review_order_payment(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_order_id text := private.req_id(p, 'orderId', '^[a-f0-9]{64}$');
  v_decision text := private.req_id(p, 'decision', '^(approve|reject)$');
  v_note text := btrim(coalesce(private.opt_text(p, 'note', 500), ''));
  v_order public.orders;
  v_member record;
  v_screening text;
begin
  select * into v_order from public.orders where id = v_order_id for update;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_order.user_id);
  if v_order.status not in ('awaiting_payment', 'under_review') then
    perform private.fail('failed-precondition', 'This order has already been decided.');
  end if;
  if v_decision = 'reject' and char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A rejection needs a reason the customer can act on.');
  end if;

  -- Sanctions gate (fail-closed), as for sponsorship payments: a latest screening 'clear', at most 30 days old.
  if v_decision = 'approve' then
    select sc.result into v_screening from private.order_screenings sc
     where sc.order_id = v_order_id and sc.checked_at > now() - interval '30 days'
     order by sc.checked_at desc, sc.id desc limit 1;
    if v_screening is null then
      perform private.fail('screening-required', 'Record a sanctions screening before confirming this payment.');
    elsif v_screening <> 'clear' then
      perform private.fail('screening-blocked', 'The latest screening is not clear; this payment cannot be confirmed.');
    end if;
  end if;

  if v_decision = 'approve' then
    update public.orders
       set status = 'paid', reviewed_by_uid = v_uid, reviewed_at = now(), review_note = v_note, updated_at = now()
     where id = v_order_id
    returning * into v_order;
    insert into private.farm_ledger (farm_id, order_id, kind, amount_minor, currency, created_by)
    values (v_order.farm_id, v_order.id, 'sale', v_order.items_minor - v_order.fee_minor, v_order.currency, v_uid);
    perform private.notify_user(v_order.user_id, 'order_paid', jsonb_build_object('orderId', v_order.id,
      'amountMinor', v_order.total_minor, 'currency', v_order.currency));
    for v_member in select user_id from public.farm_members where farm_id = v_order.farm_id and revoked_at is null loop
      perform private.notify_user(v_member.user_id, 'farm_order_paid', jsonb_build_object('orderId', v_order.id,
        'amountMinor', v_order.items_minor - v_order.fee_minor, 'currency', v_order.currency));
    end loop;
  else
    perform 1 from public.products where id in (select product_id from public.order_items where order_id = v_order_id)
      order by id for update;
    perform private.order_release_stock(v_order_id);
    update public.orders
       set status = 'rejected', reviewed_by_uid = v_uid, reviewed_at = now(), review_note = v_note, updated_at = now()
     where id = v_order_id
    returning * into v_order;
    perform private.notify_user(v_order.user_id, 'order_rejected', jsonb_build_object('orderId', v_order.id,
      'amountMinor', v_order.total_minor, 'currency', v_order.currency, 'note', v_note));
  end if;

  perform private.audit(v_uid, 'order.payment_' || v_decision, 'orders/' || v_order.id, jsonb_build_object(
    'totalMinor', v_order.total_minor, 'currency', v_order.currency, 'farmId', v_order.farm_id, 'note', v_note));
  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

create or replace function private.record_order_screening(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_order_id text := private.req_id(p, 'orderId', '^[a-f0-9]{64}$');
  v_result text := private.req_id(p, 'result', '^(clear|hit|unclear)$');
  v_lists text := btrim(coalesce(private.opt_text(p, 'listsChecked', 300), ''));
  v_reference text := nullif(btrim(coalesce(private.opt_text(p, 'reference', 120), '')), '');
  v_note text := btrim(coalesce(private.opt_text(p, 'note', 500), ''));
  v_order public.orders;
  v_id bigint;
begin
  if char_length(v_lists) < 3 then
    perform private.fail('invalid-argument', 'State which lists were checked.');
  end if;
  if v_result <> 'clear' and char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A hit or unclear result needs a note.');
  end if;
  select * into v_order from public.orders where id = v_order_id;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_order.user_id);
  if v_order.status not in ('awaiting_payment', 'under_review') then
    perform private.fail('failed-precondition', 'Only an order whose payment is still open can be screened.');
  end if;
  insert into private.order_screenings (order_id, result, lists_checked, reference, note, checked_by)
  values (v_order_id, v_result, v_lists, v_reference, v_note, v_uid) returning id into v_id;
  -- The audit row carries the result but not the free-text note (may name third parties).
  perform private.audit(v_uid, 'order_screening.' || v_result, 'orders/' || v_order_id,
    jsonb_build_object('screeningId', v_id, 'reference', v_reference));
  return jsonb_build_object('orderId', v_order_id, 'result', v_result, 'screeningId', v_id);
end;
$$;

/** The payer's name for matching the transfer and for the sanctions screening. Audited; open payments only. */
create or replace function private.order_payer(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  v_order_id text := private.req_id(coalesce(payload, '{}'::jsonb), 'orderId', '^[a-f0-9]{64}$');
  v_order public.orders;
  v_contact jsonb;
begin
  select * into v_order from public.orders where id = v_order_id;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  if v_order.status not in ('awaiting_payment', 'under_review') then
    perform private.fail('failed-precondition', 'The payer is only shown while the payment is open.');
  end if;
  select extensions.pgp_sym_decrypt(c.contact_enc, private.pii_key())::jsonb into v_contact
    from private.order_contacts c where c.order_id = v_order_id;
  perform private.audit(v_uid, 'order.payer_read', 'orders/' || v_order_id, '{}'::jsonb);
  return jsonb_build_object('orderId', v_order_id,
    'accountName', coalesce((select pf.display_name from public.profiles pf where pf.id = v_order.user_id), ''),
    'deliveryName', coalesce(v_contact ->> 'name', ''), 'country', coalesce(v_contact ->> 'country', v_order.dest_country));
end;
$$;

/** A paid order that will not be sent: goods back to the shop, the farm's credit reversed. The money itself is
    returned to the customer by bank transfer outside this system; this function records the decision. */
create or replace function private.refund_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_order_id text := private.req_id(p, 'orderId', '^[a-f0-9]{64}$');
  v_note text := btrim(coalesce(private.opt_text(p, 'note', 300), ''));
  v_order public.orders;
begin
  select * into v_order from public.orders where id = v_order_id for update;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_order.user_id);
  if v_order.status <> 'paid' then
    perform private.fail('failed-precondition', 'Only a paid order that has not been shipped can be refunded here.');
  end if;
  if char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A refund needs a reason.');
  end if;
  perform 1 from public.products where id in (select product_id from public.order_items where order_id = v_order_id)
    order by id for update;
  perform private.order_release_stock(v_order_id);
  update public.orders set status = 'refunded', review_note = v_note, updated_at = now()
   where id = v_order_id returning * into v_order;
  insert into private.farm_ledger (farm_id, order_id, kind, amount_minor, currency, note, created_by)
  values (v_order.farm_id, v_order.id, 'adjustment', -(v_order.items_minor - v_order.fee_minor), v_order.currency, v_note, v_uid);
  perform private.notify_user(v_order.user_id, 'order_refunded', jsonb_build_object('orderId', v_order.id,
    'amountMinor', v_order.total_minor, 'currency', v_order.currency, 'note', v_note));
  perform private.audit(v_uid, 'order.refunded', 'orders/' || v_order.id, jsonb_build_object(
    'totalMinor', v_order.total_minor, 'currency', v_order.currency, 'farmId', v_order.farm_id, 'note', v_note));
  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

/** Books a transfer that was made to a farm. Never more than the farm's credit; one booking per bank reference. */
create or replace function private.record_farm_payout(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_farm text := private.req_id(p, 'farmId', '^[A-Za-z0-9_-]{1,80}$');
  v_amount bigint := private.opt_int(p, 'amountMinor', 1, 100000000000);
  v_currency text := private.req_id(p, 'currency', '^[A-Z]{3}$');
  v_ref text := btrim(coalesce(private.opt_text(p, 'reference', 80), ''));
  v_note text := btrim(coalesce(private.opt_text(p, 'note', 300), ''));
  v_balance bigint;
  v_member record;
begin
  if v_amount is null or char_length(v_ref) < 3 then
    perform private.fail('invalid-argument', 'A payout needs an amount and the bank reference of the transfer.');
  end if;
  if not exists (select 1 from public.farms where farm_id = v_farm) then
    perform private.fail('not-found', 'Farm was not found.');
  end if;
  -- A farm member must not book a payout to the own farm.
  if private.is_farm_member(v_farm) then
    perform private.fail('permission-denied', 'A payout to your own farm must be booked by another account.');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('faseela:farm-ledger:' || v_farm, 0));
  if exists (select 1 from private.farm_ledger where farm_id = v_farm and ref = v_ref) then
    perform private.fail('already-exists', 'A booking with this bank reference already exists for this farm.');
  end if;
  select coalesce(sum(amount_minor), 0) into v_balance from private.farm_ledger where farm_id = v_farm and currency = v_currency;
  if v_amount > v_balance then
    perform private.fail('failed-precondition', 'The payout is larger than the farm''s credit in this currency.');
  end if;
  insert into private.farm_ledger (farm_id, kind, amount_minor, currency, note, ref, created_by)
  values (v_farm, 'payout', -v_amount, v_currency, v_note, v_ref, v_uid);
  for v_member in select user_id from public.farm_members where farm_id = v_farm and revoked_at is null loop
    perform private.notify_user(v_member.user_id, 'farm_payout', jsonb_build_object('amountMinor', v_amount, 'currency', v_currency, 'reference', v_ref));
  end loop;
  perform private.audit(v_uid, 'farm.payout_recorded', 'farms/' || v_farm, jsonb_build_object(
    'amountMinor', v_amount, 'currency', v_currency, 'reference', v_ref));
  return jsonb_build_object('farmId', v_farm, 'amountMinor', v_amount, 'currency', v_currency, 'balanceMinor', v_balance - v_amount);
end;
$$;

create or replace function private.admin_set_shop_open(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_open jsonb := coalesce(payload, '{}'::jsonb) -> 'open';
begin
  if v_open is null or jsonb_typeof(v_open) <> 'boolean' then
    perform private.fail('invalid-argument', 'Field open must be true or false.');
  end if;
  insert into private.app_settings (key, value, updated_by) values ('shop_open', v_open, v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  perform private.audit(v_uid, case when v_open = 'true'::jsonb then 'shop.opened' else 'shop.closed' end, 'app_settings/shop_open', '{}'::jsonb);
  return jsonb_build_object('shopOpen', v_open = 'true'::jsonb);
end;
$$;

create or replace function private.admin_set_order_fulfilment(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_order_id text := private.req_id(p, 'orderId', '^[a-f0-9]{64}$');
  v_step text := private.req_id(p, 'step', '^(shipped|delivered)$');
  v_tracking text := btrim(coalesce(private.opt_text(p, 'trackingCode', 80), ''));
  v_order public.orders;
begin
  select * into v_order from public.orders where id = v_order_id for update;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  if (v_step = 'shipped' and v_order.status <> 'paid') or (v_step = 'delivered' and v_order.status <> 'shipped') then
    perform private.fail('failed-precondition', 'This order is not at the step before the requested one.');
  end if;
  if v_step = 'shipped' then
    update public.orders set status = 'shipped', shipped_at = now(), tracking_code = v_tracking, updated_at = now()
     where id = v_order_id returning * into v_order;
    perform private.notify_user(v_order.user_id, 'order_shipped', jsonb_build_object('orderId', v_order.id,
      'trackingCode', v_tracking));
  else
    update public.orders set status = 'delivered', delivered_at = now(), updated_at = now()
     where id = v_order_id returning * into v_order;
  end if;
  perform private.audit(v_uid, 'order.' || v_step, 'orders/' || v_order.id, jsonb_build_object('trackingCode', v_order.tracking_code));
  return jsonb_build_object('orderId', v_order.id, 'status', v_order.status);
end;
$$;

/** The delivery address, only while it is needed to send the parcel, and never without an audit entry. */
create or replace function private.admin_order_contact(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  v_order_id text := private.req_id(coalesce(payload, '{}'::jsonb), 'orderId', '^[a-f0-9]{64}$');
  v_order public.orders;
  v_contact jsonb;
begin
  select * into v_order from public.orders where id = v_order_id;
  if not found then
    perform private.fail('not-found', 'Order was not found.');
  end if;
  if v_order.status not in ('paid', 'shipped') then
    perform private.fail('failed-precondition', 'The delivery address is only available while an order is being shipped.');
  end if;
  select extensions.pgp_sym_decrypt(c.contact_enc, private.pii_key())::jsonb into v_contact
    from private.order_contacts c where c.order_id = v_order_id;
  perform private.audit(v_uid, 'order.contact_read', 'orders/' || v_order_id, '{}'::jsonb);
  return jsonb_build_object('orderId', v_order_id, 'contact', coalesce(v_contact, '{}'::jsonb));
end;
$$;

create or replace function private.admin_list_marketplace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
begin
  return jsonb_build_object(
    'feeBps', private.platform_fee_bps(),
    'shopOpen', private.shop_open(),
    'farms', coalesce((select jsonb_agg(jsonb_build_object('farmId', f.farm_id, 'name', f.name, 'nameEn', f.name_en,
        'countryCode', f.country_code, 'listed', f.status = 'listed') order by f.farm_id) from public.farms f), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('productId', pr.id, 'farmId', pr.farm_id,
        'farmName', f.name, 'farmNameEn', f.name_en, 'category', pr.category, 'name', pr.name, 'nameEn', pr.name_en,
        'description', pr.description, 'descriptionEn', pr.description_en, 'unit', pr.unit,
        'priceMinor', pr.price_minor, 'currency', pr.currency, 'stockUnits', pr.stock_units, 'status', pr.status,
        'reviewNote', pr.review_note, 'updatedAt', private.epoch_ms(pr.updated_at))
        order by (pr.status = 'pending_review') desc, pr.updated_at desc)
        from public.products pr join public.farms f on f.farm_id = pr.farm_id), '[]'::jsonb),
    'shippingRates', coalesce((select jsonb_agg(jsonb_build_object('originCountry', r.origin_country,
        'destCountry', r.dest_country, 'amountMinor', r.amount_minor, 'currency', r.currency, 'active', r.active)
        order by r.origin_country, r.dest_country) from public.shipping_rates r), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('farmId', m.farm_id, 'userId', m.user_id,
        'displayName', coalesce(pf.display_name, ''), 'addedAt', private.epoch_ms(m.added_at))
        order by m.farm_id, m.added_at)
        from public.farm_members m left join public.profiles pf on pf.id = m.user_id
       where m.revoked_at is null), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(private.order_summary(o) || jsonb_build_object('screening',
          (select jsonb_build_object('result', sc.result, 'listsChecked', sc.lists_checked, 'checkedAt', private.epoch_ms(sc.checked_at),
                    'current', sc.checked_at > now() - interval '30 days')
             from private.order_screenings sc where sc.order_id = o.id order by sc.checked_at desc, sc.id desc limit 1))
        order by o.created_at desc)
        from (select * from public.orders order by created_at desc limit 200) o), '[]'::jsonb),
    'balances', coalesce((select jsonb_agg(jsonb_build_object('farmId', b.farm_id, 'currency', b.currency,
        'amountMinor', b.amount_minor) order by b.farm_id, b.currency)
        from (select l.farm_id, l.currency, sum(l.amount_minor)::bigint as amount_minor
                from private.farm_ledger l group by l.farm_id, l.currency) b), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Account deletion: open orders block it, delivery addresses are removed with the account.
-- (Full redefinition of the function from migration 20261110000210; only the two order passages are new.)
-- ---------------------------------------------------------------------------------------------------------------

create or replace function private.delete_my_account(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_role text := private.current_app_role();
  c_gone constant uuid := '00000000-0000-0000-0000-000000000000'; -- "deleted account" marker, never a real user
begin
  if coalesce(payload ->> 'confirmation', '') <> 'DELETE' then
    perform private.fail('invalid-argument', 'Type DELETE to confirm account deletion.');
  end if;
  if exists (select 1 from public.investment_requests
              where user_id = v_uid and status in ('awaiting_payment', 'under_review')) then
    perform private.fail('failed-precondition', 'Cancel or complete your open investment requests before deleting the account.');
  end if;
  if exists (select 1 from public.shares where user_id = v_uid and status = 'active') then
    perform private.fail('failed-precondition', 'Your account still holds active shares. Please contact support to settle or transfer them first.');
  end if;
  if exists (select 1 from public.oil_requests where user_id = v_uid and status in ('pending', 'approved')) then
    perform private.fail('failed-precondition', 'Cancel or wait for your open oil requests before deleting the account.');
  end if;
  if exists (select 1 from public.orders
              where user_id = v_uid and status in ('awaiting_payment', 'under_review', 'paid', 'shipped')) then
    perform private.fail('failed-precondition', 'Cancel your open orders or wait until they are delivered before deleting the account.');
  end if;
  if v_role = 'admin' and (select count(*) from private.user_roles where role = 'admin') <= 1 then
    perform private.fail('failed-precondition', 'The last administrator account cannot delete itself. Appoint another admin first.');
  end if;

  -- Oil-delivery contacts (encrypted PII) go; requests/allocations stay as pseudonymised bookkeeping.
  delete from private.oil_request_contacts c
   using public.oil_requests r
   where c.request_id = r.id and r.user_id = v_uid;

  -- Delivery addresses of the person's orders go too; the orders stay as pseudonymised bookkeeping.
  delete from private.order_contacts c
   using public.orders o
   where c.order_id = o.id and o.user_id = v_uid;

  -- Farmer field data: unreviewed reports vanish, published ones keep the public text but lose GPS and media;
  -- every object the person uploaded to the private bucket is removed.
  delete from public.tree_events_public e
   using public.farmer_updates u
   where e.update_id = u.id and u.farmer_uid = v_uid and u.status <> 'published';
  delete from public.farmer_updates where farmer_uid = v_uid and status <> 'published';
  update public.farmer_updates
     set gps_lat = null, gps_lng = null, media_paths = '{}'
   where farmer_uid = v_uid;
  update public.tree_events_public e
     set media_count = 0
    from public.farmer_updates u
   where e.update_id = u.id and u.farmer_uid = v_uid;
  -- Objects cannot be removed from storage.objects directly (storage.protect_delete); the purge runs via the
  -- Storage API in the Edge Function purge-storage (migration 27), which removes rows AND blobs.
  perform private.enqueue_storage_purge('field-media', v_uid::text || '/', 'account_deleted');

  -- Gifts: an open code of a leaving buyer can no longer be redeemed (defensive; active shares block deletion
  -- anyway). Redeemed gifts stay for the counterpart with the leaving side pseudonymised.
  update public.gifts set status = 'cancelled' where buyer_uid = v_uid and status = 'open';
  update public.gifts set buyer_uid = c_gone where buyer_uid = v_uid;
  update public.gifts set redeemed_by_uid = c_gone where redeemed_by_uid = v_uid;

  -- Referrals: own credits vanish (they are personal and unusable after deletion); the relation row stays
  -- pseudonymised so the counterpart's rewarded/void history and the yearly cap remain correct.
  delete from public.reward_credits where user_id = v_uid;
  update public.referrals set status = 'void' where (referrer_uid = v_uid or referred_uid = v_uid) and status = 'pending';
  update public.referrals set referrer_uid = c_gone where referrer_uid = v_uid;
  update public.referrals set referred_uid = c_gone where referred_uid = v_uid;

  -- Checkout extras of the person's own requests (recipient name/message are free text they typed) and any
  -- pointer to them as referrer on other people's requests.
  update private.request_extras x
     set gift_recipient_name = null, gift_message = null
    from public.investment_requests r
   where x.request_id = r.id and r.user_id = v_uid;
  update private.request_extras set referrer_uid = null where referrer_uid = v_uid;

  -- Profile, role application, role, assignments, farmer profile cascade from auth.users.
  -- Financial records stay keyed by the orphaned uid for bookkeeping retention [PLATZHALTER: Aufbewahrungsfrist].
  perform private.audit(v_uid, 'account.deleted', 'profiles/' || v_uid, jsonb_build_object('role', v_role));
  delete from auth.users where id = v_uid;
  return jsonb_build_object('deleted', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Data export (right of access): the person's orders with their own delivery address, while it is still stored.
-- (Full redefinition of the function from migration 20261111000100; only the 'orders' entry is new.)
-- ---------------------------------------------------------------------------------------------------------------

create or replace function private.export_my_data(payload jsonb)
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
    'pressingBatches', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.pressing_batches x where x.submitted_by_uid = v_uid), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(private.order_summary(o) || jsonb_build_object('deliveryContact',
        (select extensions.pgp_sym_decrypt(c.contact_enc, private.pii_key())::jsonb from private.order_contacts c where c.order_id = o.id))
        order by o.created_at) from public.orders o where o.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Housekeeping jobs
-- ---------------------------------------------------------------------------------------------------------------

create or replace function private.expire_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_count integer := 0;
begin
  for v_order in
    select id, user_id, total_minor, currency from public.orders
     where status = 'awaiting_payment' and expires_at <= now()
     order by expires_at
     limit 100
     for update skip locked
  loop
    perform 1 from public.products where id in (select product_id from public.order_items where order_id = v_order.id)
      order by id for update;
    perform private.order_release_stock(v_order.id);
    update public.orders set status = 'expired', updated_at = now() where id = v_order.id;
    perform private.notify_user(v_order.user_id, 'order_expired', jsonb_build_object('orderId', v_order.id,
      'amountMinor', v_order.total_minor, 'currency', v_order.currency));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

/** Delivery addresses are kept only as long as a parcel can still need them.
    [PLATZHALTER: Frist von 90 Tagen nach Abschluss rechtlich bestätigen (Gewährleistung, Reklamation).] */
create or replace function private.purge_order_contacts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from private.order_contacts c
   using public.orders o
   where c.order_id = o.id
     and o.status in ('delivered', 'cancelled', 'expired', 'rejected', 'refunded')
     and o.updated_at < now() - interval '90 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname in ('faseela-expire-orders', 'faseela-purge-order-contacts');
select cron.schedule('faseela-expire-orders', '*/10 * * * *', $job$select private.expire_orders()$job$);
select cron.schedule('faseela-purge-order-contacts', '35 2 * * *', $job$select private.purge_order_contacts()$job$);

-- ---------------------------------------------------------------------------------------------------------------
-- Public wrappers (the only functions the API exposes) and grants
-- ---------------------------------------------------------------------------------------------------------------

create or replace function public.marketplace_config() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('marketplace_config', 60, 60); select private.marketplace_config(); $$;
create or replace function public.quote_order(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('quote_order', 60, 60); select private.quote_order(payload); $$;
create or replace function public.create_order(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('create_order', 10, 3600); select private.create_order(payload); $$;
create or replace function public.report_order_payment(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_write', 30, 3600); select private.report_order_payment(payload); $$;
create or replace function public.cancel_my_order(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_write', 30, 3600); select private.cancel_my_order(payload); $$;
create or replace function public.list_my_orders() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_read', 120, 60); select private.list_my_orders(); $$;
create or replace function public.farmer_upsert_product(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('product_write', 60, 3600); select private.farmer_upsert_product(payload); $$;
create or replace function public.farmer_set_product_stock(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('product_write', 60, 3600); select private.farmer_set_product_stock(payload); $$;
create or replace function public.farm_overview() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_read', 120, 60); select private.farm_overview(); $$;
create or replace function public.admin_set_farm_member(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_farm_member(payload); $$;
create or replace function public.admin_review_product(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_review_product(payload); $$;
create or replace function public.admin_set_shipping_rate(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_shipping_rate(payload); $$;
create or replace function public.admin_set_platform_fee(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_platform_fee(payload); $$;
create or replace function public.review_order_payment(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.review_order_payment(payload); $$;
create or replace function public.record_order_screening(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.record_order_screening(payload); $$;
create or replace function public.order_payer(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_contact', 60, 3600); select private.order_payer(payload); $$;
create or replace function public.refund_order(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.refund_order(payload); $$;
create or replace function public.record_farm_payout(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.record_farm_payout(payload); $$;
create or replace function public.admin_set_shop_open(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_shop_open(payload); $$;
create or replace function public.admin_set_order_fulfilment(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_order_fulfilment(payload); $$;
create or replace function public.admin_order_contact(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_contact', 60, 3600); select private.admin_order_contact(payload); $$;
create or replace function public.admin_list_marketplace() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_list_marketplace(); $$;

revoke all on function
  private.shop_open(), private.record_order_screening(jsonb), private.order_payer(jsonb), private.refund_order(jsonb), private.record_farm_payout(jsonb), private.admin_set_shop_open(jsonb),
  public.record_order_screening(jsonb), public.order_payer(jsonb), public.refund_order(jsonb), public.record_farm_payout(jsonb), public.admin_set_shop_open(jsonb),
  private.is_farm_member(text), private.platform_fee_bps(), private.order_quote(jsonb, boolean),
  private.order_release_stock(text), private.order_summary(public.orders), private.own_order_for_update(jsonb, uuid),
  private.marketplace_config(), private.quote_order(jsonb), private.create_order(jsonb),
  private.report_order_payment(jsonb), private.cancel_my_order(jsonb), private.list_my_orders(),
  private.farmer_upsert_product(jsonb), private.farmer_set_product_stock(jsonb), private.farm_overview(),
  private.admin_set_farm_member(jsonb), private.admin_review_product(jsonb), private.admin_set_shipping_rate(jsonb),
  private.admin_set_platform_fee(jsonb), private.review_order_payment(jsonb), private.admin_set_order_fulfilment(jsonb),
  private.admin_order_contact(jsonb), private.admin_list_marketplace(), private.expire_orders(),
  private.purge_order_contacts(),
  public.marketplace_config(), public.quote_order(jsonb), public.create_order(jsonb), public.report_order_payment(jsonb),
  public.cancel_my_order(jsonb), public.list_my_orders(), public.farmer_upsert_product(jsonb),
  public.farmer_set_product_stock(jsonb), public.farm_overview(), public.admin_set_farm_member(jsonb),
  public.admin_review_product(jsonb), public.admin_set_shipping_rate(jsonb), public.admin_set_platform_fee(jsonb),
  public.review_order_payment(jsonb), public.admin_set_order_fulfilment(jsonb), public.admin_order_contact(jsonb),
  public.admin_list_marketplace()
  from public, anon, authenticated;

-- Used inside row policies, so the querying role must be able to call it. It only answers about the caller.
grant execute on function private.is_farm_member(text) to authenticated;

grant execute on function private.marketplace_config(), public.marketplace_config() to anon, authenticated;

grant execute on function
  private.record_order_screening(jsonb), private.order_payer(jsonb), private.refund_order(jsonb), private.record_farm_payout(jsonb), private.admin_set_shop_open(jsonb),
  public.record_order_screening(jsonb), public.order_payer(jsonb), public.refund_order(jsonb), public.record_farm_payout(jsonb), public.admin_set_shop_open(jsonb),
  private.quote_order(jsonb), private.create_order(jsonb), private.report_order_payment(jsonb),
  private.cancel_my_order(jsonb), private.list_my_orders(), private.farmer_upsert_product(jsonb),
  private.farmer_set_product_stock(jsonb), private.farm_overview(), private.admin_set_farm_member(jsonb),
  private.admin_review_product(jsonb), private.admin_set_shipping_rate(jsonb), private.admin_set_platform_fee(jsonb),
  private.review_order_payment(jsonb), private.admin_set_order_fulfilment(jsonb), private.admin_order_contact(jsonb),
  private.admin_list_marketplace(),
  public.quote_order(jsonb), public.create_order(jsonb), public.report_order_payment(jsonb),
  public.cancel_my_order(jsonb), public.list_my_orders(), public.farmer_upsert_product(jsonb),
  public.farmer_set_product_stock(jsonb), public.farm_overview(), public.admin_set_farm_member(jsonb),
  public.admin_review_product(jsonb), public.admin_set_shipping_rate(jsonb), public.admin_set_platform_fee(jsonb),
  public.review_order_payment(jsonb), public.admin_set_order_fulfilment(jsonb), public.admin_order_contact(jsonb),
  public.admin_list_marketplace()
  to authenticated;
