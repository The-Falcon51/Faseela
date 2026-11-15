-- Faseela land offer gate suite (migration 46). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := '1a000000-0000-4000-8000-0000000000a1'; -- admin
  c_i constant uuid := '1a000000-0000-4000-8000-0000000000e1'; -- investor
  c_tree constant jsonb := '{"treeId":"tree_gate_test","name":"شجرة اختبار","nameEn":"Gate tree","region":"إدلب","regionEn":"Idlib","treeType":"صوراني","treeTypeEn":"Sorani","totalShares":4,"pricePerShareMinor":3500}';
  v_n integer; v_plain text; v_false text;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; m text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint, m = message_text; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR') || ': ' || m; end; end $f$;
  create function pg_temp.call_as(p uuid, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p); return pg_temp.try(p_sql); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'ga@t.faseela.invalid', 'Gate Admin'), (c_i, 'gi@t.faseela.invalid', 'Gate Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin');
  delete from private.app_settings where key = 'land_offer_enabled';

  -- Off by default: every truthy spelling of the land flag is refused before anything is reserved.
  perform pg_temp.chk('off by default', not private.land_offer_enabled());
  perform pg_temp.chk('land request refused', pg_temp.call_as(c_i, $q$select public.create_investment_request('{"treeId":"tree_03","shareCount":4,"includesLand":true,"idempotencyKey":"key-gate-tree03-000001"}')$q$) = 'failed-precondition: The land option is currently not offered.');
  perform pg_temp.chk('text "true" refused', pg_temp.call_as(c_i, $q$select public.create_investment_request('{"treeId":"tree_03","shareCount":4,"includesLand":"true","idempotencyKey":"key-gate-tree03-000002"}')$q$) = 'failed-precondition: The land option is currently not offered.');
  perform pg_temp.chk('number 1 refused', pg_temp.call_as(c_i, $q$select public.create_investment_request('{"treeId":"tree_03","shareCount":4,"includesLand":1,"idempotencyKey":"key-gate-tree03-000003"}')$q$) = 'failed-precondition: The land option is currently not offered.');
  perform pg_temp.as_pg();
  perform pg_temp.chk('nothing reserved by refused requests', (select reserved_shares from private.trees where tree_id = 'tree_03') = 0
    and not exists (select 1 from public.investment_requests where user_id = c_i));
  perform pg_temp.chk('admin cannot create a tree with a parcel option', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_tree || '{"hasLandOption":true,"landPriceMinor":1500,"landAreaSqm":5}')) = 'failed-precondition: The land option is currently not offered.');
  perform pg_temp.as_pg();
  perform pg_temp.chk('refused tree was not created', not exists (select 1 from public.trees_public where tree_id = 'tree_gate_test'));

  -- Requests without land are not affected: an absent flag and an explicit false behave the same.
  v_plain := pg_temp.call_as(c_i, $q$select public.create_investment_request('{"treeId":"tree_01","shareCount":1,"idempotencyKey":"key-gate-tree01-000001"}')$q$);
  v_false := pg_temp.call_as(c_i, $q$select public.create_investment_request('{"treeId":"tree_02","shareCount":1,"includesLand":false,"idempotencyKey":"key-gate-tree02-000001"}')$q$);
  perform pg_temp.chk('request without land flag passes the gate', v_plain = 'OK', v_plain);
  perform pg_temp.chk('explicit false passes the gate', v_false = 'OK', v_false);
  perform pg_temp.chk('admin creates a tree without parcel option', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_tree)) = 'OK');

  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('admin overview reports the offer as off', (public.admin_list_master_data()->>'landOfferEnabled')::boolean = false);

  -- Only JSON true switches it on.
  perform pg_temp.as_pg();
  insert into private.app_settings (key, value) values ('land_offer_enabled', '"true"');
  perform pg_temp.chk('text value does not enable the offer', not private.land_offer_enabled());
  update private.app_settings set value = 'true' where key = 'land_offer_enabled';
  perform pg_temp.chk('JSON true enables the offer', private.land_offer_enabled());
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('admin overview reports the offer as on', (public.admin_list_master_data()->>'landOfferEnabled')::boolean = true);
  perform pg_temp.as_pg();
  perform pg_temp.chk('land request accepted when enabled', pg_temp.call_as(c_i, $q$select public.create_investment_request('{"treeId":"tree_03","shareCount":4,"includesLand":true,"idempotencyKey":"key-gate-tree03-000004"}')$q$) = 'OK');

  -- The switch itself is not reachable for API roles.
  perform pg_temp.chk('investor cannot read or change the switch', pg_temp.call_as(c_i, $q$update private.app_settings set value = 'true' where key = 'land_offer_enabled'$q$) <> 'OK');

  perform pg_temp.as_pg();
  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
