-- Faseela receiving accounts by country (migration 20261121000400). One transaction, always rolls back via the final RAISE.
-- An account limited to countries is returned only for those countries; an account without a list for every country.
do $t$
declare
  c_i constant uuid := 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4'; -- signed-in sponsor
  v_j jsonb;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.as_anon() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','{"role":"anon"}',true); perform set_config('role','anon',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;
  create function pg_temp.accounts(p jsonb) returns text language sql as $f$
    select coalesce(string_agg(ch ->> 'account', ',' order by ord), '') from jsonb_array_elements(coalesce(p -> 'channels', '[]'::jsonb)) with ordinality as e(ch, ord) $f$;

  -- ---------------------------------------------------------------- setup
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', c_i, 'authenticated', 'authenticated', 'pc@t.faseela.invalid', '', now(), '{}'::jsonb,
          jsonb_build_object('display_name', 'Country Sponsor', 'requested_role', 'investor'), now(), now());
  delete from private.app_settings where key = 'payment_instructions';
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('unconfigured: null, not an error', public.payment_instructions_for('SY') is null);

  -- Stored through the same cleaner the admin path uses, so the shape is the real one.
  perform pg_temp.as_pg();
  insert into private.app_settings (key, value, updated_at)
  values ('payment_instructions', private.clean_payment_instructions(jsonb_build_object(
    'channels', jsonb_build_array(
      jsonb_build_object('id', 'bank_iban', 'titleAr', 'بنك عام', 'titleEn', 'Bank all', 'account', 'ALL 0001'),
      jsonb_build_object('id', 'bank_iban', 'titleAr', 'بنك إسبانيا', 'titleEn', 'Bank Spain', 'account', 'ES 0002', 'countries', jsonb_build_array('ES')),
      jsonb_build_object('id', 'syriatel_cash', 'titleAr', 'سيريتل', 'titleEn', 'Syriatel', 'account', 'SY 0003', 'countries', jsonb_build_array('SY')),
      jsonb_build_object('id', 'other', 'titleAr', 'فارغ', 'titleEn', 'Empty list', 'account', 'EMPTY 0004', 'countries', jsonb_build_array())),
    'noteEn', 'Keep the receipt')), now());
  perform pg_temp.chk('cleaner keeps the ES limit', (select value -> 'channels' -> 1 -> 'countries' from private.app_settings where key = 'payment_instructions') = '["ES"]'::jsonb);

  -- ---------------------------------------------------------------- filtering
  perform pg_temp.as_user(c_i);
  v_j := public.payment_instructions_for('SY');
  perform pg_temp.chk('SY: account limited to ES is not returned', pg_temp.accounts(v_j) = 'ALL 0001,SY 0003,EMPTY 0004', v_j::text);
  perform pg_temp.chk('SY: note, country and updatedAt kept', (v_j->>'noteEn') = 'Keep the receipt' and (v_j->>'country') = 'SY' and jsonb_typeof(v_j->'updatedAt') = 'number', v_j::text);
  perform pg_temp.as_user(c_i);
  v_j := public.payment_instructions_for('ES');
  perform pg_temp.chk('ES: account limited to SY is not returned', pg_temp.accounts(v_j) = 'ALL 0001,ES 0002,EMPTY 0004', v_j::text);
  perform pg_temp.as_user(c_i);
  v_j := public.payment_instructions_for(' es ');
  perform pg_temp.chk('code is normalised', pg_temp.accounts(v_j) = 'ALL 0001,ES 0002,EMPTY 0004' and (v_j->>'country') = 'ES', v_j::text);
  perform pg_temp.as_user(c_i);
  v_j := public.payment_instructions_for('IT');
  perform pg_temp.chk('other country: only unlimited accounts', pg_temp.accounts(v_j) = 'ALL 0001,EMPTY 0004', v_j::text);
  perform pg_temp.as_pg();
  perform pg_temp.chk('same counts as payment_channels_for (activation gate)',
    private.payment_channels_for('SY') = 3 and private.payment_channels_for('ES') = 3 and private.payment_channels_for('IT') = 2,
    format('SY=%s ES=%s IT=%s', private.payment_channels_for('SY'), private.payment_channels_for('ES'), private.payment_channels_for('IT')));
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('invalid code rejected', pg_temp.try('select public.payment_instructions_for(''SYR'')') = 'invalid-argument');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('missing code rejected', pg_temp.try('select public.payment_instructions_for(null)') = 'invalid-argument');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('legacy payment_instructions() unchanged: all accounts', pg_temp.accounts(public.payment_instructions()) = 'ALL 0001,ES 0002,SY 0003,EMPTY 0004');

  -- ---------------------------------------------------------------- access
  perform pg_temp.as_anon();
  perform pg_temp.chk('anon blocked', pg_temp.try('select public.payment_instructions_for(''SY'')') <> 'OK');
  perform pg_temp.as_pg();
  perform pg_temp.chk('wrapper is security invoker', (select not p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'payment_instructions_for'));
  perform pg_temp.chk('definer pins search_path', (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'payment_instructions_for'),
    (select array_to_string(p.proconfig, ';') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'payment_instructions_for'));
  perform pg_temp.chk('anon has no execute right', not has_function_privilege('anon', 'public.payment_instructions_for(text)', 'execute'));
  perform pg_temp.chk('shares the payment_instructions rate limit', (select count(*) from private.rate_limits where bucket = 'payment_instructions') >= 1);

  perform pg_temp.as_pg();
  raise exception using errcode = 'P0002', message = (select format('TEST SUMMARY passed=%s failed=%s %s', count(*) filter (where ok), count(*) filter (where not ok), coalesce(string_agg(name, ' | ') filter (where not ok), '')) from t_chk);
end $t$;
