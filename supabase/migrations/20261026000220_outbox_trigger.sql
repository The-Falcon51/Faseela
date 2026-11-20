-- Shared token between pg_cron (sender side) and the send-emails Edge Function (receiver side).
-- Generated inside the database and stored in Vault; never leaves the project.
select vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'outbox_token', 'Faseela: pg_cron -> send-emails authentication');

create function public.outbox_token()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'outbox_token' limit 1;
$$;
revoke all on function public.outbox_token() from public, anon, authenticated;
grant execute on function public.outbox_token() to service_role;

-- Every minute, but only while there is work: one HTTP call per minute at most.
select cron.schedule('faseela-send-emails', '* * * * *', $$
  select net.http_post(
    url := 'https://riyvlhlhzxxerlwqoxsy.supabase.co/functions/v1/send-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-outbox-token', (select decrypted_secret from vault.decrypted_secrets where name = 'outbox_token' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
   where exists (select 1 from private.email_outbox
                  where status = 'pending'
                     or (status = 'sending' and claimed_at < now() - interval '10 minutes'));
$$);
