-- 1) Profile self-service (name/phone/region) — until now edits stayed in the browser only.
-- 2) Marketing consent (versioned, revocable) + onboarding sequence (day 1/3/7) for users who opted in
--    and have not reserved anything yet. Marketing mail without consent is not sent (UWG §7 / DSGVO Art. 6).
-- 3) Coarse public status for the status page (anon). Exposes only ok/degraded flags, never counts.

alter table public.profiles
  add column if not exists marketing_opt_in boolean not null default false,
  add column if not exists marketing_opt_in_at timestamptz,
  add column if not exists marketing_consent_version text;

create index if not exists profiles_onboarding_idx on public.profiles (created_at) where marketing_opt_in;

-- ---------------------------------------------------------------------------
-- update_my_profile
-- ---------------------------------------------------------------------------
create or replace function private.update_my_profile(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_display text := btrim(private.opt_text(p, 'displayName', 120));
  v_phone text := btrim(coalesce(private.opt_text(p, 'phone', 40), ''));
  v_region text := btrim(coalesce(private.opt_text(p, 'region', 120), ''));
  v_profile public.profiles;
begin
  if v_display is null or char_length(v_display) < 3 then
    perform private.fail('invalid-argument', 'Display name must have at least 3 characters.');
  end if;
  if v_phone <> '' and v_phone !~ '^\+?[0-9 ()-]{6,40}$' then
    perform private.fail('invalid-argument', 'Phone number format is invalid.');
  end if;

  update public.profiles
     set display_name = v_display, phone = v_phone, region = v_region, updated_at = now()
   where id = v_uid
  returning * into v_profile;
  if not found then
    perform private.fail('failed-precondition', 'Profile does not exist yet.');
  end if;
  perform private.audit(v_uid, 'profile.updated', v_uid::text, jsonb_build_object('fields', array['displayName', 'phone', 'region']));

  return jsonb_build_object('displayName', v_profile.display_name, 'phone', v_profile.phone, 'region', v_profile.region,
    'marketingOptIn', v_profile.marketing_opt_in);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_marketing_consent: {optIn: boolean, version?: text}
-- ---------------------------------------------------------------------------
create or replace function private.set_marketing_consent(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_opt_in boolean;
  v_version text := coalesce(private.opt_text(p, 'version', 40), 'marketing-v1');
begin
  if coalesce(jsonb_typeof(p->'optIn'), 'missing') <> 'boolean' then
    perform private.fail('invalid-argument', 'optIn must be a boolean.');
  end if;
  v_opt_in := (p->>'optIn')::boolean;

  update public.profiles
     set marketing_opt_in = v_opt_in,
         marketing_opt_in_at = case when v_opt_in then now() else marketing_opt_in_at end,
         marketing_consent_version = case when v_opt_in then v_version else marketing_consent_version end,
         updated_at = now()
   where id = v_uid;
  if not found then
    perform private.fail('failed-precondition', 'Profile does not exist yet.');
  end if;
  perform private.audit(v_uid, case when v_opt_in then 'consent.marketing.granted' else 'consent.marketing.revoked' end,
    v_uid::text, jsonb_build_object('version', v_version));
  return jsonb_build_object('marketingOptIn', v_opt_in, 'version', v_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Onboarding sequence (daily job). One mail per step and recipient, never twice.
-- Eligible: opted in, e-mail confirmed, not banned, no share and no open/approved request.
-- ---------------------------------------------------------------------------
create or replace function private.send_onboarding()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    select pr.id, u.email, s.template
      from public.profiles pr
      join auth.users u on u.id = pr.id
      cross join lateral (values ('onboarding_one', interval '1 day'), ('onboarding_three', interval '3 days'),
                                 ('onboarding_seven', interval '7 days')) as s(template, after)
     where pr.marketing_opt_in
       and u.email_confirmed_at is not null and u.deleted_at is null and u.banned_until is null
       and pr.created_at <= now() - s.after
       and pr.created_at > now() - interval '30 days'
       and not exists (select 1 from public.shares sh where sh.user_id = pr.id)
       and not exists (select 1 from public.investment_requests r where r.user_id = pr.id
                          and r.status in ('awaiting_payment', 'under_review', 'approved'))
       and not exists (select 1 from private.email_outbox o where o.recipient = u.email and o.template = s.template)
  loop
    perform private.enqueue_email(v_row.email, v_row.template, jsonb_build_object('marketing', true));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'faseela-onboarding';
select cron.schedule('faseela-onboarding', '40 8 * * *', $$select private.send_onboarding()$$);

-- ---------------------------------------------------------------------------
-- public_status: coarse flags for /status.html (anon). No counts, no error texts.
-- ---------------------------------------------------------------------------
create or replace function private.public_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs_ok boolean;
  v_mail_ok boolean;
  v_last_check timestamptz;
begin
  select coalesce(bool_and(d.status = 'succeeded'), true) into v_jobs_ok
    from (select distinct on (j.jobid) j.jobname, d.status
            from cron.job j join cron.job_run_details d on d.jobid = j.jobid
           where j.jobname like 'faseela-%' and j.jobname <> 'faseela-send-emails'
           order by j.jobid, d.start_time desc) d;
  select not exists (select 1 from private.email_outbox where status = 'failed' and created_at > now() - interval '24 hours')
    into v_mail_ok;
  select max(d.start_time) into v_last_check
    from cron.job j join cron.job_run_details d on d.jobid = j.jobid where j.jobname = 'faseela-ops-check';
  return jsonb_build_object(
    'api', 'ok',
    'jobs', case when v_jobs_ok then 'ok' else 'degraded' end,
    'email', case when v_mail_ok then 'ok' else 'degraded' end,
    'checkedAt', private.epoch_ms(coalesce(v_last_check, now()))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- API surface + privileges (deny-by-default, same pattern as 20261020000400)
-- ---------------------------------------------------------------------------
create or replace function public.update_my_profile(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.update_my_profile(payload); $$;
create or replace function public.set_marketing_consent(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.set_marketing_consent(payload); $$;
create or replace function public.public_status() returns jsonb
language sql security invoker set search_path = '' as $$ select private.public_status(); $$;

revoke all on function private.update_my_profile(jsonb), private.set_marketing_consent(jsonb), private.public_status(),
  private.send_onboarding() from public, anon, authenticated;
revoke all on function public.update_my_profile(jsonb), public.set_marketing_consent(jsonb), public.public_status()
  from public, anon, authenticated;
grant execute on function private.update_my_profile(jsonb), private.set_marketing_consent(jsonb),
  public.update_my_profile(jsonb), public.set_marketing_consent(jsonb) to authenticated;
grant execute on function private.public_status(), public.public_status() to anon, authenticated;
