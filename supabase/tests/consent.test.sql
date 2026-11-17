-- Faseela consent suite (migration 51). One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_new constant uuid := '5c000000-0000-4000-8000-0000000000a1'; -- signs up with consents in the metadata
  c_old constant uuid := '5c000000-0000-4000-8000-0000000000b1'; -- signs up without any
  c_oth constant uuid := '5c000000-0000-4000-8000-0000000000c1'; -- malformed metadata
  c_buy constant text := $q$select public.create_investment_request('{"treeId":"tree_01","shareCount":1,"idempotencyKey":"consent-key-0001"}')$q$;
  v_privacy text := private.consent_version('privacy');
  v_spons text := private.consent_version('sponsorship');
  v_j jsonb; v_n integer;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_anon() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true); perform set_config('role','anon',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;
  create function pg_temp.call_as(p uuid, p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_user(p); return pg_temp.try(p_sql); end $f$;
  create function pg_temp.cnt(p_sql text) returns integer language plpgsql as $f$
  declare n integer; begin execute p_sql into n; return n; end $f$;
  create function pg_temp.anon_try(p_sql text) returns text language plpgsql as $f$
  begin perform pg_temp.as_anon(); return pg_temp.try(p_sql); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', c_new, 'authenticated', 'authenticated', 'cn@t.faseela.invalid', '', now(), '{}'::jsonb,
     jsonb_build_object('display_name', 'Consent New', 'consents', jsonb_build_array(jsonb_build_object('kind', 'privacy', 'version', v_privacy),
       jsonb_build_object('kind', 'sponsorship', 'version', '2001-01-01'), jsonb_build_object('kind', 'admin', 'version', v_privacy), 'junk')), now(), now()),
    ('00000000-0000-0000-0000-000000000000', c_old, 'authenticated', 'authenticated', 'co@t.faseela.invalid', '', now(), '{}'::jsonb,
     jsonb_build_object('display_name', 'Consent None'), now(), now()),
    ('00000000-0000-0000-0000-000000000000', c_oth, 'authenticated', 'authenticated', 'cx@t.faseela.invalid', '', now(), '{}'::jsonb,
     jsonb_build_object('display_name', 'Other Person', 'consents', 'not-an-array'), now(), now());
  delete from private.rate_limits;

  -- ---------------------------------------------------------------- sign-up
  perform pg_temp.chk('sign-up records the current privacy version only', (select count(*) from private.consent_records where user_id = c_new) = 1
    and exists (select 1 from private.consent_records where user_id = c_new and kind = 'privacy' and version = v_privacy and source = 'signup'));
  perform pg_temp.chk('outdated, unknown and malformed sign-up entries are ignored', not exists (select 1 from private.consent_records where user_id in (c_old, c_oth))
    and exists (select 1 from public.profiles where id = c_oth));

  -- ---------------------------------------------------------------- the purchase gate
  perform pg_temp.chk('no sponsorship without consent', pg_temp.call_as(c_old, c_buy) = 'consent-required');
  perform pg_temp.chk('privacy alone is not enough', pg_temp.call_as(c_new, c_buy) = 'consent-required');
  perform pg_temp.chk('outdated version refused', pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"sponsorship","version":"2001-01-01"}')$q$)) = 'consent-outdated');
  perform pg_temp.chk('unknown kind refused', pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"admin","version":"%s"}')$q$, v_privacy)) = 'invalid-argument');
  perform pg_temp.chk('client cannot claim a sign-up source', pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"privacy","version":"%s","source":"signup"}')$q$, v_privacy)) = 'invalid-argument');
  perform pg_temp.as_anon();
  perform pg_temp.chk('visitors read the versions in force', (public.consent_versions()->>'privacy') = v_privacy and (public.consent_versions()->>'sponsorship') = v_spons);
  perform pg_temp.chk('visitors cannot record consent', pg_temp.anon_try(format($q$select public.record_consent('{"kind":"privacy","version":"%s"}')$q$, v_privacy)) <> 'OK');
  perform pg_temp.chk('consent records are not readable or writable directly', pg_temp.call_as(c_old, $q$select count(*) from private.consent_records$q$) <> 'OK'
    and pg_temp.call_as(c_old, format($q$insert into private.consent_records (user_id, kind, version, source) values ('%s', 'sponsorship', '%s', 'checkout')$q$, c_old, v_spons)) <> 'OK');
  perform pg_temp.chk('customer records both documents at checkout', pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"sponsorship","version":"%s"}')$q$, v_spons)) = 'OK'
    and pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"privacy","version":"%s"}')$q$, v_privacy)) = 'OK'
    and pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"privacy","version":"%s"}')$q$, v_privacy)) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('each acceptance is stored once, attributed to the caller', (select count(*) from private.consent_records where user_id = c_old) = 2
    and not exists (select 1 from private.consent_records where user_id = c_oth));
  perform pg_temp.chk('with consent the sponsorship goes through', pg_temp.call_as(c_old, c_buy) = 'OK');
  perform pg_temp.as_user(c_old);
  v_j := public.my_consents();
  perform pg_temp.chk('the user sees what they accepted', jsonb_array_length(v_j->'accepted') = 2 and v_j#>>'{current,privacy}' = v_privacy, v_j::text);
  v_j := public.export_my_data('{}');
  perform pg_temp.chk('the data export lists the consents', jsonb_array_length(v_j->'consents') = 2, left((v_j->'consents')::text, 200));

  -- ---------------------------------------------------------------- a new version asks again
  perform pg_temp.as_pg();
  update private.app_settings set value = jsonb_set(value, '{sponsorship}', '"2099-01-01"') where key = 'consent_versions';
  perform pg_temp.chk('a changed document needs a new acceptance', pg_temp.call_as(c_old, replace(c_buy, 'consent-key-0001', 'consent-key-0002')) = 'consent-required');
  perform pg_temp.chk('the old page version is refused', pg_temp.call_as(c_old, format($q$select public.record_consent('{"kind":"sponsorship","version":"%s"}')$q$, v_spons)) = 'consent-outdated');
  perform pg_temp.chk('the new version is accepted', pg_temp.call_as(c_old, $q$select public.record_consent('{"kind":"sponsorship","version":"2099-01-01"}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('the earlier acceptance stays as proof', (select count(*) from private.consent_records where user_id = c_old and kind = 'sponsorship') = 2);
  perform pg_temp.chk('account deletion removes the person''s records', pg_temp.call_as(c_oth, $q$select public.delete_my_account('{"confirmation":"DELETE"}')$q$) = 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('nothing left of the deleted account', not exists (select 1 from private.consent_records where user_id = c_oth));

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
