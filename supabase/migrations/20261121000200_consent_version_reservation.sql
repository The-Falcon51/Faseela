-- Faseela: the sponsorship description changed, so its consent version moves to 2026-11-22.
--
-- What changed in the text (public/legal/patenschaft.html, all three languages): a reservation is held for
-- 48 hours, not 30 minutes (the server has used 48 hours since 20261116000120_launch_hardening.sql).
-- Effect: private.assert_consents refuses the next sponsorship of every account until the person has accepted
-- version 2026-11-22 (the checkout records it); earlier acceptances stay in private.consent_records as proof.
-- The privacy policy did not change and keeps its version.
--
-- Deploy together with the web app: CONSENT_VERSIONS.sponsorship in public/app.js and the data-version of
-- public/legal/patenschaft.html must carry the same value, otherwise the checkout stops with 'consent-outdated'.
--
-- Idempotent: a second run changes nothing, and a newer version that is already stored is never moved back.
-- Down: update private.app_settings set value = jsonb_set(value, '{sponsorship}', '"2026-11-17"'), updated_at = now()
--        where key = 'consent_versions';  (only together with the previous patenschaft.html and app.js)

update private.app_settings
   set value = jsonb_set(value, '{sponsorship}', '"2026-11-22"'::jsonb),
       updated_at = now()
 where key = 'consent_versions'
   and jsonb_typeof(value) = 'object'
   and coalesce(value ->> 'sponsorship', '') < '2026-11-22';

-- Fail loudly instead of leaving the checkout closed without a trace (the row comes from 20261120000100).
do $$
begin
  if coalesce(private.consent_version('sponsorship'), '') < '2026-11-22' then
    raise exception 'consent_versions.sponsorship was not set to 2026-11-22 (is the app_settings row missing?)';
  end if;
end;
$$;
