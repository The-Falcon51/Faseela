-- Faseela (migration 43): launch hardening.
--  a) A reservation now waits 48 hours for the transfer receipt (was 30 minutes — too short for a bank transfer).
--  b) Second factor: an account that has set up an authenticator app must present it before any role-checked
--     function works. Accounts without a factor are unchanged, so nobody is locked out by this migration.
--  c) Two more automation rule entries (both off). The function that executes them (run_housekeeping) is NOT part
--     of this migration: it needs the account owner's confirmation and is applied separately.

-- a) The live function is rewritten in place, so every later change to it is kept.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'create_investment_request';
  if v_def like '%interval ''30 minutes''%' then
    execute replace(v_def, 'interval ''30 minutes''', 'interval ''48 hours''');
  end if;
end;
$$;

-- b)
create or replace function private.require_role(roles text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not private.has_any_role(roles) then
    perform private.fail('permission-denied', 'This operation is not permitted for this account.');
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2'
     and exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified') then
    perform private.fail('mfa-required', 'Confirm the second factor to continue.');
  end if;
  return v_uid;
end;
$$;

-- c)
alter table private.automation_rules drop constraint if exists automation_rules_key_check;
alter table private.automation_rules add constraint automation_rules_key_check
  check (key in ('review_reminder', 'sold_out_unlist', 'purge_unconfirmed', 'weekly_digest'));
insert into private.automation_rules (key, config) values ('purge_unconfirmed', '{"days":30}'), ('weekly_digest', '{}')
on conflict (key) do nothing;

create or replace function private.admin_set_automation_rule(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_key text := private.req_id(p, 'key', '^(review_reminder|sold_out_unlist|purge_unconfirmed|weekly_digest)$');
  v_days integer := private.opt_int(p, 'days', case when v_key = 'purge_unconfirmed' then 7 else 1 end, 90)::integer;
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

