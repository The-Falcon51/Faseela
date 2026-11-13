-- Anonymous clients must be able to reach the single anon-facing entry point
-- public.report_client_error (SECURITY INVOKER wrapper) -> private.report_client_error (SECURITY DEFINER).
-- The invoker wrapper resolves the private function under the caller's privileges, which requires
-- USAGE on schema private. USAGE only allows name resolution: every table and every other function in
-- private stays revoked for anon (deny-by-default, re-asserted below), so the blast radius is nil.
grant usage on schema private to anon;

-- Re-assert deny-by-default on everything in private, then re-open the one allowed function.
-- NOTE: functions carry an implicit EXECUTE grant to PUBLIC when created; revoking only from anon would
-- leave that in place (enqueue_email/notify_*/ops_check were affected) -> always revoke from public too.
-- The notify_* helpers are only called from SECURITY DEFINER RPCs (owner postgres) and pg_cron, so no
-- role needs a direct grant.
revoke all on all tables in schema private from public, anon;
revoke all on all sequences in schema private from public, anon;
revoke all on all functions in schema private from public, anon;
grant execute on function private.report_client_error(jsonb) to anon;

-- Future objects created by the migration role in private start closed for anon/public as well.
alter default privileges in schema private revoke execute on functions from public, anon;
alter default privileges in schema private revoke all on tables from public, anon;
alter default privileges in schema private revoke all on sequences from public, anon;
