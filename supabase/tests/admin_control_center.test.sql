-- Faseela control centre suite (migration 41). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_a constant uuid := 'af000000-0000-4000-8000-0000000000a1'; -- admin
  c_f constant uuid := 'af000000-0000-4000-8000-0000000000f1'; -- finance admin
  c_i constant uuid := 'af000000-0000-4000-8000-0000000000e1'; -- investor
  r1 constant text := repeat('7', 64);
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
  create function pg_temp.call_as(p uuid, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p); return pg_temp.try(p_sql); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_a, 'za@t.faseela.invalid', 'Centre Admin'), (c_f, 'zf@t.faseela.invalid', 'Centre Finance'), (c_i, 'zi@t.faseela.invalid', 'Centre 100%_Investor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_a, 'admin'), (c_f, 'finance_admin');
  select tree_id into v_tree from public.trees_public order by tree_id limit 1;
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at, proof_submitted_at)
  values (r1, c_i, v_tree, 1, false, 3500, 'USD', 'under_review', now() + interval '1 day', now());
  insert into public.role_applications (user_id, requested_role, region, submitted_at) values (c_i, 'farmer', 'Homs', now() - interval '5 days');

  -- access control
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon cannot read tasks', pg_temp.try('select public.admin_tasks()') <> 'OK');
  perform pg_temp.chk('investor cannot read tasks', pg_temp.call_as(c_i, 'select public.admin_tasks()') = 'permission-denied');
  perform pg_temp.chk('investor cannot read automations', pg_temp.call_as(c_i, 'select public.admin_automation_state()') = 'permission-denied');
  perform pg_temp.chk('investor cannot search', pg_temp.call_as(c_i, $q$select public.admin_search('{"q":"zi@"}'::jsonb)$q$) = 'permission-denied');
  perform pg_temp.chk('investor cannot pause a job', pg_temp.call_as(c_i, $q$select public.admin_set_job_active('{"name":"faseela-kpi-snapshot","active":false}'::jsonb)$q$) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot read automations', pg_temp.call_as(c_f, 'select public.admin_automation_state()') = 'permission-denied');
  perform pg_temp.chk('finance admin cannot switch a rule', pg_temp.call_as(c_f, $q$select public.admin_set_automation_rule('{"key":"review_reminder","enabled":true}'::jsonb)$q$) = 'permission-denied');
  perform pg_temp.chk('finance admin cannot read the checklist', pg_temp.call_as(c_f, 'select public.admin_readiness()') = 'permission-denied');
  perform pg_temp.chk('finance admin cannot search accounts', pg_temp.call_as(c_f, $q$select public.admin_search('{"q":"zi@"}'::jsonb)$q$) = 'permission-denied');

  -- task inbox
  perform pg_temp.as_user(c_f);
  v_j := public.admin_tasks();
  perform pg_temp.chk('finance admin sees only finance tasks', exists (select 1 from jsonb_array_elements(v_j) e where e->>'key' = 'payments_review' and (e->>'count')::int >= 1)
    and not exists (select 1 from jsonb_array_elements(v_j) e where e->>'key' in ('role_applications', 'single_admin', 'payment_accounts_missing', 'mail_failed')), v_j::text);
  perform pg_temp.as_user(c_a);
  v_j := public.admin_tasks();
  perform pg_temp.chk('admin sees every task, most urgent first', (v_j->0->>'severity') = 'critical'
    and exists (select 1 from jsonb_array_elements(v_j) e where e->>'key' = 'role_applications' and e->>'tab' = 'roles' and (e->>'oldestAt')::bigint > 0)
    and exists (select 1 from jsonb_array_elements(v_j) e where e->>'key' = 'payments_review'), v_j::text);
  perform pg_temp.chk('tasks carry no personal data', v_j::text not like '%@%' and v_j::text not like '%' || c_i::text || '%');

  -- automation rules
  perform pg_temp.chk('unknown rule refused', pg_temp.call_as(c_a, $q$select public.admin_set_automation_rule('{"key":"delete_everything","enabled":true}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.chk('enabled must be a boolean', pg_temp.call_as(c_a, $q$select public.admin_set_automation_rule('{"key":"review_reminder","enabled":"yes"}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.chk('days out of range refused', pg_temp.call_as(c_a, $q$select public.admin_set_automation_rule('{"key":"review_reminder","enabled":true,"days":0}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.as_pg();
  perform pg_temp.chk('rules are off by default', (select bool_and(not enabled) from private.automation_rules));
  select count(*) into v_n from private.email_outbox where template = 'review_needed';
  perform private.run_automations();
  perform pg_temp.chk('a switched-off rule does nothing', (select count(*) from private.email_outbox where template = 'review_needed') = v_n);
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_automation_rule('{"key":"review_reminder","enabled":true,"days":3}'::jsonb);
  perform pg_temp.as_pg();
  perform private.run_automations();
  perform pg_temp.chk('reminder goes to the admins once', (select count(*) from private.email_outbox where template = 'review_needed' and params->>'queue' = 'role_applications') >= 1
    and (select (last_result->>'ok')::boolean and last_result->'done' ? 'role_applications' from private.automation_rules where key = 'review_reminder'),
    (select last_result::text from private.automation_rules where key = 'review_reminder'));
  select count(*) into v_n from private.email_outbox where template = 'review_needed';
  perform private.run_automations();
  perform pg_temp.chk('no second reminder on the same day', (select count(*) from private.email_outbox where template = 'review_needed') = v_n);
  perform pg_temp.chk('rule change audited', exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'automation.rule_changed' and (details->>'days')::int = 3));
  -- sold-out rule: only fully sold trees that have been so for long enough
  update private.trees set sold_shares = total_shares, reserved_shares = 0 where tree_id = v_tree;
  update public.trees_public set available_shares = 0, status = 'listed', updated_at = now() - interval '20 days' where tree_id = v_tree;
  update private.automation_rules set enabled = true, config = '{"days":14}' where key = 'sold_out_unlist';
  perform private.run_automations();
  perform pg_temp.chk('sold-out tree leaves the catalogue', (select status = 'unlisted' from public.trees_public where tree_id = v_tree)
    and exists (select 1 from private.automation_log where rule = 'sold_out_unlist' and subject = v_tree));
  perform pg_temp.chk('trees with free shares stay listed', not exists (select 1 from public.trees_public p join private.trees t using (tree_id) where p.status = 'unlisted' and t.sold_shares < t.total_shares and p.tree_id <> v_tree and p.updated_at > now() - interval '1 minute'));
  perform pg_temp.chk('owners keep their shares', (select count(*) from public.shares where tree_id = v_tree) = (select count(*) from public.shares where tree_id = v_tree and status = 'active'));

  -- automation state and job control
  perform pg_temp.as_user(c_a);
  v_j := public.admin_automation_state();
  perform pg_temp.chk('state lists rules, jobs and log', jsonb_array_length(v_j->'rules') = 2 and exists (select 1 from jsonb_array_elements(v_j->'jobs') e where e->>'name' = 'faseela-automations' and (e->>'active')::boolean)
    and exists (select 1 from jsonb_array_elements(v_j->'jobs') e where e->>'name' = 'faseela-kpi-snapshot') and jsonb_array_length(v_j->'log') >= 2, left(v_j::text, 300));
  perform pg_temp.chk('job commands are not exposed', v_j::text not like '%http_post%' and v_j::text not like '%outbox_token%');
  perform pg_temp.chk('foreign job name refused', pg_temp.call_as(c_a, $q$select public.admin_set_job_active('{"name":"other-job","active":false}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.chk('unknown job refused', pg_temp.call_as(c_a, $q$select public.admin_set_job_active('{"name":"faseela-nope","active":false}'::jsonb)$q$) = 'not-found');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_job_active('{"name":"faseela-kpi-snapshot","active":false}'::jsonb);
  perform pg_temp.as_pg();
  perform pg_temp.chk('job paused and audited', (select not active from cron.job where jobname = 'faseela-kpi-snapshot')
    and exists (select 1 from public.audit_logs where actor_uid = c_a and action = 'automation.job_changed' and target = 'cron/faseela-kpi-snapshot'), v_j::text);

  -- go-live checklist
  perform pg_temp.as_user(c_a);
  v_j := public.admin_readiness();
  perform pg_temp.chk('checklist has 9 automatic and 8 manual items', jsonb_array_length(v_j->'auto') = 9 and jsonb_array_length(v_j->'manual') = 8 and (v_j->'manual'->0->>'key') = 'legal_opinion', left(v_j::text, 300));
  perform pg_temp.chk('unknown checklist item refused', pg_temp.call_as(c_a, $q$select public.admin_set_readiness('{"key":"world_peace","done":true}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_set_readiness('{"key":"test_purchase","done":true,"note":"  Kauf am 13.11. geprueft  "}'::jsonb);
  v_j := public.admin_readiness();
  perform pg_temp.chk('manual item stored with trimmed note', exists (select 1 from jsonb_array_elements(v_j->'manual') e where e->>'key' = 'test_purchase' and (e->>'done')::boolean and e->>'note' = 'Kauf am 13.11. geprueft'), (v_j->'manual')::text);

  -- search and history
  perform pg_temp.chk('one-letter search refused', pg_temp.call_as(c_a, $q$select public.admin_search('{"q":"z"}'::jsonb)$q$) = 'invalid-argument');
  perform pg_temp.as_user(c_a);
  v_j := public.admin_search('{"q":"zi@t.faseela"}'::jsonb);
  perform pg_temp.chk('search finds the account', jsonb_array_length(v_j->'users') = 1 and (v_j->'users'->0->>'id') = c_i::text, v_j::text);
  v_j := public.admin_search('{"q":"%%"}'::jsonb);
  perform pg_temp.chk('wildcards are matched literally', jsonb_array_length(v_j->'users') = 0 and jsonb_array_length(v_j->'trees') = 0, v_j::text);
  v_j := public.admin_search('{"q":"100%_inv"}'::jsonb);
  perform pg_temp.chk('literal percent and underscore match', jsonb_array_length(v_j->'users') = 1, v_j::text);
  v_j := public.admin_search(jsonb_build_object('q', left(r1, 12)));
  perform pg_temp.chk('search finds a request by id', jsonb_array_length(v_j->'requests') = 1 and (v_j->'requests'->0->>'status') = 'under_review', v_j::text);
  v_j := public.admin_kpi_history();
  perform pg_temp.chk('history has today with headline figures', jsonb_array_length(v_j) >= 1 and (v_j->-1) ?& array['day', 'users', 'owners', 'approvedMinor', 'soldShares'], left(v_j::text, 300));

  perform pg_temp.as_pg();
  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
