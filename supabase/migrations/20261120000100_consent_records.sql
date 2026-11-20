-- Faseela (migration 51): consent is recorded on the server.
--
-- Until now a user ticked a box in the browser and nothing was stored: there was no proof of what anyone agreed to,
-- or when. From now on:
--  * private.consent_records holds one row per person, document and document version (who, which document, which
--    version, when, where: at sign-up or at checkout). Rows are never updated; a new version is a new row.
--  * The current version of each document lives in private.app_settings('consent_versions'), e.g.
--    {"privacy": "2026-11-17", "sponsorship": "2026-11-17"}. Changing a version (when the text changes) makes every
--    user agree again before the next sponsorship.
--  * Sign-up: the client sends the accepted documents in the sign-up metadata ("consents": [{"kind","version"}]);
--    the existing trigger private.handle_new_user records them, but only for known kinds and the CURRENT version.
--  * Checkout: public.record_consent(payload) records an acceptance of the signed-in user; a sponsorship
--    (public.create_investment_request) is refused with 'consent-required' unless the current versions of the
--    sponsorship description and the privacy policy were accepted (fail-closed).
-- Documents: privacy = public/legal/datenschutz.html, sponsorship = public/legal/patenschaft.html (description of the
-- sponsorship service; it is not a set of general terms). [PLATZHALTER: AGB und Widerrufsbelehrung vom Anwalt;
-- dann neue Dokumentart bzw. neue Version anlegen. Aufbewahrungsdauer der Nachweise nach Kontolöschung klären.]
--
-- Rollback: restore public.create_investment_request, private.handle_new_user and private.export_my_data from
--   migrations 46, 2 and 50 (previous definitions), drop function public.record_consent(jsonb), public.my_consents(), private.record_consent(jsonb),
--   private.my_consents(), private.assert_consents(uuid, text[]), private.consent_version(text); drop table
--   private.consent_records; delete the app_settings row 'consent_versions'.

create table if not exists private.consent_records (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('privacy', 'sponsorship')),
  version text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  source text not null check (source in ('signup', 'checkout', 'profile')),
  accepted_at timestamptz not null default now(),
  constraint consent_records_once unique (user_id, kind, version)
);
create index if not exists consent_records_user_idx on private.consent_records (user_id);
alter table private.consent_records enable row level security;
revoke all on private.consent_records from public, anon, authenticated;

insert into private.app_settings (key, value)
values ('consent_versions', '{"privacy": "2026-11-17", "sponsorship": "2026-11-17"}'::jsonb)
on conflict (key) do nothing;

/** Current version of a document, or null for an unknown kind. */
create or replace function private.consent_version(p_kind text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.value ->> p_kind from private.app_settings s
   where s.key = 'consent_versions' and (s.value ->> p_kind) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
$$;

/** Fails with 'consent-required' unless the user accepted the current version of every listed document. */
create or replace function private.assert_consents(p_uid uuid, p_kinds text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  foreach v_kind in array p_kinds loop
    if private.consent_version(v_kind) is null
       or not exists (select 1 from private.consent_records r
                       where r.user_id = p_uid and r.kind = v_kind and r.version = private.consent_version(v_kind)) then
      perform private.fail('consent-required', 'Please read and accept the current sponsorship description and privacy policy.');
    end if;
  end loop;
end;
$$;

create or replace function private.record_consent(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_kind text := private.req_id(p, 'kind', '^(privacy|sponsorship)$');
  v_version text := private.req_id(p, 'version', '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
  v_source text := coalesce(private.opt_text(p, 'source', 20), 'checkout');
  v_current text := private.consent_version(v_kind);
begin
  if v_source not in ('checkout', 'profile') then
    perform private.fail('invalid-argument', 'Field source is invalid.');
  end if;
  -- The page the user read must be the one in force; an outdated page in a cached app is not accepted.
  if v_current is null or v_version <> v_current then
    perform private.fail('consent-outdated', 'This document has been updated. Please reload the page and read the current version.');
  end if;
  insert into private.consent_records (user_id, kind, version, source)
  values (v_uid, v_kind, v_version, v_source)
  on conflict on constraint consent_records_once do nothing;
  return jsonb_build_object('kind', v_kind, 'version', v_version, 'recorded', true);
end;
$$;

/** What the signed-in user agreed to, for the data export and the profile. */
create or replace function private.my_consents()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('current', coalesce((select value from private.app_settings where key = 'consent_versions'), '{}'::jsonb),
    'accepted', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'version', r.version, 'source', r.source,
        'acceptedAt', private.epoch_ms(r.accepted_at)) order by r.accepted_at, r.id)
      from private.consent_records r where r.user_id = private.require_user()), '[]'::jsonb));
$$;

-- Sign-up: record what the person ticked in the registration form. Only known kinds in their current version count.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role text := meta ->> 'requested_role';
  v_consent jsonb;
begin
  insert into public.profiles (id, email, display_name, phone, region, requested_role)
  values (
    new.id,
    new.email,
    left(btrim(coalesce(meta ->> 'display_name', meta ->> 'full_name', meta ->> 'name', '')), 120),
    left(btrim(coalesce(meta ->> 'phone', '')), 40),
    left(btrim(coalesce(meta ->> 'region', '')), 120),
    case when v_role in ('farmer', 'mill_operator') then v_role else 'investor' end
  )
  on conflict (id) do nothing;

  if jsonb_typeof(meta -> 'consents') = 'array' then
    for v_consent in select value from jsonb_array_elements(meta -> 'consents') limit 5 loop
      if jsonb_typeof(v_consent) = 'object'
         and v_consent ->> 'kind' in ('privacy', 'sponsorship')
         and v_consent ->> 'version' = private.consent_version(v_consent ->> 'kind') then
        insert into private.consent_records (user_id, kind, version, source)
        values (new.id, v_consent ->> 'kind', v_consent ->> 'version', 'signup')
        on conflict on constraint consent_records_once do nothing;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

-- Data export (right of access): includes the person's consent records.
-- (Full redefinition of the function from migration 50; only the 'consents' entry is new.)
create or replace function private.export_my_data(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.audit(v_uid, 'account.exported', 'profiles/' || v_uid, '{}'::jsonb);
  return jsonb_build_object(
    'exportedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'format', 'faseela-data-export/v2',
    'role', private.current_app_role(),
    'profile', (select to_jsonb(pr) from public.profiles pr where pr.id = v_uid),
    'roleApplication', (select to_jsonb(ra) from public.role_applications ra where ra.user_id = v_uid),
    'investmentRequests', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.investment_requests x where x.user_id = v_uid), '[]'::jsonb),
    'transactions', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.transactions x where x.user_id = v_uid), '[]'::jsonb),
    'shares', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.shares x where x.user_id = v_uid), '[]'::jsonb),
    'farmerUpdates', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.farmer_updates x where x.farmer_uid = v_uid), '[]'::jsonb),
    'pressingBatches', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.pressing_batches x where x.submitted_by_uid = v_uid), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(private.order_summary(o) || jsonb_build_object('deliveryContact',
        (select extensions.pgp_sym_decrypt(c.contact_enc, private.pii_key())::jsonb from private.order_contacts c where c.order_id = o.id))
        order by o.created_at) from public.orders o where o.user_id = v_uid), '[]'::jsonb),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'version', r.version, 'source', r.source,
        'acceptedAt', private.epoch_ms(r.accepted_at)) order by r.accepted_at, r.id)
      from private.consent_records r where r.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

-- A sponsorship needs the current sponsorship description and privacy policy accepted.
create or replace function public.create_investment_request(payload jsonb)
returns jsonb
language sql
set search_path = ''
as $$
  select private.assert_land_offer(payload, 'includesLand');
  select private.assert_consents((select auth.uid()), array['sponsorship', 'privacy']);
  select private.create_investment_request(payload);
$$;

create or replace function public.record_consent(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('record_consent', 30, 3600); select private.record_consent(payload); $$;
create or replace function public.my_consents() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('order_read', 120, 60); select private.my_consents(); $$;

revoke all on function private.consent_version(text), private.assert_consents(uuid, text[]), private.record_consent(jsonb),
  private.my_consents(), public.record_consent(jsonb), public.my_consents(),
  public.create_investment_request(jsonb) from public, anon, authenticated;
grant execute on function private.consent_version(text), private.assert_consents(uuid, text[]), private.record_consent(jsonb),
  private.my_consents(), public.record_consent(jsonb), public.my_consents(), public.create_investment_request(jsonb) to authenticated;
-- Visitors read which versions are in force (through the definer helper; app_settings stays closed).
create or replace function public.consent_versions() returns jsonb
language sql security invoker set search_path = '' as $$ select jsonb_build_object('privacy', private.consent_version('privacy'), 'sponsorship', private.consent_version('sponsorship')); $$;
grant execute on function public.consent_versions() to anon, authenticated;
grant execute on function private.consent_version(text) to anon;
