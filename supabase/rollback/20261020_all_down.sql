-- DOWN for migrations 20261020000100 … 20261020000500 (reverse order). DESTROYS ALL FASEELA DATA.
-- Only for a dev/staging project or a failed first deployment. Never run on production data
-- without a verified backup (Dashboard → Database → Backups).
begin;

-- 0500 account deletion
drop function if exists public.delete_my_account(jsonb);
drop function if exists private.delete_my_account(jsonb);

-- 0420 jobs
select cron.unschedule(jobname) from cron.job
 where jobname in ('faseela-expire-reservations', 'faseela-flag-overdue-reviews');

-- 0410 storage (objects first; buckets must be empty)
drop policy if exists payment_proofs_insert on storage.objects;
drop policy if exists payment_proofs_select on storage.objects;
drop policy if exists field_media_insert on storage.objects;
drop policy if exists field_media_select on storage.objects;
delete from storage.objects where bucket_id in ('payment-proofs', 'field-media');
delete from storage.buckets where id in ('payment-proofs', 'field-media');

-- 0400 api surface
drop function if exists public.ensure_profile(jsonb), public.submit_role_application(jsonb),
  public.review_role_application(jsonb), public.create_investment_request(jsonb),
  public.cancel_investment_request(jsonb), public.submit_investment_payment_proof(jsonb),
  public.review_investment_request(jsonb), public.submit_farmer_update(jsonb), public.review_farmer_update(jsonb),
  public.submit_pressing_batch(jsonb), public.certify_pressing_batch(jsonb), public.list_review_queue(jsonb),
  public.admin_list_users(jsonb), public.export_my_data(jsonb);

-- 0100–0305: trigger, tables, private schema (functions are dropped with the schema)
drop trigger if exists on_auth_user_created on auth.users;
alter publication supabase_realtime drop table
  public.investment_requests, public.transactions, public.shares, public.role_applications,
  public.farmer_updates, public.pressing_batches, public.trees_public;
drop table if exists public.audit_logs, public.pressing_batches, public.farmer_updates, public.mill_assignments,
  public.farmer_assignments, public.shares, public.transactions, public.investment_requests,
  public.tree_events_public, private.trees, public.trees_public, public.role_applications, public.profiles cascade;
drop schema if exists private cascade;

commit;
