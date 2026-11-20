-- Faseela (migration 34): token format fix for migration 33. PostgreSQL regular expressions allow a repetition
-- count of at most 255, so '{20,4096}' was rejected at run time (found by the push test suite before any token was
-- stored). Length is now checked with char_length; the character class stays the same.
alter table private.push_tokens drop constraint if exists push_tokens_token_check;
alter table private.push_tokens add constraint push_tokens_token_check
  check (token ~ '^(x:[0-9]+|[A-Za-z0-9_:.-]+)$' and char_length(token) <= 4096 and (token like 'x:%' or char_length(token) >= 20));

/** Validated device token from a request payload (20..4096 chars, never a tombstone). */
create or replace function private.push_token_arg(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_token text := private.req_id(p, 'token', '^[A-Za-z0-9_:.-]+$');
begin
  if char_length(v_token) < 20 or char_length(v_token) > 4096 or v_token like 'x:%' then
    perform private.fail('invalid-argument', 'Field token is invalid.');
  end if;
  return v_token;
end;
$$;
revoke all on function private.push_token_arg(jsonb) from public, anon;
grant execute on function private.push_token_arg(jsonb) to authenticated;

create or replace function private.register_push_token(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_token text := private.push_token_arg(p);
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
  for v_extra in
    select id from private.push_tokens where user_id = v_uid and disabled_at is null order by last_seen_at desc, id desc offset 10
  loop
    perform private.retire_push_token(v_extra, 'cap');
  end loop;
  select count(*) into v_active from private.push_tokens where user_id = v_uid and disabled_at is null;
  return jsonb_build_object('registered', true, 'activeDevices', v_active);
end;
$$;

create or replace function private.unregister_push_token(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_token text := private.push_token_arg(coalesce(payload, '{}'::jsonb));
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
