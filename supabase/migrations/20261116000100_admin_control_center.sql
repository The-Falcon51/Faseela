-- Faseela (migration 41): control centre for the admin panel — one task inbox, switchable automation rules,
-- job control, a go-live checklist, global search and a daily KPI history.
-- Automation rules are OFF by default: they send e-mails, and e-mails fail until a provider is connected.

create table if not exists private.automation_rules (
  key text primary key check (key in ('review_reminder', 'sold_out_unlist')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  last_run_at timestamptz,
  last_result jsonb
);
create table if not exists private.automation_log (
  rule text not null,
  subject text not null,
  day date not null default current_date,
  created_at timestamptz not null default now(),
  primary key (rule, subject, day)
);
create table if not exists private.kpi_daily (
  day date primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists private.readiness_manual (
  key text primary key check (key in ('legal_opinion', 'legal_texts', 'sanctions_process', 'mail_domain', 'test_purchase', 'restore_test', 'store_accounts', 'support_contact')),
  done boolean not null default false,
  note text check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
alter table private.automation_rules enable row level security;
alter table private.automation_log enable row level security;
alter table private.kpi_daily enable row level security;
alter table private.readiness_manual enable row level security;
revoke all on private.automation_rules, private.automation_log, private.kpi_daily, private.readiness_manual from public, anon, authenticated;
insert into private.automation_rules (key, config) values ('review_reminder', '{"days":2}'), ('sold_out_unlist', '{"days":14}')
on conflict (key) do nothing;

/** One row of headline figures per day, so the panel can show change over time. */
create or replace function private.kpi_snapshot()
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.kpi_daily (day, data)
  values (current_date, jsonb_build_object(
    'users', (select count(*) from auth.users where deleted_at is null),
    'confirmedUsers', (select count(*) from auth.users where deleted_at is null and email_confirmed_at is not null),
    'owners', (select count(distinct user_id) from public.shares where status = 'active'),
    'approvedMinor', (select coalesce(sum(amount_minor), 0) from public.investment_requests where status = 'approved'),
    'soldShares', (select coalesce(sum(sold_shares), 0) from private.trees),
    'totalShares', (select coalesce(sum(total_shares), 0) from private.trees),
    'openRequests', (select count(*) from public.investment_requests where status in ('awaiting_payment', 'under_review'))))
  on conflict (day) do update set data = excluded.data, created_at = now();
$$;

/** Runs every enabled rule once. Each rule records what it did; a failing rule never stops the others. */
create or replace function private.run_automations()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r private.automation_rules;
  v_days integer;
  v_done jsonb;
  q record;
  v_tree text;
begin
  for r in select * from private.automation_rules where enabled loop
    v_days := greatest(1, least(coalesce((r.config ->> 'days')::integer, 2), 90));
    v_done := '[]'::jsonb;
    begin
      if r.key = 'review_reminder' then
        -- One reminder per queue and day while its oldest open item is older than the limit.
        for q in
          select * from (values
            ('role_applications', 'admin', (select min(submitted_at) from public.role_applications where status = 'pending')),
            ('farmer_updates', 'quality_auditor', (select min(created_at) from public.farmer_updates where status = 'pending_review')),
            ('pressing_batches', 'quality_auditor', (select min(created_at) from public.pressing_batches where status = 'pending_review')),
            ('oil_requests', 'finance_admin', (select min(created_at) from public.oil_requests where status in ('pending', 'approved')))
          ) as x(queue, role, oldest)
          where x.oldest < now() - make_interval(days => v_days)
        loop
          insert into private.automation_log (rule, subject) values (r.key, q.queue) on conflict do nothing;
          if found then
            perform private.notify_role(q.role, 'review_needed', jsonb_build_object('queue', q.queue));
            v_done := v_done || to_jsonb(q.queue);
          end if;
        end loop;
      elsif r.key = 'sold_out_unlist' then
        -- A tree that has been fully sold for the given time leaves the catalogue; owners keep everything.
        for v_tree in
          update public.trees_public p set status = 'unlisted', updated_at = now()
            from private.trees t
           where t.tree_id = p.tree_id and p.status = 'listed' and t.sold_shares = t.total_shares and t.reserved_shares = 0
             and p.updated_at < now() - make_interval(days => v_days)
          returning p.tree_id
        loop
          insert into private.automation_log (rule, subject) values (r.key, v_tree) on conflict do nothing;
          v_done := v_done || to_jsonb(v_tree);
        end loop;
      end if;
      update private.automation_rules set last_run_at = now(), last_result = jsonb_build_object('ok', true, 'done', v_done) where key = r.key;
    exception when others then
      update private.automation_rules set last_run_at = now(), last_result = jsonb_build_object('ok', false, 'error', left(sqlerrm, 200)) where key = r.key;
    end;
  end loop;
end;
$$;

/** Rules, background jobs with their last run, and the latest automation actions. */
create or replace function private.admin_automation_state()
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
    'rules', (select coalesce(jsonb_agg(jsonb_build_object('key', a.key, 'enabled', a.enabled, 'days', coalesce((a.config ->> 'days')::integer, 2),
        'updatedAt', private.epoch_ms(a.updated_at), 'lastRunAt', private.epoch_ms(a.last_run_at), 'lastResult', a.last_result) order by a.key), '[]'::jsonb)
        from private.automation_rules a),
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('name', j.jobname, 'schedule', j.schedule, 'active', j.active,
        'lastStatus', l.status, 'lastStart', private.epoch_ms(l.start_time),
        'lastDurationMs', round(extract(epoch from (l.end_time - l.start_time)) * 1000),
        'failures24h', (select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours')) order by j.jobname), '[]'::jsonb)
        from cron.job j
        left join lateral (select d.status, d.start_time, d.end_time from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) l on true
       where j.jobname like 'faseela-%'),
    'log', (select coalesce(jsonb_agg(jsonb_build_object('rule', x.rule, 'subject', x.subject, 'at', private.epoch_ms(x.created_at)) order by x.created_at desc), '[]'::jsonb)
        from (select * from private.automation_log order by created_at desc limit 30) x));
end;
$$;

create or replace function private.admin_set_automation_rule(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_key text := private.req_id(p, 'key', '^(review_reminder|sold_out_unlist)$');
  v_days integer := private.opt_int(p, 'days', 1, 90)::integer;
begin
  if jsonb_typeof(p -> 'enabled') is distinct from 'boolean' then
    perform private.fail('invalid-argument', 'Field enabled is invalid.');
  end if;
  update private.automation_rules
     set enabled = (p ->> 'enabled')::boolean,
         config = case when v_days is null then config else jsonb_build_object('days', v_days) end,
         updated_at = now(), updated_by = v_uid
   where key = v_key;
  perform private.audit(v_uid, 'automation.rule_changed', 'automation_rules/' || v_key, jsonb_build_object('enabled', (p ->> 'enabled')::boolean, 'days', v_days));
  return jsonb_build_object('key', v_key, 'enabled', (p ->> 'enabled')::boolean);
end;
$$;

/** Pauses or resumes one of the platform's own background jobs. */
create or replace function private.admin_set_job_active(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_name text := private.req_id(p, 'name', '^faseela-[a-z-]{3,40}$');
  v_job bigint;
begin
  if jsonb_typeof(p -> 'active') is distinct from 'boolean' then
    perform private.fail('invalid-argument', 'Field active is invalid.');
  end if;
  select jobid into v_job from cron.job where jobname = v_name;
  if v_job is null then
    perform private.fail('not-found', 'Job was not found.');
  end if;
  perform cron.alter_job(job_id := v_job, active := (p ->> 'active')::boolean);
  perform private.audit(v_uid, 'automation.job_changed', 'cron/' || v_name, jsonb_build_object('active', (p ->> 'active')::boolean));
  return jsonb_build_object('name', v_name, 'active', (p ->> 'active')::boolean);
end;
$$;

/** Everything that needs a person, most urgent first. A finance admin only gets the finance items. */
create or replace function private.admin_tasks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  v_admin boolean := exists (select 1 from private.user_roles where user_id = v_uid and role = 'admin');
begin
  return (
    with t(key, severity, n, oldest, tab, finance) as (
      select 'payments_overdue', 'critical', count(*), min(proof_submitted_at), 'payments', true from public.investment_requests where status = 'under_review' and coalesce(sla_breached, false)
      union all select 'payments_review', 'high', count(*), min(proof_submitted_at), 'payments', true from public.investment_requests where status = 'under_review' and not coalesce(sla_breached, false)
      union all select 'oil_requests', 'normal', count(*), min(created_at), 'reviews', true from public.oil_requests where status in ('pending', 'approved')
      union all select 'role_applications', 'normal', count(*), min(submitted_at), 'roles', false from public.role_applications where status = 'pending'
      union all select 'farmer_updates', 'normal', count(*), min(created_at), 'reviews', false from public.farmer_updates where status = 'pending_review'
      union all select 'pressing_batches', 'normal', count(*), min(created_at), 'reviews', false from public.pressing_batches where status = 'pending_review'
      union all select 'mail_failed', 'high', count(*), min(created_at), 'mail', false from private.email_outbox where status = 'failed' and created_at > now() - interval '7 days'
      union all select 'client_errors', 'normal', count(*), min(created_at), 'errors', false from private.client_errors where created_at > now() - interval '24 hours'
      union all select 'trees_without_farmer', 'normal', count(*), null, 'trees', false from public.trees_public p where p.status = 'listed'
                  and not exists (select 1 from public.farmer_assignments a where a.tree_id = p.tree_id and a.revoked_at is null)
      union all select 'trees_without_mill', 'normal', count(*), null, 'trees', false from public.trees_public p join private.trees t using (tree_id) where p.status = 'listed' and t.mill_id is null
      union all select 'trees_sold_out', 'info', count(*), null, 'trees', true from public.trees_public where status = 'listed' and available_shares = 0
      union all select 'payment_accounts_missing', 'critical', case when exists (select 1 from private.app_settings s where s.key = 'payment_instructions'
                  and jsonb_array_length(coalesce(s.value -> 'channels', '[]'::jsonb)) > 0) then 0 else 1 end, null, 'accounts', false
      union all select 'single_admin', 'high', case when (select count(*) from private.user_roles where role = 'admin') < 2 then 1 else 0 end, null, 'users', false
      union all select 'jobs_failing', 'high', count(distinct d.jobid), min(d.start_time), 'automation', false
                  from cron.job j join cron.job_run_details d on d.jobid = j.jobid
                 where j.jobname like 'faseela-%' and d.status = 'failed' and d.start_time > now() - interval '24 hours'
    )
    select coalesce(jsonb_agg(jsonb_build_object('key', key, 'severity', severity, 'count', n, 'oldestAt', private.epoch_ms(oldest), 'tab', tab)
             order by array_position(array['critical', 'high', 'normal', 'info'], severity), oldest nulls last), '[]'::jsonb)
      from t where n > 0 and (v_admin or finance));
end;
$$;

/** Go-live checklist: facts the database can verify itself plus items a person confirms. */
create or replace function private.admin_readiness()
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
    'auto', jsonb_build_array(
      jsonb_build_object('key', 'payment_accounts', 'ok', exists (select 1 from private.app_settings s where s.key = 'payment_instructions' and jsonb_array_length(coalesce(s.value -> 'channels', '[]'::jsonb)) > 0)),
      jsonb_build_object('key', 'mail_delivered', 'ok', exists (select 1 from private.email_outbox where status = 'sent')),
      jsonb_build_object('key', 'two_admins', 'ok', (select count(*) from private.user_roles where role = 'admin') >= 2),
      jsonb_build_object('key', 'finance_admin', 'ok', exists (select 1 from private.user_roles where role = 'finance_admin')),
      jsonb_build_object('key', 'trees_listed', 'ok', exists (select 1 from public.trees_public where status = 'listed' and available_shares > 0)),
      jsonb_build_object('key', 'trees_have_farmer', 'ok', not exists (select 1 from public.trees_public p where p.status = 'listed'
          and not exists (select 1 from public.farmer_assignments a where a.tree_id = p.tree_id and a.revoked_at is null))),
      jsonb_build_object('key', 'trees_have_mill', 'ok', not exists (select 1 from public.trees_public p join private.trees t using (tree_id) where p.status = 'listed' and t.mill_id is null)),
      jsonb_build_object('key', 'jobs_healthy', 'ok', not exists (select 1 from cron.job j join cron.job_run_details d on d.jobid = j.jobid
          where j.jobname like 'faseela-%' and d.status = 'failed' and d.start_time > now() - interval '24 hours')),
      jsonb_build_object('key', 'no_client_errors', 'ok', not exists (select 1 from private.client_errors where created_at > now() - interval '24 hours'))),
    'manual', (select jsonb_agg(jsonb_build_object('key', k, 'done', coalesce(m.done, false), 'note', m.note, 'updatedAt', private.epoch_ms(m.updated_at)) order by ord)
                 from unnest(array['legal_opinion', 'legal_texts', 'sanctions_process', 'mail_domain', 'test_purchase', 'restore_test', 'store_accounts', 'support_contact']) with ordinality as u(k, ord)
                 left join private.readiness_manual m on m.key = u.k));
end;
$$;

create or replace function private.admin_set_readiness(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_key text := private.req_id(p, 'key', '^(legal_opinion|legal_texts|sanctions_process|mail_domain|test_purchase|restore_test|store_accounts|support_contact)$');
  v_note text := nullif(btrim(coalesce(private.opt_text(p, 'note', 500), '')), '');
begin
  if jsonb_typeof(p -> 'done') is distinct from 'boolean' then
    perform private.fail('invalid-argument', 'Field done is invalid.');
  end if;
  insert into private.readiness_manual (key, done, note, updated_by) values (v_key, (p ->> 'done')::boolean, v_note, v_uid)
  on conflict (key) do update set done = excluded.done, note = excluded.note, updated_at = now(), updated_by = excluded.updated_by;
  perform private.audit(v_uid, 'readiness.changed', 'readiness/' || v_key, jsonb_build_object('done', (p ->> 'done')::boolean));
  return jsonb_build_object('key', v_key, 'done', (p ->> 'done')::boolean);
end;
$$;

/** Search across accounts, requests and trees. The term is matched literally (no wildcards from the caller). */
create or replace function private.admin_search(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_q text := btrim(coalesce(private.opt_text(coalesce(payload, '{}'::jsonb), 'q', 80), ''));
  v_like text;
begin
  if char_length(v_q) < 2 then
    perform private.fail('invalid-argument', 'Search term is too short.');
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'users', (select coalesce(jsonb_agg(x.j), '[]'::jsonb) from (select jsonb_build_object('id', pr.id, 'name', pr.display_name, 'email', pr.email) j
        from public.profiles pr where pr.email ilike v_like or pr.display_name ilike v_like order by pr.created_at desc limit 8) x),
    'requests', (select coalesce(jsonb_agg(x.j), '[]'::jsonb) from (select jsonb_build_object('id', i.id, 'treeId', i.tree_id, 'status', i.status, 'amountMinor', i.amount_minor, 'createdAt', private.epoch_ms(i.created_at)) j
        from public.investment_requests i where i.id ilike v_like order by i.created_at desc limit 8) x),
    'trees', (select coalesce(jsonb_agg(x.j), '[]'::jsonb) from (select jsonb_build_object('treeId', p.tree_id, 'name', p.name_en, 'status', p.status) j
        from public.trees_public p where p.tree_id ilike v_like or p.name ilike v_like or p.name_en ilike v_like order by p.tree_id limit 8) x));
end;
$$;

create or replace function private.admin_kpi_history()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
begin
  return (select coalesce(jsonb_agg(k.data || jsonb_build_object('day', k.day) order by k.day), '[]'::jsonb)
            from (select * from private.kpi_daily order by day desc limit 90) k);
end;
$$;

create or replace function public.admin_automation_state() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_automation_state(); $$;
create or replace function public.admin_tasks() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_tasks(); $$;
create or replace function public.admin_readiness() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_readiness(); $$;
create or replace function public.admin_kpi_history() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_kpi_history(); $$;
create or replace function public.admin_search(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_search', 60, 60); select private.admin_search(payload); $$;
create or replace function public.admin_set_automation_rule(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_automation_rule(payload); $$;
create or replace function public.admin_set_job_active(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_job_active(payload); $$;
create or replace function public.admin_set_readiness(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_readiness(payload); $$;

revoke all on function private.kpi_snapshot(), private.run_automations(),
  private.admin_automation_state(), private.admin_tasks(), private.admin_readiness(), private.admin_kpi_history(), private.admin_search(jsonb),
  private.admin_set_automation_rule(jsonb), private.admin_set_job_active(jsonb), private.admin_set_readiness(jsonb),
  public.admin_automation_state(), public.admin_tasks(), public.admin_readiness(), public.admin_kpi_history(), public.admin_search(jsonb),
  public.admin_set_automation_rule(jsonb), public.admin_set_job_active(jsonb), public.admin_set_readiness(jsonb)
  from public, anon, authenticated;
grant execute on function private.admin_automation_state(), private.admin_tasks(), private.admin_readiness(), private.admin_kpi_history(), private.admin_search(jsonb),
  private.admin_set_automation_rule(jsonb), private.admin_set_job_active(jsonb), private.admin_set_readiness(jsonb),
  public.admin_automation_state(), public.admin_tasks(), public.admin_readiness(), public.admin_kpi_history(), public.admin_search(jsonb),
  public.admin_set_automation_rule(jsonb), public.admin_set_job_active(jsonb), public.admin_set_readiness(jsonb)
  to authenticated;

select private.kpi_snapshot();
select cron.unschedule('faseela-kpi-snapshot') where exists (select 1 from cron.job where jobname = 'faseela-kpi-snapshot');
select cron.schedule('faseela-kpi-snapshot', '50 23 * * *', $job$select private.kpi_snapshot()$job$);
select cron.unschedule('faseela-automations') where exists (select 1 from cron.job where jobname = 'faseela-automations');
select cron.schedule('faseela-automations', '25 * * * *', $job$select private.run_automations()$job$);
