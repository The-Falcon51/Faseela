-- Faseela master data suite (migration 48). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := '3d000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := '3d000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_i constant uuid := '3d000000-0000-4000-8000-0000000000e1'; -- investor
  c_tree constant jsonb := '{"treeId":"tree_md_test","name":"شجرة اختبار","nameEn":"Origin tree","region":"جيان","regionEn":"Jaen","treeType":"بيكوال","treeTypeEn":"Picual","totalShares":4,"pricePerShareMinor":4000}';
  c_farm constant jsonb := '{"farmId":"farm_md_es","countryCode":"ES","name":"مزرعة الاختبار","nameEn":"Finca Prueba","region":"جيان","regionEn":"Jaen","status":"listed"}';
  v_j jsonb; v_n integer;
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
  create function pg_temp.cnt(p_sql text) returns integer language plpgsql as $f$
  declare n integer; begin execute p_sql into n; return n; end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'ma@t.faseela.invalid', 'Master Admin'), (c_f, 'mf@t.faseela.invalid', 'Master Finance'), (c_i, 'mi@t.faseela.invalid', 'Master Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin');

  -- ---------------------------------------------------------------- what the migration set up
  perform pg_temp.chk('existing trees belong to Syria', not exists (select 1 from public.trees_public where country_code <> 'SY'));
  perform pg_temp.chk('every farm id in use has a record', not exists (select 1 from private.trees t where t.farm_id is not null and not exists (select 1 from public.farms f where f.farm_id = t.farm_id)));
  perform pg_temp.chk('public farm link matches the inventory', not exists (select 1 from private.trees t join public.trees_public p using (tree_id) where t.farm_id is distinct from p.farm_id));
  perform pg_temp.chk('TND has three minor units', (select minor_units from public.currencies where code = 'TND') = 3);

  -- ---------------------------------------------------------------- isolation: reads
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon sees active countries only', pg_temp.cnt($q$select count(*) from public.countries$q$) = 1 and pg_temp.cnt($q$select count(*) from public.countries where code = 'ES'$q$) = 0);
  perform pg_temp.chk('anon reads currencies', pg_temp.cnt($q$select count(*) from public.currencies$q$) >= 7);
  perform pg_temp.chk('anon sees no unlisted farm', pg_temp.cnt($q$select count(*) from public.farms where status <> 'listed'$q$) = 0);
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor sees active countries only', pg_temp.cnt($q$select count(*) from public.countries where status <> 'active'$q$) = 0);

  -- ---------------------------------------------------------------- isolation: writes
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot insert a country', pg_temp.try($q$insert into public.countries (code, name, name_en, name_de, currency, status) values ('XX', 'xx', 'xx', 'xx', 'USD', 'active')$q$) <> 'OK');
  perform pg_temp.chk('investor cannot insert a farm', pg_temp.call_as(c_i, $q$insert into public.farms (farm_id, country_code, status) values ('farm_evil', 'SY', 'listed')$q$) <> 'OK');
  perform pg_temp.chk('investor cannot activate a country', pg_temp.call_as(c_i, $q$update public.countries set status = 'active' where code = 'ES'$q$) <> 'OK');
  perform pg_temp.chk('investor cannot move a tree', pg_temp.call_as(c_i, $q$update public.trees_public set country_code = 'ES' where tree_id = 'tree_01'$q$) <> 'OK');
  perform pg_temp.chk('investor cannot delete a mill', pg_temp.call_as(c_i, $q$delete from public.mills$q$) <> 'OK');
  perform pg_temp.chk('investor cannot use admin functions', pg_temp.call_as(c_i, format('select public.admin_upsert_farm(%L)', c_farm)) = 'permission-denied'
    and pg_temp.call_as(c_i, $q$select public.admin_set_country_status('{"code":"ES","status":"active"}')$q$) = 'permission-denied'
    and pg_temp.call_as(c_i, $q$select public.admin_set_tree_origin('{"treeId":"tree_01","countryCode":"ES"}')$q$) = 'permission-denied'
    and pg_temp.call_as(c_i, $q$select public.admin_list_master_data()$q$) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot change master data', pg_temp.call_as(c_f, format('select public.admin_upsert_farm(%L)', c_farm)) = 'permission-denied');
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot use admin functions', pg_temp.try(format('select public.admin_upsert_farm(%L)', c_farm)) <> 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('refused writes changed nothing', not exists (select 1 from public.farms where farm_id in ('farm_evil', 'farm_md_es'))
    and (select status from public.countries where code = 'ES') = 'planned' and (select country_code from public.trees_public where tree_id = 'tree_01') = 'SY');

  -- ---------------------------------------------------------------- farms and mills
  perform pg_temp.chk('farm in an unknown country refused', pg_temp.call_as(c_a, format('select public.admin_upsert_farm(%L)', c_farm || '{"countryCode":"ZZ"}')) = 'not-found');
  perform pg_temp.chk('bad farm id refused', pg_temp.call_as(c_a, format('select public.admin_upsert_farm(%L)', c_farm || '{"farmId":"Farm 1!"}')) = 'invalid-argument');
  perform pg_temp.chk('markup in a farm name refused', pg_temp.call_as(c_a, format('select public.admin_upsert_farm(%L)', c_farm || '{"nameEn":"<b>x</b>"}')) = 'invalid-argument');
  perform pg_temp.chk('unknown status refused', pg_temp.call_as(c_a, format('select public.admin_upsert_farm(%L)', c_farm || '{"status":"hidden"}')) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_upsert_farm(c_farm);
  perform pg_temp.chk('admin creates a farm in a planned country', (v_j->>'created')::boolean and v_j->>'countryCode' = 'ES', v_j::text);
  v_j := public.admin_upsert_farm(c_farm || '{"nameEn":"Finca Renombrada"}');
  perform pg_temp.chk('second save updates it', not (v_j->>'created')::boolean, v_j::text);
  v_j := public.admin_upsert_mill('{"millId":"mill_md_es","countryCode":"ES","name":"معصرة الاختبار","nameEn":"Almazara Prueba"}');
  perform pg_temp.chk('admin creates a mill (unlisted by default)', v_j->>'status' = 'unlisted', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('farm stored and audited', (select name_en from public.farms where farm_id = 'farm_md_es') = 'Finca Renombrada'
    and exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'farm.created')
    and exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'farm.updated')
    and exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'mill.created'));

  -- ---------------------------------------------------------------- tree origin
  perform pg_temp.chk('admin creates a tree', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_tree)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('a new tree starts in Syria without a farm', (select country_code = 'SY' and farm_id is null from public.trees_public where tree_id = 'tree_md_test'));
  perform pg_temp.chk('unknown country refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_origin('{"treeId":"tree_md_test","countryCode":"ZZ"}')$q$) = 'not-found');
  perform pg_temp.chk('farm of another country refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_origin('{"treeId":"tree_md_test","countryCode":"SY","farmId":"farm_md_es"}')$q$) = 'failed-precondition');
  perform pg_temp.chk('unknown farm refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_origin('{"treeId":"tree_md_test","countryCode":"ES","farmId":"farm_nope"}')$q$) = 'failed-precondition');
  perform pg_temp.chk('unknown tree refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_origin('{"treeId":"tree_nope","countryCode":"ES"}')$q$) = 'not-found');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_tree_origin('{"treeId":"tree_md_test","countryCode":"ES","farmId":"farm_md_es"}');
  perform pg_temp.chk('admin sets country and farm', v_j->>'countryCode' = 'ES' and v_j->>'farmId' = 'farm_md_es', v_j::text);
  v_j := public.admin_get_tree_origin('{"treeId":"tree_md_test"}');
  perform pg_temp.chk('admin reads the origin', v_j->>'countryCode' = 'ES' and v_j->>'farmId' = 'farm_md_es', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('listing and inventory agree, change audited', (select p.country_code = 'ES' and p.farm_id = 'farm_md_es' and t.farm_id = 'farm_md_es'
      from public.trees_public p join private.trees t using (tree_id) where p.tree_id = 'tree_md_test')
    and exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'tree.origin_changed' and details->>'countryAfter' = 'ES'));
  perform pg_temp.chk('a farm with trees cannot move to another country', pg_temp.call_as(c_a, format('select public.admin_upsert_farm(%L)', c_farm || '{"countryCode":"IT"}')) = 'failed-precondition');
  perform pg_temp.chk('mill must exist before a tree can use it', pg_temp.call_as(c_a, $q$select public.admin_set_tree_mill('{"treeId":"tree_md_test","millId":"mill_nope"}')$q$) = 'not-found'
    and pg_temp.call_as(c_a, $q$select public.admin_set_tree_mill('{"treeId":"tree_md_test","millId":"mill_md_es"}')$q$) = 'OK');

  -- A listed tree in a planned country stays invisible in the country list until the country is activated.
  perform pg_temp.chk('a tree cannot be listed in a planned country', pg_temp.call_as(c_a, $q$select public.admin_set_tree_status('{"treeId":"tree_md_test","status":"listed"}')$q$) = 'failed-precondition');
  perform pg_temp.as_anon();
  perform pg_temp.chk('planned country not public yet', pg_temp.cnt($q$select count(*) from public.countries where code = 'ES'$q$) = 0);
  -- Activation needs a receiving account that covers the country.
  perform pg_temp.as_pg();
  delete from private.app_settings where key = 'payment_instructions';
  perform pg_temp.chk('no activation without a receiving account', pg_temp.call_as(c_a, $q$select public.admin_set_country_status('{"code":"ES","status":"active"}')$q$) = 'failed-precondition');
  perform pg_temp.as_pg();
  insert into private.app_settings (key, value) values ('payment_instructions',
    '{"channels":[{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"ES00 TEST 0001","countries":["ES"]}]}'::jsonb);
  perform pg_temp.chk('admin activates Spain', pg_temp.call_as(c_a, $q$select public.admin_set_country_status('{"code":"ES","status":"active"}')$q$) = 'OK');
  perform pg_temp.chk('admin lists the tree', pg_temp.call_as(c_a, $q$select public.admin_set_tree_status('{"treeId":"tree_md_test","status":"listed"}')$q$) = 'OK');
  perform pg_temp.as_anon();
  perform pg_temp.chk('active country and its listed farm are public', pg_temp.cnt($q$select count(*) from public.countries where code = 'ES'$q$) = 1
    and pg_temp.cnt($q$select count(*) from public.farms where farm_id = 'farm_md_es'$q$) = 1
    and pg_temp.cnt($q$select count(*) from public.mills where mill_id = 'mill_md_es'$q$) = 0);
  perform pg_temp.chk('a country with listed trees cannot be set back', pg_temp.call_as(c_a, $q$select public.admin_set_country_status('{"code":"ES","status":"planned"}')$q$) = 'failed-precondition');

  -- Country is fixed once something is sold or reserved; the farm may still be reassigned within the country.
  perform pg_temp.as_pg();
  update private.trees set reserved_shares = 1 where tree_id = 'tree_md_test';
  perform pg_temp.chk('country fixed after a reservation', pg_temp.call_as(c_a, $q$select public.admin_set_tree_origin('{"treeId":"tree_md_test","countryCode":"SY","farmId":null}')$q$) = 'failed-precondition');
  perform pg_temp.chk('farm can still be cleared', pg_temp.call_as(c_a, $q$select public.admin_set_tree_origin('{"treeId":"tree_md_test","countryCode":"ES","farmId":null}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('farm cleared on both sides', (select p.farm_id is null and t.farm_id is null from public.trees_public p join private.trees t using (tree_id) where p.tree_id = 'tree_md_test'));

  -- ---------------------------------------------------------------- admin overview and locale
  perform pg_temp.as_user(c_a);
  v_j := public.admin_list_master_data();
  perform pg_temp.chk('overview lists planned countries and unlisted mills', jsonb_array_length(v_j->'countries') >= 7
    and exists (select 1 from jsonb_array_elements(v_j->'mills') m where m->>'millId' = 'mill_md_es' and m->>'status' = 'unlisted')
    and exists (select 1 from jsonb_array_elements(v_j->'countries') c where c->>'code' = 'ES' and (c->>'trees')::int = 1), left(v_j::text, 300));
  perform pg_temp.chk('unknown locale refused', pg_temp.call_as(c_i, $q$select public.set_my_locale('{"locale":"fr"}')$q$) = 'invalid-argument');
  perform pg_temp.chk('user sets own locale', pg_temp.call_as(c_i, $q$select public.set_my_locale('{"locale":"de"}')$q$) = 'OK');
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot set a locale', pg_temp.try($q$select public.set_my_locale('{"locale":"de"}')$q$) <> 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('locale stored for that user only', (select locale from public.profiles where id = c_i) = 'de' and (select locale from public.profiles where id = c_a) is null);

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
