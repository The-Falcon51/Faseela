-- Retention for monitoring data (DSGVO data minimisation): error reports 14 days, delivered
-- mail metadata 90 days [PLATZHALTER: Löschfristen juristisch prüfen]. Applied separately because it
-- contains DELETE statements (needs an explicit confirmation in the SQL editor / agent).
create function private.prune_monitoring()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.client_errors where created_at < now() - interval '14 days';
  delete from private.email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
$$;

create or replace function private.ops_check()
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
  perform private.prune_monitoring();
  return jsonb_build_object('failedEmails', v_failed, 'clientErrorsLastHour', v_errors);
end;
$$;
