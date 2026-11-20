-- MANUAL (SQL editor): the live project created pg_net in schema public before 20261026000200 was
-- corrected. pg_net is not relocatable, so it has to be dropped and re-created in `extensions`.
-- Safe: the cron job `faseela-send-emails` references net.http_post(...) only at run time; the `net`
-- schema with its functions is re-created by the extension. No data lives in pg_net.
-- Destructive statements are not applied through the MCP path on purpose.
drop extension if exists pg_net;
create extension pg_net with schema extensions;
