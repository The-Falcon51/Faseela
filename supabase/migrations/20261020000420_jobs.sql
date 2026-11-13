-- Scheduled jobs (replaces the two onSchedule Cloud Functions). cron.schedule(name, ...) upserts by name.
create extension if not exists pg_cron;

select cron.schedule('faseela-expire-reservations', '*/10 * * * *', $$select private.expire_investment_requests()$$);
select cron.schedule('faseela-flag-overdue-reviews', '7 */6 * * *', $$select private.flag_overdue_reviews()$$);
