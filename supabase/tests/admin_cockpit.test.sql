-- Faseela admin cockpit suite (migration 36). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := 'ad000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := 'ad000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_i constant uuid := 'ad000000-0000-4000-8000-0000000000e1'; -- investor
  r1 constant text := repeat('c', 64);
  v_j jsonb; v_n integer; v_tree text;
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

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'ca@t.faseela.invalid', 'Cockpit Admin'), (c_f, 'cf@t.faseela.invalid', 'Cockpit Finance'), (c_i, 'ci@t.faseela.invalid', 'Cockpit Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin');
  select tree_id into v_tree from public.trees_public order by tree_id limit 1;
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at, proof_submitted_at)
  values (r1, c_i, v_tree, 1, false, 3500, 'USD', 'under_review', now() + interval '1 day', now());

  -- access control
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot read the dashboard', pg_temp.try('select public.admin_dashboard()') <> 'OK');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot read the dashboard', pg_temp.try('select public.admin_dashboard()') = 'permission-denied');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot list investments', pg_temp.try($q$select public.admin_list_investments('{}'::jsonb)$q$) = 'permission-denied');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot list trees', pg_temp.try('select public.admin_list_trees()') = 'permission-denied');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot flip push', pg_temp.try($q$select public.admin_set_push_enabled('{"enabled":true}'::jsonb)$q$) = 'permission-denied');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('finance admin cannot read the dashboard', pg_temp.try('select public.admin_dashboard()') = 'permission-denied');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('finance admin cannot hide a tree', pg_temp.try(format('select public.admin_set_tree_status(%L)', jsonb_build_object('treeId', v_tree, 'status', 'unlisted'))) = 'permission-denied');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('finance admin cannot read client errors', pg_temp.try('select public.admin_list_client_errors()') = 'permission-denied');
  perform pg_temp.as_user(c_f);
  v_j := public.admin_list_investments(jsonb_build_object('status', 'under_review'));
  perform pg_temp.chk('finance admin lists investments with payer', (v_j->>'total')::int >= 1 and exists (select 1 from jsonb_array_elements(v_j->'rows') e where e->>'id' = r1 and e->>'payerEmail' = 'ci@t.faseela.invalid' and (e->>'amountMinor')::int = 3500), v_j::text);
  perform pg_temp.chk('unknown status refused', pg_temp.try($q$select public.admin_list_investments('{"status":"paid"}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('non-numeric paging refused', pg_temp.try($q$select public.admin_list_investments('{"limit":"many"}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  v_j := public.admin_list_investments(jsonb_build_object('limit', 100000, 'offset', -5));
  perform pg_temp.chk('paging is clamped', (v_j->>'limit')::int = 100 and (v_j->>'offset')::int = 0, v_j::text);
  v_j := public.admin_list_trees();
  perform pg_temp.chk('finance admin lists trees', jsonb_array_length(v_j) >= 1 and (v_j->0) ? 'availableShares' and (v_j->0) ? 'revenueMinor', left(v_j::text, 300));

  -- dashboard
  perform pg_temp.as_user(c_a);
  v_j := public.admin_dashboard();
  perform pg_temp.chk('dashboard has every block', v_j ?& array['users','roles','requests','months','inventory','funnel','gifts','referrals','oil','mail','push','errors','operations'], left(v_j::text, 300));
  perform pg_temp.chk('twelve months, oldest first', jsonb_array_length(v_j->'months') = 12 and (v_j->'months'->11->>'month') = to_char(now(), 'YYYY-MM'), (v_j->'months')::text);
  perform pg_temp.chk('current month counts the test request and sign-ups', (v_j->'months'->11->>'requests')::int >= 1 and (v_j->'months'->11->>'signups')::int >= 3, (v_j->'months'->11)::text);
  perform pg_temp.chk('open amount includes the request under review', (v_j->'requests'->>'openMinor')::bigint >= 3500 and (v_j->'requests'->'byStatus'->>'under_review')::int >= 1, (v_j->'requests')::text);
  perform pg_temp.chk('review queue counted', (v_j->'operations'->'reviewQueues'->>'payments')::int >= 1 and (v_j->'operations'->>'adminCount')::int >= 2, (v_j->'operations')::text);
  perform pg_temp.chk('funnel counts the requester', (v_j->'funnel'->>'requested')::int >= 1 and (v_j->'funnel'->>'proof')::int >= 1, (v_j->'funnel')::text);
  perform pg_temp.chk('no e-mail addresses in the dashboard', v_j::text not like '%@%', left(v_j::text, 200));

  -- tree visibility
  v_j := public.admin_set_tree_status(jsonb_build_object('treeId', v_tree, 'status', 'unlisted'));
  perform pg_temp.as_pg(); -- row-level security hides unlisted trees from signed-in clients, so read as owner
  perform pg_temp.chk('tree hidden', (v_j->>'changed') = 'true' and (select status = 'unlisted' from public.trees_public where tree_id = v_tree), v_j::text);
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_tree_status(jsonb_build_object('treeId', v_tree, 'status', 'unlisted'));
  perform pg_temp.chk('repeat is a no-op', (v_j->>'changed') = 'false', v_j::text);
  perform pg_temp.chk('unknown tree', pg_temp.try($q$select public.admin_set_tree_status('{"treeId":"no_such_tree","status":"listed"}'::jsonb)$q$) = 'not-found');
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('invalid status', pg_temp.try(format('select public.admin_set_tree_status(%L)', jsonb_build_object('treeId', v_tree, 'status', 'sold'))) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  perform public.admin_set_tree_status(jsonb_build_object('treeId', v_tree, 'status', 'listed'));
  perform pg_temp.as_pg();
  perform pg_temp.chk('visibility changes are audited once each', (select count(*) from public.audit_logs where actor_uid = c_a and action in ('tree.unlisted', 'tree.listed') and target = 'trees_public/' || v_tree) = 2);

  -- push switch + client errors
  perform pg_temp.as_user(c_a);
  perform pg_temp.chk('push switch needs a boolean', pg_temp.try($q$select public.admin_set_push_enabled('{"enabled":"yes"}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_push_enabled('{"enabled":true}'::jsonb);
  perform pg_temp.chk('push switched on', (v_j->>'enabled') = 'true' and (public.push_state()->>'enabled') = 'true', v_j::text);
  v_j := public.admin_set_push_enabled('{"enabled":false}'::jsonb);
  perform pg_temp.chk('push switched off', (public.push_state()->>'enabled') = 'false' and (public.admin_dashboard()->'push'->>'enabled') = 'false');
  perform pg_temp.as_pg();
  perform pg_temp.chk('push switch audited', (select count(*) from public.audit_logs where actor_uid = c_a and action = 'settings.push_enabled') = 2);
  insert into private.client_errors (fingerprint, message, source, page, user_agent, release, user_id) values
    ('fp_cockpit_1', 'TypeError: x is undefined', 'onerror', '/', 'UA', 'r1', c_i), ('fp_cockpit_1', 'TypeError: x is undefined', 'onerror', '/', 'UA', 'r1', c_i), ('fp_cockpit_2', 'Other', 'onerror', '/', 'UA', 'r1', null);
  perform pg_temp.as_user(c_a);
  v_j := public.admin_list_client_errors();
  perform pg_temp.chk('errors grouped by fingerprint', exists (select 1 from jsonb_array_elements(v_j) e where e->>'fingerprint' = 'fp_cockpit_1' and (e->>'count')::int = 2 and (e->>'users')::int = 1), left(v_j::text, 300));
  perform pg_temp.chk('error list carries no user ids or agents', v_j::text not like '%' || c_i::text || '%' and v_j::text not like '%"UA"%');

  perform pg_temp.as_pg();
  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
