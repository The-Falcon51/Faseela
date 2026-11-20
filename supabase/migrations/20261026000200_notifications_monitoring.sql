-- Transactional e-mail outbox + basic monitoring (client errors, ops status, alerts).
--
-- Outbox pattern: RPCs enqueue rows in private.email_outbox inside the same transaction as the
-- business change (never lost, never sent for a rolled-back change). A pg_cron job triggers the
-- Edge Function `send-emails` (pg_net) only while pending rows exist; the function claims rows via
-- the service-role-only wrappers below and delivers them through the configured provider.

create extension if not exists pg_net with schema extensions; -- never in public (Supabase lint 0014)

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------
create table private.email_outbox (
  id bigint generated always as identity primary key,
  recipient text not null,
  template text not null check (template ~ '^[a-z_]{1,60}$'),
  params jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz
);
create index email_outbox_pending_idx on private.email_outbox (status, created_at) where status in ('pending', 'sending');
revoke all on private.email_outbox from public, anon, authenticated;

create function private.enqueue_email(p_recipient text, p_template text, p_params jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.email_outbox (recipient, template, params)
  select p_recipient, p_template, coalesce(p_params, '{}'::jsonb)
   where p_recipient is not null and p_recipient ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
$$;

create function private.notify_user(p_uid uuid, p_template text, p_params jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.enqueue_email(u.email, p_template, p_params)
    from auth.users u
   where u.id = p_uid and u.deleted_at is null and u.banned_until is null;
$$;

-- All active users holding a role (admin receives everything a role receives).
create function private.notify_role(p_role text, p_template text, p_params jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.enqueue_email(u.email, p_template, p_params)
    from private.user_roles r
    join auth.users u on u.id = r.user_id
   where (r.role = p_role or r.role = 'admin') and u.deleted_at is null and u.banned_until is null;
$$;

-- Service-role wrappers for the sender (never callable by clients).
create function public.outbox_claim(p_limit integer default 20)
returns setof private.email_outbox
language sql
security definer
set search_path = ''
as $$
  update private.email_outbox o
     set status = 'sending', attempts = attempts + 1, claimed_at = now()
   where o.id in (
     select id from private.email_outbox
      where status = 'pending'
         or (status = 'sending' and claimed_at < now() - interval '10 minutes') -- crashed sender
      order by created_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
      for update skip locked)
  returning o.*;
$$;

create function public.outbox_mark(p_id bigint, p_ok boolean, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.email_outbox
     set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'pending' end,
         sent_at = case when p_ok then now() else sent_at end,
         last_error = case when p_ok then null else left(p_error, 500) end
   where id = p_id;
$$;

revoke all on function public.outbox_claim(integer), public.outbox_mark(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.outbox_claim(integer), public.outbox_mark(bigint, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- Client error reports (no PII: message, source, stack prefix, path, coarse UA)
-- ---------------------------------------------------------------------------
create table private.client_errors (
  id bigint generated always as identity primary key,
  fingerprint text not null,
  message text not null,
  source text,
  stack text,
  page text,
  user_agent text,
  release text,
  user_id uuid,
  created_at timestamptz not null default now()
);
create index client_errors_created_idx on private.client_errors (created_at desc);
create index client_errors_fp_idx on private.client_errors (fingerprint, created_at desc);
revoke all on private.client_errors from public, anon, authenticated;

-- Caps: 20 reports per fingerprint per hour, 500 reports per hour overall; silently dropped beyond that.
create function private.report_client_error(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_msg text := left(coalesce(p ->> 'message', ''), 500);
  v_src text := left(coalesce(p ->> 'source', ''), 200);
  v_fp text;
begin
  if v_msg = '' then
    return jsonb_build_object('stored', false);
  end if;
  v_fp := encode(sha256(convert_to(v_msg || '|' || v_src, 'UTF8')), 'hex');
  if (select count(*) from private.client_errors where fingerprint = v_fp and created_at > now() - interval '1 hour') >= 20
     or (select count(*) from private.client_errors where created_at > now() - interval '1 hour') >= 500 then
    return jsonb_build_object('stored', false);
  end if;
  insert into private.client_errors (fingerprint, message, source, stack, page, user_agent, release, user_id)
  values (v_fp, v_msg, v_src, left(coalesce(p ->> 'stack', ''), 1500), left(coalesce(p ->> 'page', ''), 200),
          left(coalesce(p ->> 'userAgent', ''), 120), left(coalesce(p ->> 'release', ''), 40), (select auth.uid()));
  return jsonb_build_object('stored', true);
end;
$$;

create function public.report_client_error(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.report_client_error(payload); $$;
revoke all on function private.report_client_error(jsonb), public.report_client_error(jsonb) from public;
grant execute on function private.report_client_error(jsonb), public.report_client_error(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ops status for the admin panel + hourly alert (deduplicated)
-- ---------------------------------------------------------------------------
create table private.ops_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
revoke all on private.ops_state from public, anon, authenticated;

create function private.admin_system_status(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_role('{}'::text[]);
  return jsonb_build_object(
    'generatedAt', private.epoch_ms(now()),
    'outbox', jsonb_build_object(
      'pending', (select count(*) from private.email_outbox where status in ('pending', 'sending')),
      'failed', (select count(*) from private.email_outbox where status = 'failed'),
      'sent24h', (select count(*) from private.email_outbox where status = 'sent' and sent_at > now() - interval '24 hours'),
      'lastError', (select last_error from private.email_outbox where last_error is not null order by claimed_at desc nulls last limit 1)),
    'clientErrors', jsonb_build_object(
      'last24h', (select count(*) from private.client_errors where created_at > now() - interval '24 hours'),
      'top', coalesce((select jsonb_agg(jsonb_build_object('message', e.message, 'count', e.n, 'lastSeen', private.epoch_ms(e.last_seen)) order by e.n desc)
                        from (select message, count(*) as n, max(created_at) as last_seen
                                from private.client_errors where created_at > now() - interval '24 hours'
                               group by message order by n desc limit 5) e), '[]'::jsonb)),
    'reviews', jsonb_build_object(
      'paymentsPending', (select count(*) from public.investment_requests where status = 'under_review'),
      'paymentsOverdue', (select count(*) from public.investment_requests where status = 'under_review' and sla_breached),
      'farmerUpdatesPending', (select count(*) from public.farmer_updates where status = 'pending_review'),
      'batchesPending', (select count(*) from public.pressing_batches where status = 'pending_review'),
      'roleApplicationsPending', (select count(*) from public.role_applications where status = 'pending')),
    'jobs', coalesce((select jsonb_agg(jsonb_build_object('name', j.jobname, 'lastStatus', d.status, 'lastRun', private.epoch_ms(d.end_time)))
                       from cron.job j
                       left join lateral (select status, end_time from cron.job_run_details where jobid = j.jobid order by start_time desc limit 1) d on true
                      where j.jobname like 'faseela-%'), '[]'::jsonb)
  );
end;
$$;

create function public.admin_system_status(payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_system_status(payload); $$;
revoke all on function private.admin_system_status(jsonb), public.admin_system_status(jsonb) from public, anon;
grant execute on function private.admin_system_status(jsonb), public.admin_system_status(jsonb) to authenticated;

-- Hourly: alert admins once per 6 h when deliveries fail or client errors spike; prune old rows.
create function private.ops_check()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_failed integer := (select count(*) from private.email_outbox where status = 'failed' and created_at > now() - interval '24 hours');
  v_errors integer := (select count(*) from private.client_errors where created_at > now() - interval '1 hour');
  v_last timestamptz := (select (value ->> 'at')::timestamptz from private.ops_state where key = 'last_alert');
begin
  if (v_failed > 0 or v_errors >= 50) and (v_last is null or v_last < now() - interval '6 hours') then
    perform private.notify_role('admin', 'ops_alert', jsonb_build_object('failedEmails', v_failed, 'clientErrorsLastHour', v_errors));
    insert into private.ops_state (key, value) values ('last_alert', jsonb_build_object('at', now()))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return jsonb_build_object('failedEmails', v_failed, 'clientErrorsLastHour', v_errors);
end;
$$;

select cron.schedule('faseela-ops-check', '15 * * * *', $$select private.ops_check()$$);

-- Sender trigger (Vault token + pg_cron -> Edge Function): see 20261026000220_outbox_trigger.sql.
