-- Faseela (migration 33): push notifications for the native app.
-- Design: the same outbox pattern as e-mail. private.notify_user() additionally queues a push row when the user has
-- an active device token; the Edge Function `send-push` claims rows and talks to FCM. The queue stores NO message
-- parameters: push texts are generic per template (no amounts, names or request ids leave the EU database).
-- Tokens are never removed row-wise here; a retired token is overwritten with a tombstone ('x:<id>') so the device
-- identifier itself does not linger. Account removal clears both tables through the foreign keys.
create table if not exists private.push_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null unique check (token ~ '^(x:[0-9]+|[A-Za-z0-9_:.-]{20,4096})$'),
  platform text not null check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason in ('user', 'unregistered', 'cap', 'reassigned'))
);
create index if not exists push_tokens_user_active_idx on private.push_tokens (user_id, last_seen_at desc) where disabled_at is null;
alter table private.push_tokens enable row level security;
revoke all on private.push_tokens from public, anon, authenticated;

create table if not exists private.push_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  template text not null check (template ~ '^[a-z_]{1,60}$'),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'expired')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz
);
create index if not exists push_outbox_pending_idx on private.push_outbox (status, created_at) where status in ('pending', 'sending');
create index if not exists push_outbox_user_idx on private.push_outbox (user_id, template, created_at desc);
alter table private.push_outbox enable row level security;
revoke all on private.push_outbox from public, anon, authenticated;

/** Retires a token: the row stays for the audit trail of the device count, the identifier itself is overwritten. */
create or replace function private.retire_push_token(p_id bigint, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.push_tokens
     set disabled_at = now(), disabled_reason = p_reason, token = 'x:' || id::text
   where id = p_id and disabled_at is null;
$$;

/** Queues one push per (user, template); bursts of the same template within a minute collapse into one. */
create or replace function private.enqueue_push(p_uid uuid, p_template text, p_params jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.push_outbox (user_id, template)
  select p_uid, p_template
   where p_template ~ '^[a-z_]{1,60}$'
     and coalesce(p_params ->> 'marketing', '') <> 'true'
     and exists (select 1 from auth.users u where u.id = p_uid and u.deleted_at is null and u.banned_until is null)
     and exists (select 1 from private.push_tokens t where t.user_id = p_uid and t.disabled_at is null)
     and not exists (select 1 from private.push_outbox o
                      where o.user_id = p_uid and o.template = p_template and o.status = 'pending'
                        and o.created_at > now() - interval '1 minute');
exception when others then
  -- A push is a convenience channel: it must never abort the business transaction that triggered it.
  raise warning 'enqueue_push failed for template %: %', p_template, sqlerrm;
end;
$$;

-- notify_user keeps its e-mail behaviour and additionally feeds the push queue.
create or replace function private.notify_user(p_uid uuid, p_template text, p_params jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.enqueue_email(u.email, p_template, p_params)
    from auth.users u
   where u.id = p_uid and u.deleted_at is null and u.banned_until is null;
  select private.enqueue_push(p_uid, p_template, p_params);
$$;

/** Registers (or refreshes) the calling user's device token. A token that belonged to another account moves over. */
create or replace function private.register_push_token(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_token text := private.req_id(p, 'token', '^[A-Za-z0-9_:.-]{20,4096}$');
  v_platform text := private.req_id(p, 'platform', '^(android|ios)$');
  v_previous uuid;
  v_extra bigint;
  v_active integer;
begin
  select user_id into v_previous from private.push_tokens where token = v_token for update;
  if found then
    update private.push_tokens
       set user_id = v_uid, platform = v_platform, last_seen_at = now(), disabled_at = null, disabled_reason = null
     where token = v_token;
    if v_previous <> v_uid then
      perform private.audit(v_uid, 'push_token.reassigned', 'push_tokens', '{}'::jsonb);
    end if;
  else
    insert into private.push_tokens (user_id, token, platform) values (v_uid, v_token, v_platform);
  end if;
  -- At most 10 active devices per account; the least recently seen ones are retired.
  for v_extra in
    select id from private.push_tokens where user_id = v_uid and disabled_at is null order by last_seen_at desc, id desc offset 10
  loop
    perform private.retire_push_token(v_extra, 'cap');
  end loop;
  select count(*) into v_active from private.push_tokens where user_id = v_uid and disabled_at is null;
  return jsonb_build_object('registered', true, 'activeDevices', v_active);
end;
$$;

/** Switches push off for one device of the calling user (sign-out, or the user turned it off). */
create or replace function private.unregister_push_token(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_token text := private.req_id(coalesce(payload, '{}'::jsonb), 'token', '^[A-Za-z0-9_:.-]{20,4096}$');
  v_id bigint;
begin
  select id into v_id from private.push_tokens where token = v_token and user_id = v_uid and disabled_at is null;
  if v_id is not null then
    perform private.retire_push_token(v_id, 'user');
  end if;
  return jsonb_build_object('unregistered', v_id is not null,
    'activeDevices', (select count(*) from private.push_tokens where user_id = v_uid and disabled_at is null));
end;
$$;

/** Number of devices of the calling user that currently receive pushes. */
create or replace function private.push_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return jsonb_build_object('activeDevices',
    (select count(*) from private.push_tokens where user_id = v_uid and disabled_at is null));
end;
$$;

create or replace function public.register_push_token(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('register_push_token', 20, 600);
  select private.register_push_token(payload);
$$;
create or replace function public.unregister_push_token(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('unregister_push_token', 20, 600);
  select private.unregister_push_token(payload);
$$;
create or replace function public.push_state() returns jsonb
language sql security invoker set search_path = '' as $$ select private.push_state(); $$;

revoke all on function private.retire_push_token(bigint, text), private.enqueue_push(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.register_push_token(jsonb), private.unregister_push_token(jsonb), private.push_state(),
  public.register_push_token(jsonb), public.unregister_push_token(jsonb), public.push_state() from public, anon, authenticated;
grant execute on function private.register_push_token(jsonb), private.unregister_push_token(jsonb), private.push_state(),
  public.register_push_token(jsonb), public.unregister_push_token(jsonb), public.push_state() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Sender side (service role only).
/** Claims queued pushes with the active tokens of their recipients. A push older than 24 hours is no longer sent. */
create or replace function public.push_claim(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  update private.push_outbox set status = 'expired'
   where status in ('pending', 'sending') and created_at < now() - interval '24 hours';
  with claimed as (
    update private.push_outbox o
       set status = 'sending', attempts = attempts + 1, claimed_at = now()
     where o.id in (
       select id from private.push_outbox
        where status = 'pending'
           or (status = 'sending' and claimed_at < now() - interval '10 minutes')
        order by created_at
        limit greatest(1, least(coalesce(p_limit, 50), 200))
        for update skip locked)
    returning o.id, o.user_id, o.template, o.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'template', c.template, 'attempts', c.attempts,
           'tokens', (select coalesce(jsonb_agg(jsonb_build_object('token', t.token, 'platform', t.platform)), '[]'::jsonb)
                        from private.push_tokens t where t.user_id = c.user_id and t.disabled_at is null))), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end;
$$;

/** Result of one delivery attempt. p_outcome: sent | skipped (no usable token) | retry (transient failure). */
create or replace function public.push_mark(p_id bigint, p_outcome text, p_error text default null, p_dead_tokens text[] default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_token_id bigint;
begin
  if p_outcome not in ('sent', 'skipped', 'retry') then
    raise exception 'push_mark: unknown outcome %', p_outcome;
  end if;
  select user_id into v_user from private.push_outbox where id = p_id;
  if not found then
    return;
  end if;
  -- Tokens the push service reported as gone are retired, but only tokens of this row's recipient.
  for v_token_id in
    select id from private.push_tokens
     where user_id = v_user and disabled_at is null and token = any (coalesce(p_dead_tokens, '{}'))
  loop
    perform private.retire_push_token(v_token_id, 'unregistered');
  end loop;
  update private.push_outbox
     set status = case when p_outcome = 'sent' then 'sent'
                       when p_outcome = 'skipped' then 'skipped'
                       when attempts >= 5 then 'failed'
                       else 'pending' end,
         sent_at = case when p_outcome = 'sent' then now() else sent_at end,
         last_error = case when p_outcome = 'sent' then null else left(p_error, 500) end
   where id = p_id;
end;
$$;

revoke all on function public.push_claim(integer), public.push_mark(bigint, text, text, text[]) from public, anon, authenticated;
grant execute on function public.push_claim(integer), public.push_mark(bigint, text, text, text[]) to service_role;

-- Cron: every minute, only while something is queued (same token header as the e-mail sender).
select cron.unschedule('faseela-send-push') where exists (select 1 from cron.job where jobname = 'faseela-send-push');
select cron.schedule('faseela-send-push', '* * * * *', $job$
  select net.http_post(
    url := 'https://riyvlhlhzxxerlwqoxsy.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-outbox-token', (select decrypted_secret from vault.decrypted_secrets where name = 'outbox_token' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
   where exists (select 1 from private.push_outbox
                  where status = 'pending'
                     or (status = 'sending' and claimed_at < now() - interval '10 minutes'));
$job$);
