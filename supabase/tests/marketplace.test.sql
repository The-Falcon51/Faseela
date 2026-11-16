-- Faseela marketplace suite (migration 50). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := '5a000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := '5a000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_c constant uuid := '5a000000-0000-4000-8000-0000000000c1'; -- customer
  c_d constant uuid := '5a000000-0000-4000-8000-0000000000d1'; -- another customer
  c_g constant uuid := '5a000000-0000-4000-8000-0000000000e1'; -- farmer, member of farm A
  c_h constant uuid := '5a000000-0000-4000-8000-0000000000e2'; -- farmer, member of farm B
  c_u constant uuid := '5a000000-0000-4000-8000-0000000000b1'; -- customer without a verified e-mail
  c_p1 constant jsonb := '{"farmId":"farm_mk_a","category":"oil","name":"زيت زيتون بكر","nameEn":"Extra virgin olive oil","unit":"500 ml","priceMinor":1200,"currency":"EUR","stockUnits":10}';
  c_order constant jsonb := '{"idempotencyKey":"market-test-key-0001","contact":{"name":"Kunde Geheim","phone":"+49 30 000","addressLine1":"Geheimweg 7","postalCode":"10115","city":"Berlin","country":"DE"}}';
  v_j jsonb; v_n integer; v_items jsonb;
  v_p1 uuid; v_p2 uuid; v_p3 uuid;
  v_o1 text; v_o2 text; v_o3 text; v_o4 text; v_o5 text;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_anon() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true); perform set_config('role','anon',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;
  create function pg_temp.call_as(p uuid, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p); return pg_temp.try(p_sql); end $f$;

  -- try() falls back to the superuser after a refusal, so every anonymous attempt re-enters the anon role first.
  create function pg_temp.anon_try(p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_anon(); return pg_temp.try(p_sql); end $f$;
  create function pg_temp.cnt(p_sql text) returns integer language plpgsql as $f$
  declare n integer; begin execute p_sql into n; return n; end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', case when u.id = c_u then null else now() end, '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'ka@t.faseela.invalid', 'Market Admin'), (c_f, 'kf@t.faseela.invalid', 'Market Finance'), (c_c, 'kc@t.faseela.invalid', 'Market Customer'),
               (c_d, 'kd@t.faseela.invalid', 'Other Customer'), (c_g, 'kg@t.faseela.invalid', 'Farmer A'), (c_h, 'kh@t.faseela.invalid', 'Farmer B'),
               (c_u, 'ku@t.faseela.invalid', 'Unverified')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin'), (c_g, 'farmer'), (c_h, 'farmer');
  delete from private.rate_limits;

  -- ---------------------------------------------------------------- setup by the admin
  perform pg_temp.as_user(c_a);
  perform public.admin_upsert_farm('{"farmId":"farm_mk_a","countryCode":"SY","name":"مزرعة أ","nameEn":"Farm A","region":"إدلب","regionEn":"Idlib","status":"listed"}');
  perform public.admin_upsert_farm('{"farmId":"farm_mk_b","countryCode":"SY","name":"مزرعة ب","nameEn":"Farm B","region":"حلب","regionEn":"Aleppo","status":"listed"}');
  perform pg_temp.chk('customer cannot be made a farm member', pg_temp.call_as(c_a, format($q$select public.admin_set_farm_member('{"farmId":"farm_mk_a","userId":"%s"}')$q$, c_c)) = 'failed-precondition');
  perform pg_temp.chk('unknown farm refused for membership', pg_temp.call_as(c_a, format($q$select public.admin_set_farm_member('{"farmId":"farm_nope","userId":"%s"}')$q$, c_g)) = 'not-found');
  perform pg_temp.chk('admin adds farmer to farm A', pg_temp.call_as(c_a, format($q$select public.admin_set_farm_member('{"farmId":"farm_mk_a","userId":"%s"}')$q$, c_g)) = 'OK');
  perform pg_temp.chk('admin adds farmer to farm B', pg_temp.call_as(c_a, format($q$select public.admin_set_farm_member('{"farmId":"farm_mk_b","userId":"%s"}')$q$, c_h)) = 'OK');
  perform pg_temp.chk('customer cannot manage members', pg_temp.call_as(c_c, format($q$select public.admin_set_farm_member('{"farmId":"farm_mk_a","userId":"%s"}')$q$, c_h)) = 'permission-denied');
  perform pg_temp.chk('finance cannot manage members', pg_temp.call_as(c_f, format($q$select public.admin_set_farm_member('{"farmId":"farm_mk_a","userId":"%s"}')$q$, c_h)) = 'permission-denied');
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon reads the fee rate', (public.marketplace_config()->>'feeBps')::int = 1500);
  perform pg_temp.chk('anon cannot read memberships', pg_temp.anon_try($q$select count(*) from public.farm_members$q$) <> 'OK');
  perform pg_temp.as_user(c_h);
  perform pg_temp.chk('farmer sees only own membership', pg_temp.cnt($q$select count(*) from public.farm_members$q$) = 1);

  -- ---------------------------------------------------------------- products: who may write
  perform pg_temp.chk('customer cannot submit a product', pg_temp.call_as(c_c, format('select public.farmer_upsert_product(%L)', c_p1)) = 'permission-denied');
  perform pg_temp.chk('farmer of another farm cannot submit', pg_temp.call_as(c_h, format('select public.farmer_upsert_product(%L)', c_p1)) = 'permission-denied');
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot submit a product', pg_temp.anon_try(format('select public.farmer_upsert_product(%L)', c_p1)) <> 'OK');
  perform pg_temp.chk('zero price refused', pg_temp.call_as(c_g, format('select public.farmer_upsert_product(%L)', c_p1 || '{"priceMinor":0}')) = 'invalid-argument');
  perform pg_temp.chk('unknown category refused', pg_temp.call_as(c_g, format('select public.farmer_upsert_product(%L)', c_p1 || '{"category":"weapons"}')) = 'invalid-argument');
  perform pg_temp.chk('unknown currency refused', pg_temp.call_as(c_g, format('select public.farmer_upsert_product(%L)', c_p1 || '{"currency":"XXX"}')) = 'invalid-argument');
  perform pg_temp.as_user(c_g);
  v_j := public.farmer_upsert_product(c_p1);
  v_p1 := (v_j->>'productId')::uuid;
  perform pg_temp.chk('farmer submits a product, waits for review', v_j->>'status' = 'pending_review', v_j::text);
  v_p2 := (public.farmer_upsert_product(c_p1 || '{"name":"زيتون أخضر","nameEn":"Green olives","category":"olives","priceMinor":500,"stockUnits":3}')->>'productId')::uuid;
  perform pg_temp.as_user(c_h);
  v_p3 := (public.farmer_upsert_product(c_p1 || '{"farmId":"farm_mk_b","nameEn":"Farm B oil","priceMinor":2000}')->>'productId')::uuid;
  perform pg_temp.chk('other farmer does not see the pending product', pg_temp.cnt(format($q$select count(*) from public.products where id = '%s'$q$, v_p1)) = 0);
  perform pg_temp.chk('other farmer cannot change its stock', pg_temp.call_as(c_h, format($q$select public.farmer_set_product_stock('{"productId":"%s","stockUnits":999}')$q$, v_p1)) = 'not-found');
  perform pg_temp.chk('other farmer cannot edit it', pg_temp.call_as(c_h, format('select public.farmer_upsert_product(%L)', c_p1 || jsonb_build_object('farmId', 'farm_mk_b', 'productId', v_p1))) = 'not-found');
  perform pg_temp.as_user(c_g);
  perform pg_temp.chk('farmer sees own pending products', pg_temp.cnt($q$select count(*) from public.products where farm_id = 'farm_mk_a'$q$) = 2);
  perform pg_temp.as_anon();
  perform pg_temp.chk('unreviewed products are not in the shop', pg_temp.cnt($q$select count(*) from public.products$q$) = 0);
  perform pg_temp.chk('farmer cannot list own product', pg_temp.call_as(c_g, format($q$select public.admin_review_product('{"productId":"%s","decision":"list"}')$q$, v_p1)) = 'permission-denied');
  perform pg_temp.chk('farmer cannot list by direct update', pg_temp.call_as(c_g, format($q$update public.products set status = 'listed' where id = '%s'$q$, v_p1)) <> 'OK');
  perform pg_temp.chk('rejection needs a reason', pg_temp.call_as(c_a, format($q$select public.admin_review_product('{"productId":"%s","decision":"reject"}')$q$, v_p1)) = 'invalid-argument');
  perform pg_temp.chk('admin lists products', pg_temp.call_as(c_a, format($q$select public.admin_review_product('{"productId":"%s","decision":"list"}')$q$, v_p1)) = 'OK'
    and pg_temp.call_as(c_a, format($q$select public.admin_review_product('{"productId":"%s","decision":"list"}')$q$, v_p2)) = 'OK'
    and pg_temp.call_as(c_a, format($q$select public.admin_review_product('{"productId":"%s","decision":"list"}')$q$, v_p3)) = 'OK');
  perform pg_temp.as_anon();
  perform pg_temp.chk('listed products are in the shop', pg_temp.cnt($q$select count(*) from public.products where farm_id like 'farm_mk_%'$q$) = 3);
  perform pg_temp.chk('internal product columns are not readable', pg_temp.anon_try($q$select created_by from public.products$q$) <> 'OK' and pg_temp.anon_try($q$select review_note from public.products$q$) <> 'OK');
  perform pg_temp.chk('anon cannot change a price', pg_temp.anon_try($q$update public.products set price_minor = 1$q$) <> 'OK');
  perform pg_temp.chk('customer cannot change price, stock or insert', pg_temp.call_as(c_c, $q$update public.products set price_minor = 1$q$) <> 'OK'
    and pg_temp.call_as(c_c, $q$update public.products set stock_units = 999999$q$) <> 'OK'
    and pg_temp.call_as(c_c, $q$insert into public.products (farm_id, category, name, unit, price_minor, currency, status) values ('farm_mk_a', 'oil', 'evil', 'x', 1, 'EUR', 'listed')$q$) <> 'OK'
    and pg_temp.call_as(c_c, $q$delete from public.products$q$) <> 'OK');

  -- ---------------------------------------------------------------- pricing
  perform pg_temp.chk('closed shop takes no quote and no order', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":2}]}')$q$, v_p1)) = 'shop-closed'
    and pg_temp.call_as(c_c, format('select public.create_order(%L)', c_order || jsonb_build_object('items', jsonb_build_array(jsonb_build_object('productId', v_p1, 'quantity', 1))))) = 'shop-closed');
  perform pg_temp.as_anon();
  perform pg_temp.chk('visitors are told the shop is closed', (public.marketplace_config()->>'shopOpen')::boolean = false);
  perform pg_temp.chk('customer cannot open the shop', pg_temp.call_as(c_c, $q$select public.admin_set_shop_open('{"open":true}')$q$) = 'permission-denied');
  perform pg_temp.chk('finance cannot open the shop', pg_temp.call_as(c_f, $q$select public.admin_set_shop_open('{"open":true}')$q$) = 'permission-denied');
  perform pg_temp.chk('open must be a boolean', pg_temp.call_as(c_a, $q$select public.admin_set_shop_open('{"open":"yes"}')$q$) = 'invalid-argument');
  perform pg_temp.chk('admin opens the shop', pg_temp.call_as(c_a, $q$select public.admin_set_shop_open('{"open":true}')$q$) = 'OK');
  perform pg_temp.chk('no shipping rate, no order', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":2}]}')$q$, v_p1)) = 'no-shipping-rate');
  perform pg_temp.chk('customer cannot set a shipping rate', pg_temp.call_as(c_c, $q$select public.admin_set_shipping_rate('{"originCountry":"SY","destCountry":"DE","amountMinor":0,"currency":"EUR"}')$q$) = 'permission-denied');
  perform pg_temp.chk('customer cannot write a rate directly', pg_temp.call_as(c_c, $q$insert into public.shipping_rates values ('SY', 'DE', 0, 'EUR', true)$q$) <> 'OK');
  perform pg_temp.chk('rate from an unknown country refused', pg_temp.call_as(c_a, $q$select public.admin_set_shipping_rate('{"originCountry":"ZZ","destCountry":"DE","amountMinor":900,"currency":"EUR"}')$q$) = 'not-found');
  perform pg_temp.chk('admin sets a shipping rate', pg_temp.call_as(c_a, $q$select public.admin_set_shipping_rate('{"originCountry":"SY","destCountry":"DE","amountMinor":900,"currency":"EUR"}')$q$) = 'OK');
  perform pg_temp.as_user(c_c);
  v_j := public.quote_order(jsonb_build_object('destCountry', 'DE', 'items', jsonb_build_array(jsonb_build_object('productId', v_p1, 'quantity', 2))));
  perform pg_temp.chk('quote: fee is inside the price, nothing added', (v_j->>'itemsMinor')::int = 2400 and (v_j->>'feeMinor')::int = 360 and (v_j->>'feeBps')::int = 1500
    and (v_j->>'farmNetMinor')::int = 2040 and (v_j->>'shippingMinor')::int = 900 and (v_j->>'totalMinor')::int = 3300, v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('a quote reserves nothing', (select stock_units from public.products where id = v_p1) = 10 and not exists (select 1 from public.orders where user_id = c_c));
  perform pg_temp.chk('products of two farms refused', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":1},{"productId":"%s","quantity":1}]}')$q$, v_p1, v_p3)) = 'mixed-farms');
  perform pg_temp.chk('quantity 0 refused', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":0}]}')$q$, v_p1)) = 'invalid-argument');
  perform pg_temp.chk('negative quantity refused', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":-3}]}')$q$, v_p1)) = 'invalid-argument');
  perform pg_temp.chk('fractional quantity refused', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":1.5}]}')$q$, v_p1)) = 'invalid-argument');
  perform pg_temp.chk('same product twice refused', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":1},{"productId":"%s","quantity":1}]}')$q$, v_p1, v_p1)) = 'invalid-argument');
  perform pg_temp.chk('empty order refused', pg_temp.call_as(c_c, $q$select public.quote_order('{"destCountry":"DE","items":[]}')$q$) = 'invalid-argument');
  perform pg_temp.chk('unknown product refused', pg_temp.call_as(c_c, $q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"00000000-0000-4000-8000-000000000000","quantity":1}]}')$q$) = 'product-unavailable');
  perform pg_temp.chk('more than the stock refused', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":4}]}')$q$, v_p2)) = 'out-of-stock');
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot quote or order', pg_temp.anon_try(format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":1}]}')$q$, v_p1)) <> 'OK'
    and pg_temp.anon_try(format('select public.create_order(%L)', c_order)) <> 'OK');

  -- ---------------------------------------------------------------- fee setting
  perform pg_temp.chk('customer cannot change the fee', pg_temp.call_as(c_c, $q$select public.admin_set_platform_fee('{"feeBps":0}')$q$) = 'permission-denied');
  perform pg_temp.chk('finance cannot change the fee', pg_temp.call_as(c_f, $q$select public.admin_set_platform_fee('{"feeBps":0}')$q$) = 'permission-denied');
  perform pg_temp.chk('fee above 30 % refused', pg_temp.call_as(c_a, $q$select public.admin_set_platform_fee('{"feeBps":3001}')$q$) = 'invalid-argument');

  -- ---------------------------------------------------------------- ordering
  v_items := jsonb_build_object('items', jsonb_build_array(jsonb_build_object('productId', v_p1, 'quantity', 2)));
  perform pg_temp.chk('unverified e-mail cannot order', pg_temp.call_as(c_u, format('select public.create_order(%L)', c_order || v_items)) <> 'OK');
  perform pg_temp.chk('order without an address refused', pg_temp.call_as(c_c, format('select public.create_order(%L)', c_order || v_items || '{"contact":{"name":"Kunde Geheim","country":"DE"}}')) = 'invalid-argument');
  perform pg_temp.chk('order to a country without a rate refused', pg_temp.call_as(c_c, format('select public.create_order(%L)', c_order || v_items || '{"contact":{"name":"Kunde Geheim","addressLine1":"Weg 1","city":"Paris","country":"FR"}}')) = 'no-shipping-rate');
  perform pg_temp.chk('short idempotency key refused', pg_temp.call_as(c_c, format('select public.create_order(%L)', c_order || v_items || '{"idempotencyKey":"short"}')) = 'invalid-argument');
  perform pg_temp.as_user(c_c);
  v_j := public.create_order(c_order || v_items);
  v_o1 := v_j->>'orderId';
  perform pg_temp.chk('order created with server-side totals', v_j->>'status' = 'awaiting_payment' and (v_j->>'totalMinor')::int = 3300 and (v_j->>'feeMinor')::int = 360
    and v_j->>'paymentReference' ~ '^FO-[0-9A-F]{10}$' and jsonb_array_length(v_j->'lines') = 1 and not (v_j->>'replayed')::boolean, v_j::text);
  v_j := public.create_order(c_order || v_items || '{"items":[]}'::jsonb);
  perform pg_temp.chk('same key returns the same order', v_j->>'orderId' = v_o1 and (v_j->>'replayed')::boolean, v_j::text);
  perform pg_temp.chk('customer reads own order and lines', pg_temp.cnt($q$select count(*) from public.orders$q$) = 1 and pg_temp.cnt($q$select count(*) from public.order_items$q$) = 1);
  perform pg_temp.chk('customer cannot read internal order columns', pg_temp.call_as(c_c, $q$select reviewed_by_uid from public.orders$q$) <> 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('one order, stock taken once', (select count(*) from public.orders where user_id = c_c) = 1 and (select stock_units from public.products where id = v_p1) = 8);
  perform pg_temp.chk('address stored encrypted only', (select position('Kunde' in encode(contact_enc, 'escape')) = 0 and position('Geheimweg' in encode(contact_enc, 'escape')) = 0 from private.order_contacts where order_id = v_o1)
    and not exists (select 1 from public.audit_logs where details::text like '%Geheimweg%' or details::text like '%Kunde Geheim%'));

  -- ---------------------------------------------------------------- isolation between customers and farms
  perform pg_temp.as_user(c_d);
  perform pg_temp.chk('other customer sees no foreign order', pg_temp.cnt($q$select count(*) from public.orders$q$) = 0 and pg_temp.cnt($q$select count(*) from public.order_items$q$) = 0
    and jsonb_array_length(public.list_my_orders()->'orders') = 0);
  perform pg_temp.chk('other customer cannot cancel it', pg_temp.call_as(c_d, format($q$select public.cancel_my_order('{"orderId":"%s"}')$q$, v_o1)) = 'not-found');
  perform pg_temp.chk('other customer cannot report its payment', pg_temp.call_as(c_d, format($q$select public.report_order_payment('{"orderId":"%s"}')$q$, v_o1)) = 'not-found');
  perform pg_temp.chk('customer cannot edit an order', pg_temp.call_as(c_c, $q$update public.orders set status = 'paid'$q$) <> 'OK' and pg_temp.call_as(c_c, $q$update public.order_items set quantity = 50$q$) <> 'OK'
    and pg_temp.call_as(c_c, $q$delete from public.orders$q$) <> 'OK');
  perform pg_temp.chk('customer cannot approve own payment', pg_temp.call_as(c_c, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o1)) = 'permission-denied');
  perform pg_temp.chk('customer cannot read addresses, ledger or staff lists', pg_temp.call_as(c_c, $q$select count(*) from private.order_contacts$q$) <> 'OK'
    and pg_temp.call_as(c_c, $q$select count(*) from private.farm_ledger$q$) <> 'OK'
    and pg_temp.call_as(c_c, format($q$select public.admin_order_contact('{"orderId":"%s"}')$q$, v_o1)) = 'permission-denied'
    and pg_temp.call_as(c_c, $q$select public.admin_list_marketplace()$q$) = 'permission-denied');
  perform pg_temp.chk('customer cannot run internal functions', pg_temp.call_as(c_c, $q$select private.expire_orders()$q$) <> 'OK'
    and pg_temp.call_as(c_c, format($q$select private.order_release_stock('%s')$q$, v_o1)) <> 'OK'
    and pg_temp.call_as(c_c, $q$select private.purge_order_contacts()$q$) <> 'OK');
  perform pg_temp.as_user(c_g);
  perform pg_temp.chk('farm member sees the farm order', pg_temp.cnt($q$select count(*) from public.orders$q$) = 1);
  perform pg_temp.chk('farm member cannot read the address', pg_temp.call_as(c_g, format($q$select public.admin_order_contact('{"orderId":"%s"}')$q$, v_o1)) = 'permission-denied'
    and pg_temp.call_as(c_g, $q$select count(*) from private.order_contacts$q$) <> 'OK');
  perform pg_temp.chk('farm member cannot approve a payment', pg_temp.call_as(c_g, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o1)) = 'permission-denied');
  perform pg_temp.as_user(c_h);
  perform pg_temp.chk('member of another farm sees nothing', pg_temp.cnt($q$select count(*) from public.orders$q$) = 0 and pg_temp.cnt($q$select count(*) from public.order_items$q$) = 0);

  -- ---------------------------------------------------------------- an order keeps its own prices
  perform pg_temp.chk('admin raises the fee', pg_temp.call_as(c_a, $q$select public.admin_set_platform_fee('{"feeBps":2000}')$q$) = 'OK');
  perform pg_temp.chk('farmer raises the price', pg_temp.call_as(c_g, format('select public.farmer_upsert_product(%L)', (c_p1 || jsonb_build_object('productId', v_p1, 'priceMinor', 1500)) - 'stockUnits')) = 'OK');
  perform pg_temp.as_anon();
  perform pg_temp.chk('a changed product leaves the shop until reviewed', pg_temp.cnt(format($q$select count(*) from public.products where id = '%s'$q$, v_p1)) = 0);
  perform pg_temp.chk('and cannot be ordered meanwhile', pg_temp.call_as(c_d, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":1}]}')$q$, v_p1)) = 'product-unavailable');
  perform pg_temp.chk('admin lists it again', pg_temp.call_as(c_a, format($q$select public.admin_review_product('{"productId":"%s","decision":"list"}')$q$, v_p1)) = 'OK');
  perform pg_temp.as_user(c_d);
  v_j := public.quote_order(jsonb_build_object('destCountry', 'DE', 'items', jsonb_build_array(jsonb_build_object('productId', v_p1, 'quantity', 1))));
  perform pg_temp.chk('new quotes use new price and fee', (v_j->>'itemsMinor')::int = 1500 and (v_j->>'feeMinor')::int = 300 and (v_j->>'farmNetMinor')::int = 1200 and (v_j->>'totalMinor')::int = 2400, v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('the existing order is unchanged', (select fee_bps = 1500 and fee_minor = 360 and total_minor = 3300 from public.orders where id = v_o1)
    and (select unit_price_minor = 1200 from public.order_items where order_id = v_o1) and (select stock_units from public.products where id = v_p1) = 8);
  perform pg_temp.chk('totals cannot drift from their parts', pg_temp.try(format($q$update public.orders set total_minor = total_minor + 1 where id = '%s'$q$, v_o1)) <> 'OK');
  perform pg_temp.chk('admin restores the fee', pg_temp.call_as(c_a, $q$select public.admin_set_platform_fee('{"feeBps":1500}')$q$) = 'OK');

  -- ---------------------------------------------------------------- cancel
  perform pg_temp.chk('customer cancels', pg_temp.call_as(c_c, format($q$select public.cancel_my_order('{"orderId":"%s"}')$q$, v_o1)) = 'OK'
    and pg_temp.call_as(c_c, format($q$select public.cancel_my_order('{"orderId":"%s"}')$q$, v_o1)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('cancelling returns the stock exactly once', (select stock_units from public.products where id = v_p1) = 10 and (select status from public.orders where id = v_o1) = 'cancelled');
  perform pg_temp.chk('cancelled order cannot be paid', pg_temp.call_as(c_c, format($q$select public.report_order_payment('{"orderId":"%s"}')$q$, v_o1)) = 'failed-precondition'
    and pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o1)) = 'failed-precondition');

  -- ---------------------------------------------------------------- payment review, ledger, shipping
  perform pg_temp.as_user(c_c);
  v_o2 := public.create_order(c_order || v_items || '{"idempotencyKey":"market-test-key-0002"}')->>'orderId';
  perform pg_temp.chk('address not readable before payment', pg_temp.call_as(c_f, format($q$select public.admin_order_contact('{"orderId":"%s"}')$q$, v_o2)) = 'failed-precondition');
  perform pg_temp.chk('customer reports the transfer', pg_temp.call_as(c_c, format($q$select public.report_order_payment('{"orderId":"%s"}')$q$, v_o2)) = 'OK');
  perform pg_temp.chk('reported order can no longer be cancelled by the customer', pg_temp.call_as(c_c, format($q$select public.cancel_my_order('{"orderId":"%s"}')$q$, v_o2)) = 'failed-precondition');
  perform pg_temp.chk('rejecting needs a reason', pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"reject"}')$q$, v_o2)) = 'invalid-argument');
  perform pg_temp.chk('no confirmation without a screening', pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o2)) = 'screening-required');
  perform pg_temp.chk('customer and farm cannot record a screening', pg_temp.call_as(c_c, format($q$select public.record_order_screening('{"orderId":"%s","result":"clear","listsChecked":"EU, UN"}')$q$, v_o2)) = 'permission-denied'
    and pg_temp.call_as(c_g, format($q$select public.record_order_screening('{"orderId":"%s","result":"clear","listsChecked":"EU, UN"}')$q$, v_o2)) = 'permission-denied');
  perform pg_temp.chk('screening needs the lists and a note for a hit', pg_temp.call_as(c_f, format($q$select public.record_order_screening('{"orderId":"%s","result":"clear"}')$q$, v_o2)) = 'invalid-argument'
    and pg_temp.call_as(c_f, format($q$select public.record_order_screening('{"orderId":"%s","result":"hit","listsChecked":"EU, UN"}')$q$, v_o2)) = 'invalid-argument');
  perform pg_temp.chk('a hit blocks the confirmation', pg_temp.call_as(c_f, format($q$select public.record_order_screening('{"orderId":"%s","result":"hit","listsChecked":"EU, UN","note":"name match"}')$q$, v_o2)) = 'OK'
    and pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o2)) = 'screening-blocked');
  perform pg_temp.as_user(c_f);
  v_j := public.order_payer(jsonb_build_object('orderId', v_o2));
  perform pg_temp.as_pg();
  perform pg_temp.chk('finance sees the payer name for the screening, audited', v_j->>'deliveryName' = 'Kunde Geheim' and v_j->>'accountName' = 'Market Customer' and v_j::text not like '%Geheimweg%'
    and exists (select 1 from public.audit_logs where action = 'order.payer_read' and target = 'orders/' || v_o2), v_j::text);
  perform pg_temp.chk('farm cannot see the payer', pg_temp.call_as(c_g, format($q$select public.order_payer('{"orderId":"%s"}')$q$, v_o2)) = 'permission-denied');
  perform pg_temp.chk('a later clear screening lifts the block', pg_temp.call_as(c_f, format($q$select public.record_order_screening('{"orderId":"%s","result":"clear","listsChecked":"EU, UN","note":"different person"}')$q$, v_o2)) = 'OK');
  perform pg_temp.chk('finance approves the payment', pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o2)) = 'OK');
  perform pg_temp.chk('a second decision is refused', pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o2)) = 'failed-precondition'
    and pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"reject","note":"too late"}')$q$, v_o2)) = 'failed-precondition');
  perform pg_temp.as_pg();
  perform pg_temp.chk('farm credited once with price minus fee', (select count(*) = 1 and sum(amount_minor) = 2550 from private.farm_ledger where order_id = v_o2)
    and (select items_minor = 3000 and fee_minor = 450 and total_minor = 3900 from public.orders where id = v_o2)
    and (select status from public.orders where id = v_o2) = 'paid' and (select stock_units from public.products where id = v_p1) = 8);
  perform pg_temp.chk('ledger refuses a second sale for one order', pg_temp.try(format($q$insert into private.farm_ledger (farm_id, order_id, kind, amount_minor, currency) values ('farm_mk_a', '%s', 'sale', 1, 'EUR')$q$, v_o2)) <> 'OK');
  perform pg_temp.as_user(c_g);
  v_j := public.farm_overview();
  perform pg_temp.chk('farm overview: order, balance, no customer data', jsonb_array_length(v_j->'farms') = 1 and jsonb_array_length(v_j#>'{farms,0,orders}') = 1
    and (v_j#>>'{farms,0,balances,0,amountMinor}')::int = 2550 and v_j::text not like '%Geheim%' and v_j::text not like '%paymentReference%' and v_j::text not like '%' || c_c::text || '%', left(v_j::text, 400));
  perform pg_temp.as_user(c_h);
  perform pg_temp.chk('other farm sees neither order nor balance', (public.farm_overview())::text not like '%' || v_o2 || '%' and (public.farm_overview()#>>'{farms,0,balances}') = '[]');
  perform pg_temp.as_user(c_f);
  v_j := public.admin_order_contact(jsonb_build_object('orderId', v_o2));
  perform pg_temp.as_pg();
  perform pg_temp.chk('finance reads the address for shipping, audited', v_j#>>'{contact,name}' = 'Kunde Geheim' and v_j#>>'{contact,addressLine1}' = 'Geheimweg 7'
    and exists (select 1 from public.audit_logs where action = 'order.contact_read' and target = 'orders/' || v_o2 and actor_uid = c_f), v_j::text);
  perform pg_temp.chk('delivered before shipped refused', pg_temp.call_as(c_f, format($q$select public.admin_set_order_fulfilment('{"orderId":"%s","step":"delivered"}')$q$, v_o2)) = 'failed-precondition');
  perform pg_temp.chk('farm member cannot mark shipped', pg_temp.call_as(c_g, format($q$select public.admin_set_order_fulfilment('{"orderId":"%s","step":"shipped"}')$q$, v_o2)) = 'permission-denied');
  perform pg_temp.chk('shipped, then delivered', pg_temp.call_as(c_f, format($q$select public.admin_set_order_fulfilment('{"orderId":"%s","step":"shipped","trackingCode":"DHL-123"}')$q$, v_o2)) = 'OK'
    and pg_temp.call_as(c_f, format($q$select public.admin_set_order_fulfilment('{"orderId":"%s","step":"delivered"}')$q$, v_o2)) = 'OK');
  perform pg_temp.as_user(c_c);
  perform pg_temp.chk('customer sees status and tracking', pg_temp.cnt(format($q$select count(*) from public.orders where id = '%s' and status = 'delivered' and tracking_code = 'DHL-123'$q$, v_o2)) = 1);
  perform pg_temp.chk('address closed again after delivery', pg_temp.call_as(c_f, format($q$select public.admin_order_contact('{"orderId":"%s"}')$q$, v_o2)) = 'failed-precondition');
  perform pg_temp.as_user(c_f);
  v_j := public.admin_list_marketplace();
  perform pg_temp.chk('staff list shows orders, products, rates, balances', jsonb_array_length(v_j->'orders') >= 2 and jsonb_array_length(v_j->'products') >= 3
    and jsonb_array_length(v_j->'shippingRates') >= 1 and jsonb_array_length(v_j->'members') >= 2 and jsonb_array_length(v_j->'farms') >= 2 and (v_j->>'feeBps')::int = 1500 and (v_j->>'shopOpen')::boolean
    and exists (select 1 from jsonb_array_elements(v_j->'orders') o where o->>'orderId' = v_o2 and o#>>'{screening,result}' = 'clear') and v_j::text not like '%Geheim%', left(v_j::text, 300));

  -- ---------------------------------------------------------------- refund and payout
  perform pg_temp.as_user(c_c);
  v_o5 := public.create_order(c_order || v_items || '{"idempotencyKey":"market-test-key-0005"}')->>'orderId';
  perform pg_temp.chk('unpaid order cannot be refunded', pg_temp.call_as(c_f, format($q$select public.refund_order('{"orderId":"%s","note":"customer asked"}')$q$, v_o5)) = 'failed-precondition');
  perform pg_temp.chk('second order is screened and paid', pg_temp.call_as(c_f, format($q$select public.record_order_screening('{"orderId":"%s","result":"clear","listsChecked":"EU, UN"}')$q$, v_o5)) = 'OK'
    and pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o5)) = 'OK');
  perform pg_temp.chk('paid order can no longer be screened', pg_temp.call_as(c_f, format($q$select public.record_order_screening('{"orderId":"%s","result":"hit","listsChecked":"EU, UN","note":"late"}')$q$, v_o5)) = 'failed-precondition');
  perform pg_temp.chk('customer and farm cannot refund', pg_temp.call_as(c_c, format($q$select public.refund_order('{"orderId":"%s","note":"mine"}')$q$, v_o5)) = 'permission-denied'
    and pg_temp.call_as(c_g, format($q$select public.refund_order('{"orderId":"%s","note":"mine"}')$q$, v_o5)) = 'permission-denied');
  perform pg_temp.chk('refund needs a reason', pg_temp.call_as(c_f, format($q$select public.refund_order('{"orderId":"%s"}')$q$, v_o5)) = 'invalid-argument');
  perform pg_temp.chk('finance refunds a paid order', pg_temp.call_as(c_f, format($q$select public.refund_order('{"orderId":"%s","note":"customer asked"}')$q$, v_o5)) = 'OK');
  perform pg_temp.chk('a refund happens once', pg_temp.call_as(c_f, format($q$select public.refund_order('{"orderId":"%s","note":"again"}')$q$, v_o5)) = 'failed-precondition');
  perform pg_temp.as_pg();
  perform pg_temp.chk('refund returns stock and reverses the credit', (select status from public.orders where id = v_o5) = 'refunded' and (select stock_units from public.products where id = v_p1) = 8
    and (select sum(amount_minor) from private.farm_ledger where order_id = v_o5) = 0 and (select sum(amount_minor) from private.farm_ledger where farm_id = 'farm_mk_a') = 2550);
  perform pg_temp.chk('delivered order cannot be refunded here', pg_temp.call_as(c_f, format($q$select public.refund_order('{"orderId":"%s","note":"late"}')$q$, v_o2)) = 'failed-precondition');
  perform pg_temp.chk('customer and farm cannot book a payout', pg_temp.call_as(c_c, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":100,"currency":"EUR","reference":"BANK-0"}')$q$) = 'permission-denied'
    and pg_temp.call_as(c_g, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":100,"currency":"EUR","reference":"BANK-0"}')$q$) = 'permission-denied');
  perform pg_temp.chk('payout above the credit refused', pg_temp.call_as(c_f, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":2551,"currency":"EUR","reference":"BANK-1"}')$q$) = 'failed-precondition');
  perform pg_temp.chk('payout in a currency without credit refused', pg_temp.call_as(c_f, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":100,"currency":"USD","reference":"BANK-1"}')$q$) = 'failed-precondition');
  perform pg_temp.chk('payout without a bank reference refused', pg_temp.call_as(c_f, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":100,"currency":"EUR"}')$q$) = 'invalid-argument');
  perform pg_temp.chk('finance books a payout', pg_temp.call_as(c_f, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":1000,"currency":"EUR","reference":"BANK-1"}')$q$) = 'OK');
  perform pg_temp.chk('the same bank reference is booked once', pg_temp.call_as(c_f, $q$select public.record_farm_payout('{"farmId":"farm_mk_a","amountMinor":1000,"currency":"EUR","reference":"BANK-1"}')$q$) = 'already-exists');
  perform pg_temp.as_user(c_g);
  perform pg_temp.chk('farm sees the reduced credit', (public.farm_overview()#>>'{farms,0,balances,0,amountMinor}')::int = 1550);

  -- ---------------------------------------------------------------- four eyes, rejection
  perform pg_temp.as_user(c_f);
  v_o3 := public.create_order(c_order || v_items || '{"idempotencyKey":"market-test-key-0003"}')->>'orderId';
  perform pg_temp.chk('finance cannot approve own order', pg_temp.call_as(c_f, format($q$select public.review_order_payment('{"orderId":"%s","decision":"approve"}')$q$, v_o3)) not in ('OK', 'failed-precondition'));
  perform pg_temp.as_pg();
  perform pg_temp.chk('own order stays unpaid', (select status from public.orders where id = v_o3) = 'awaiting_payment' and not exists (select 1 from private.farm_ledger where order_id = v_o3)
    and (select stock_units from public.products where id = v_p1) = 6);
  perform pg_temp.chk('another reviewer rejects it', pg_temp.call_as(c_a, format($q$select public.review_order_payment('{"orderId":"%s","decision":"reject","note":"No transfer received"}')$q$, v_o3)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('rejection returns the stock, credits nothing', (select status from public.orders where id = v_o3) = 'rejected' and (select stock_units from public.products where id = v_p1) = 8
    and not exists (select 1 from private.farm_ledger where order_id = v_o3));

  -- ---------------------------------------------------------------- expiry, open-order cap, unlisted farm
  perform pg_temp.as_user(c_d);
  v_o4 := public.create_order(c_order || v_items || '{"idempotencyKey":"market-test-key-0004"}')->>'orderId';
  perform pg_temp.as_pg();
  update public.orders set expires_at = now() - interval '1 minute' where id = v_o4;
  perform pg_temp.chk('expired order cannot be reported as paid', pg_temp.call_as(c_d, format($q$select public.report_order_payment('{"orderId":"%s"}')$q$, v_o4)) = 'failed-precondition');
  perform pg_temp.as_pg();
  v_n := private.expire_orders();
  perform pg_temp.chk('expiry job releases the order', v_n = 1 and (select status from public.orders where id = v_o4) = 'expired' and (select stock_units from public.products where id = v_p1) = 8);
  perform pg_temp.chk('expiry job is idempotent', private.expire_orders() = 0 and (select stock_units from public.products where id = v_p1) = 8);
  perform pg_temp.as_user(c_d);
  for v_n in 1..5 loop
    perform public.create_order(c_order || jsonb_build_object('idempotencyKey', 'market-test-cap-000' || v_n, 'items', jsonb_build_array(jsonb_build_object('productId', v_p1, 'quantity', 1))));
  end loop;
  perform pg_temp.chk('sixth open order refused', pg_temp.call_as(c_d, format('select public.create_order(%L)', c_order || v_items || '{"idempotencyKey":"market-test-cap-0006"}')) = 'resource-exhausted');
  perform pg_temp.as_pg();
  perform pg_temp.chk('stock never below zero under load', (select stock_units from public.products where id = v_p1) = 3 and pg_temp.try(format($q$update public.products set stock_units = -1 where id = '%s'$q$, v_p1)) <> 'OK');
  perform pg_temp.chk('farmer sets stock and unlists', pg_temp.call_as(c_g, format($q$select public.farmer_set_product_stock('{"productId":"%s","stockUnits":40,"unlist":true}')$q$, v_p2)) = 'OK');
  perform pg_temp.as_anon();
  perform pg_temp.chk('unlisted product left the shop', pg_temp.cnt(format($q$select count(*) from public.products where id = '%s'$q$, v_p2)) = 0);
  perform pg_temp.chk('farmer changes stock of an unlisted product', pg_temp.call_as(c_g, format($q$select public.farmer_set_product_stock('{"productId":"%s","stockUnits":41}')$q$, v_p2)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('which does not list it again', (select status = 'unlisted' and stock_units = 41 from public.products where id = v_p2));
  perform pg_temp.as_user(c_a);
  perform public.admin_upsert_farm('{"farmId":"farm_mk_b","countryCode":"SY","name":"مزرعة ب","nameEn":"Farm B","region":"حلب","regionEn":"Aleppo","status":"unlisted"}');
  perform pg_temp.as_anon();
  perform pg_temp.chk('products of an unlisted farm leave the shop', pg_temp.cnt(format($q$select count(*) from public.products where id = '%s'$q$, v_p3)) = 0);
  perform pg_temp.chk('and cannot be ordered', pg_temp.call_as(c_c, format($q$select public.quote_order('{"destCountry":"DE","items":[{"productId":"%s","quantity":1}]}')$q$, v_p3)) = 'product-unavailable');
  perform pg_temp.chk('removed member loses access', pg_temp.call_as(c_a, format($q$select public.admin_set_farm_member('{"farmId":"farm_mk_a","userId":"%s","active":false}')$q$, c_g)) = 'OK'
    and pg_temp.call_as(c_g, format('select public.farmer_upsert_product(%L)', c_p1)) = 'permission-denied');
  perform pg_temp.as_user(c_g);
  perform pg_temp.chk('removed member sees no farm orders', pg_temp.cnt($q$select count(*) from public.orders$q$) = 0 and jsonb_array_length(public.farm_overview()->'farms') = 0);

  -- ---------------------------------------------------------------- data retention and account deletion
  perform pg_temp.as_user(c_d);
  v_j := public.export_my_data('{}');
  perform pg_temp.chk('data export holds own orders with own address only', jsonb_array_length(v_j->'orders') = 6 and v_j#>>'{orders,0,deliveryContact,addressLine1}' = 'Geheimweg 7'
    and v_j::text not like '%' || v_o2 || '%', left((v_j->'orders')::text, 300));
  perform pg_temp.chk('open orders block account deletion', pg_temp.call_as(c_d, $q$select public.delete_my_account('{"confirmation":"DELETE"}')$q$) = 'failed-precondition');
  perform pg_temp.as_pg();
  update public.orders set updated_at = now() - interval '91 days' where id in (v_o1, v_o2);
  v_n := private.purge_order_contacts();
  perform pg_temp.chk('old addresses are purged, recent ones kept', v_n = 2 and not exists (select 1 from private.order_contacts where order_id in (v_o1, v_o2))
    and exists (select 1 from private.order_contacts where order_id = v_o3));
  perform pg_temp.chk('account deletion removes remaining addresses', pg_temp.call_as(c_f, $q$select public.delete_my_account('{"confirmation":"DELETE"}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('address gone, order kept for the books', not exists (select 1 from private.order_contacts where order_id = v_o3) and exists (select 1 from public.orders where id = v_o3));
  perform pg_temp.chk('jobs are scheduled', (select count(*) from cron.job where jobname in ('faseela-expire-orders', 'faseela-purge-order-contacts')) = 2);

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
