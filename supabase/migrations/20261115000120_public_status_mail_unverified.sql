-- Faseela (migration 40): the public status reported e-mail as "ok" whenever nothing had failed in the last
-- 24 hours — also when no e-mail had ever been delivered (no provider connected yet). It now says "unverified"
-- until the first successful delivery, so "ok" always means "a mail really went out".
create or replace function private.public_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs_ok boolean;
  v_mail text;
  v_last_check timestamptz;
begin
  select coalesce(bool_and(d.status = 'succeeded'), true) into v_jobs_ok
    from (select distinct on (j.jobid) j.jobname, d.status
            from cron.job j join cron.job_run_details d on d.jobid = j.jobid
           where j.jobname like 'faseela-%' and j.jobname <> 'faseela-send-emails'
           order by j.jobid, d.start_time desc) d;
  v_mail := case
    when exists (select 1 from private.email_outbox where status = 'failed' and created_at > now() - interval '24 hours') then 'degraded'
    when not exists (select 1 from private.email_outbox where status = 'sent') then 'unverified'
    else 'ok' end;
  select max(d.start_time) into v_last_check
    from cron.job j join cron.job_run_details d on d.jobid = j.jobid where j.jobname = 'faseela-ops-check';
  return jsonb_build_object(
    'api', 'ok',
    'jobs', case when v_jobs_ok then 'ok' else 'degraded' end,
    'email', v_mail,
    'checkedAt', private.epoch_ms(coalesce(v_last_check, now()))
  );
end;
$$;
