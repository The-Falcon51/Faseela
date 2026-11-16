-- Minimal stand-ins for the parts of a Supabase project that the Faseela migrations and SQL suites rely on:
-- roles, auth.*, storage.*, cron.*, vault.*, net.* and the extensions schema. They exist only so that
-- supabase/migrations and supabase/tests can run on a plain PostgreSQL (CI, local). This is NOT Supabase:
-- no GoTrue, no storage API, no scheduler, no HTTP. Applied by scripts/local-db.cjs to a throwaway database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator noinherit login; end if;
end
$$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to current_user;
create schema extensions; create extension pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create schema auth; grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
create table auth.users (instance_id uuid, id uuid primary key default gen_random_uuid(), aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, phone text, phone_confirmed_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}',
  is_super_admin boolean, created_at timestamptz default now(), updated_at timestamptz default now(), banned_until timestamptz, deleted_at timestamptz, is_anonymous boolean default false, is_sso_user boolean default false);
create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users on delete cascade, provider text, identity_data jsonb, created_at timestamptz default now());
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users on delete cascade, created_at timestamptz default now());
create table auth.refresh_tokens (id bigserial primary key, user_id text, session_id uuid, revoked boolean default false);
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users on delete cascade, status text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
create function auth.email() returns text language sql stable as $$ select auth.jwt() ->> 'email' $$;
grant select on auth.users to supabase_auth_admin;
create schema storage; grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, owner uuid, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text, owner uuid, owner_id text, metadata jsonb, user_metadata jsonb, is_delete_marker boolean default false, version text,
  created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), path_tokens text[] generated always as (string_to_array(name, '/')) stored, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role; grant select on storage.buckets to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
create function storage.filename(name text) returns text language sql immutable as $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
create function storage.protect_delete() returns trigger language plpgsql as $$ begin return old; end $$;
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, nodename text, nodeport int, database text, username text, active boolean default true);
create table cron.job_run_details (jobid bigint, runid bigserial primary key, job_pid int, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$ declare v bigint; begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $$ begin delete from cron.job where jobname = job_name; return found; end $$;
create function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null) returns void language plpgsql as $$ begin
  update cron.job j set schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command), active = coalesce(alter_job.active, j.active) where jobid = job_id; end $$;
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text, created_at timestamptz default now(), updated_at timestamptz default now());
create view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language plpgsql as $$ declare v uuid; begin
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id into v; return v; end $$;
create schema net;
create table net.sent (id bigserial primary key, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language plpgsql as $$ declare v bigint; begin
  insert into net.sent (url, body, headers) values (url, body, headers) returning id into v; return v; end $$;
do $$ begin if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;
create function cron.unschedule(job_id bigint) returns boolean language plpgsql as $$ begin delete from cron.job where jobid = job_id; return found; end $$;
