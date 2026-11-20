-- Faseela date crop suite (migration 45). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := 'dc000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := 'dc000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_i constant uuid := 'dc000000-0000-4000-8000-0000000000e1'; -- investor
  c_new constant jsonb := '{"treeId":"tree_date_test","name":"نخلة اختبار","nameEn":"Test palm","region":"تدمر","regionEn":"Palmyra","treeType":"خستاوي","treeTypeEn":"Khastawi","totalShares":4,"pricePerShareMinor":3000,"plantedYear":2005,"estimatedAnnualYieldKg":80}';
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

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'da@t.faseela.invalid', 'Date Admin'), (c_f, 'df@t.faseela.invalid', 'Date Finance'), (c_i, 'di@t.faseela.invalid', 'Date Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin');

  -- A tree created in the panel starts as olive; the crop is set afterwards.
  perform pg_temp.chk('admin creates the tree', pg_temp.call_as(c_a, format('select public.admin_create_tree(%L)', c_new)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('new tree starts as olive', (select crop_category from public.trees_public where tree_id = 'tree_date_test') = 'olive');

  -- Who may set a crop.
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot set a crop', pg_temp.try($q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"date"}')$q$) <> 'OK');
  perform pg_temp.chk('investor cannot set a crop', pg_temp.call_as(c_i, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"date"}')$q$) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot set a crop', pg_temp.call_as(c_f, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"date"}')$q$) = 'permission-denied');
  perform pg_temp.chk('investor cannot read a crop', pg_temp.call_as(c_i, $q$select public.admin_get_tree_crop('{"treeId":"tree_date_test"}')$q$) = 'permission-denied');

  -- Validation.
  perform pg_temp.chk('unknown crop refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"banana"}')$q$) = 'invalid-argument');
  perform pg_temp.chk('missing crop refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test"}')$q$) = 'invalid-argument');
  perform pg_temp.chk('non-text crop refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":7}')$q$) = 'invalid-argument');
  perform pg_temp.chk('unknown tree refused', pg_temp.call_as(c_a, $q$select public.admin_set_tree_crop('{"treeId":"no_such_tree","cropCategory":"date"}')$q$) = 'not-found');
  perform pg_temp.as_pg();
  perform pg_temp.chk('refused calls change nothing', (select crop_category from public.trees_public where tree_id = 'tree_date_test') = 'olive');

  -- Happy path.
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"date"}');
  perform pg_temp.chk('admin sets date', v_j->>'cropCategory' = 'date', v_j::text);
  v_j := public.admin_get_tree_crop('{"treeId":"tree_date_test"}');
  perform pg_temp.chk('admin reads date', v_j->>'cropCategory' = 'date', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('stored as date', (select crop_category from public.trees_public where tree_id = 'tree_date_test') = 'date');
  perform pg_temp.chk('change audited', exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'tree.crop_changed'
    and details->>'before' = 'olive' and details->>'after' = 'date'));
  perform pg_temp.chk('constraint still refuses unknown crops', pg_temp.try($q$update public.trees_public set crop_category = 'banana' where tree_id = 'tree_date_test'$q$) <> 'OK');

  -- Once anything is sold or reserved the crop is fixed.
  update private.trees set reserved_shares = 1 where tree_id = 'tree_date_test';
  perform pg_temp.chk('crop fixed after a reservation', pg_temp.call_as(c_a, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"walnut"}')$q$) = 'failed-precondition');
  perform pg_temp.chk('same crop is still accepted', pg_temp.call_as(c_a, $q$select public.admin_set_tree_crop('{"treeId":"tree_date_test","cropCategory":"date"}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('crop unchanged after refusal', (select crop_category from public.trees_public where tree_id = 'tree_date_test') = 'date');

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
