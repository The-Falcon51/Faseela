-- Faseela (migration 30): server-side rate limits for anonymous and expensive RPCs.
-- Fixed-window counters keyed by user id (signed in) or a salted SHA-256 of the client IP (anonymous) — no clear-text
-- IP is ever stored. The table is unlogged (counters are disposable) and emptied nightly by pg_cron.
create unlogged table if not exists private.rate_limits (
  bucket text not null,
  subject text not null,
  window_start timestamptz not null default now(),
  hits integer not null default 1,
  primary key (bucket, subject)
);
revoke all on private.rate_limits from public, anon, authenticated;

-- Salt for the IP hash lives in Vault (created once, never leaves the database).
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'rate_salt', 'Salt for hashed client IPs in private.rate_limits')
 where not exists (select 1 from vault.secrets where name = 'rate_salt');

create or replace function private.rate_salt()
returns text
language sql
stable
security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'rate_salt' limit 1; $$;
revoke all on function private.rate_salt() from public, anon, authenticated;

/** Counts one hit for (bucket, caller) and fails with resource-exhausted above p_max per window. */
create or replace function private.rate_limit(p_bucket text, p_max integer, p_window_seconds integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_headers json;
  v_ip text;
  v_subject text;
  v_hits integer;
  v_window interval := make_interval(secs => greatest(p_window_seconds, 1));
begin
  if v_uid is not null then
    v_subject := 'u:' || v_uid::text;
  else
    begin
      v_headers := nullif(current_setting('request.headers', true), '')::json;
    exception when others then
      v_headers := null;
    end;
    -- cf-connecting-ip is set by the edge and cannot be supplied by the client; x-forwarded-for is the fallback.
    v_ip := coalesce(nullif(btrim(v_headers ->> 'cf-connecting-ip'), ''),
                     nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
                     'unknown');
    v_subject := 'ip:' || encode(sha256(convert_to(coalesce(private.rate_salt(), '') || v_ip, 'UTF8')), 'hex');
  end if;

  insert into private.rate_limits as r (bucket, subject, window_start, hits)
  values (p_bucket, v_subject, now(), 1)
  on conflict (bucket, subject) do update
     set hits = case when r.window_start < now() - v_window then 1 else r.hits + 1 end,
         window_start = case when r.window_start < now() - v_window then now() else r.window_start end
  returning r.hits into v_hits;

  if v_hits > p_max then
    perform private.fail('resource-exhausted', 'Too many requests. Please slow down and try again shortly.');
  end if;
end;
$$;
revoke all on function private.rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function private.rate_limit(text, integer, integer) to anon, authenticated;

-- Wrappers: limiter first, then the unchanged private implementation (wrappers are volatile → read/write transaction).
create or replace function public.public_tree_profile(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('public_tree_profile', 60, 60);
  select private.public_tree_profile(payload);
$$;
create or replace function public.verify_certificate(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('verify_certificate', 20, 60);
  select private.verify_certificate(payload);
$$;
create or replace function public.public_status() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('public_status', 30, 60);
  select private.public_status();
$$;
create or replace function public.report_client_error(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('report_client_error', 20, 60);
  select private.report_client_error(payload);
$$;
create or replace function public.export_my_data(payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('export_my_data', 5, 600);
  select private.export_my_data(payload);
$$;
create or replace function public.export_my_oil() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('export_my_oil', 5, 600);
  select private.export_my_oil();
$$;
create or replace function public.export_my_rewards() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('export_my_rewards', 5, 600);
  select private.export_my_rewards();
$$;
create or replace function public.payment_instructions() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('payment_instructions', 60, 60);
  select private.payment_instructions();
$$;

-- Nightly reset keeps the table small and removes hashed-IP subjects within 24 h (data minimisation).
select cron.unschedule('faseela-rate-limits-reset') where exists (select 1 from cron.job where jobname = 'faseela-rate-limits-reset');
select cron.schedule('faseela-rate-limits-reset', '17 3 * * *', $job$truncate table private.rate_limits$job$);
