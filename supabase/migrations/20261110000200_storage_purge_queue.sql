-- Faseela: storage purge queue (migration 27). Account removal must not touch storage.objects rows directly
-- (Supabase's storage.protect_delete trigger refuses it, and a bare row removal would leave the blob behind).
-- Instead the request is queued here and the Edge Function `purge-storage` removes prefix + blobs via the
-- Storage API, claimed/marked through service-role-only RPCs — same pattern as the e-mail outbox.
create table if not exists private.storage_purge_queue (
  id bigint generated always as identity primary key,
  bucket text not null check (bucket in ('field-media', 'payment-proofs')),
  prefix text not null check (prefix ~ '^[A-Za-z0-9._/-]{1,200}$'),
  reason text not null default '' check (char_length(reason) <= 80),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  removed_objects integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz
);
create index if not exists storage_purge_queue_status_idx on private.storage_purge_queue (status, created_at);
revoke all on private.storage_purge_queue from public, anon, authenticated;

/** Enqueues a prefix purge; idempotent per (bucket, prefix) while a request is still open. */
create or replace function private.enqueue_storage_purge(p_bucket text, p_prefix text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from private.storage_purge_queue where bucket = p_bucket and prefix = p_prefix and status in ('pending', 'running')) then
    return;
  end if;
  insert into private.storage_purge_queue (bucket, prefix, reason) values (p_bucket, p_prefix, left(coalesce(p_reason, ''), 80));
end;
$$;
revoke all on function private.enqueue_storage_purge(text, text, text) from public, anon, authenticated;

create or replace function public.storage_purge_claim(p_limit integer default 10)
returns setof private.storage_purge_queue
language sql
security definer
set search_path = ''
as $$
  update private.storage_purge_queue q
     set status = 'running', attempts = attempts + 1, claimed_at = now()
   where q.id in (
     select id from private.storage_purge_queue
      where status = 'pending'
         or (status = 'running' and claimed_at < now() - interval '15 minutes')
      order by created_at
      limit greatest(1, least(coalesce(p_limit, 10), 50))
      for update skip locked)
  returning q.*;
$$;

create or replace function public.storage_purge_mark(p_id bigint, p_ok boolean, p_removed integer default 0, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.storage_purge_queue
     set status = case when p_ok then 'done' when attempts >= 5 then 'failed' else 'pending' end,
         removed_objects = removed_objects + greatest(coalesce(p_removed, 0), 0),
         done_at = case when p_ok then now() else done_at end,
         last_error = case when p_ok then null else left(p_error, 500) end
   where id = p_id;
$$;

revoke all on function public.storage_purge_claim(integer), public.storage_purge_mark(bigint, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.storage_purge_claim(integer), public.storage_purge_mark(bigint, boolean, integer, text) to service_role;

-- Cron: every 5 minutes, only while something is queued (same token header as the outbox sender).
select cron.unschedule('faseela-purge-storage') where exists (select 1 from cron.job where jobname = 'faseela-purge-storage');
select cron.schedule('faseela-purge-storage', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://riyvlhlhzxxerlwqoxsy.supabase.co/functions/v1/purge-storage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-outbox-token', (select decrypted_secret from vault.decrypted_secrets where name = 'outbox_token' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
   where exists (select 1 from private.storage_purge_queue
                  where status = 'pending'
                     or (status = 'running' and claimed_at < now() - interval '15 minutes'));
$job$);

-- Monitoring hook: failed purges count like failed e-mails in ops_check [PLATZHALTER: Alert-Schwelle] — surfaced via
-- admin_system_status in a later migration if needed.
