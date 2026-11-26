-- Faseela repair of stored receiving accounts (20261121000100). The applied version of clean_payment_instructions
-- wrote a separate element in front of every channel ({} or {"countries":[...]}); this suite seeds that live shape in
-- the current setting and in the pending proposal and checks the repaired result. One transaction, always rolls back.
do $t$
declare
  c_a constant uuid := '5e000000-0000-4000-8000-0000000000a1';
  v_j jsonb; v_n integer;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,400), '') end, coalesce(p_cond,false)); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', c_a, 'authenticated', 'authenticated', 'rp@t.faseela.invalid', '', now(), '{}'::jsonb, '{"display_name":"Repair Admin"}'::jsonb, now(), now());
  delete from public.countries where code = 'PL';

  -- The broken live shape: a limited bank channel (ES), an unlimited channel; the proposal limits a channel to PL and ES.
  insert into private.app_settings (key, value, updated_at, updated_by) values
    ('payment_instructions', '{"channels":[{"countries":["ES"]},{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"ES00 TEST 0001","hintAr":null,"hintEn":null},{},{"id":"other","titleAr":"آخر","titleEn":"Other","account":"X-123","hintAr":null,"hintEn":null}],"noteAr":null,"noteEn":null}'::jsonb, now(), c_a),
    ('payment_instructions_pending', jsonb_build_object('status', 'pending', 'proposedBy', c_a, 'value',
      '{"channels":[{},{"id":"other","titleAr":"آخر","titleEn":"Other","account":"X-123","hintAr":null,"hintEn":null},{"countries":["PL","ES"]},{"id":"syriatel_cash","titleAr":"سيريتل","titleEn":"Syriatel","account":"0999 000 000","hintAr":null,"hintEn":null}],"noteAr":null,"noteEn":null}'::jsonb), now(), c_a)
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  perform pg_temp.chk('broken shape counts the orphan before the repair', private.payment_channels_for('PL') = 3 and private.payment_channels_for('ES') = 4);
  v_n := private.repair_stored_payment_channels();
  perform pg_temp.chk('both settings repaired', v_n = 2, v_n::text);

  select value into v_j from private.app_settings where key = 'payment_instructions';
  perform pg_temp.chk('current: only channels with an id remain', jsonb_array_length(v_j -> 'channels') = 2
    and not exists (select 1 from jsonb_array_elements(v_j -> 'channels') ch where not (ch ? 'id')), v_j::text);
  perform pg_temp.chk('current: the limit is back on the bank channel', v_j #> '{channels,0}' = '{"id":"bank_iban","titleAr":"بنك","titleEn":"Bank","account":"ES00 TEST 0001","hintAr":null,"hintEn":null,"countries":["ES"]}'::jsonb, v_j::text);
  perform pg_temp.chk('current: the unlimited channel stays unlimited', v_j #>> '{channels,1,id}' = 'other' and not (v_j #> '{channels,1}' ? 'countries'), v_j::text);
  perform pg_temp.chk('current: notes untouched', v_j ? 'noteAr' and v_j ? 'noteEn');
  perform pg_temp.chk('counts follow the limit', private.payment_channels_for('ES') = 2 and private.payment_channels_for('SY') = 1 and private.payment_channels_for('PL') = 1,
    format('ES=%s SY=%s PL=%s', private.payment_channels_for('ES'), private.payment_channels_for('SY'), private.payment_channels_for('PL')));

  select value into v_j from private.app_settings where key = 'payment_instructions_pending';
  perform pg_temp.chk('pending: repaired under value.channels', jsonb_array_length(v_j #> '{value,channels}') = 2
    and v_j #>> '{value,channels,0,id}' = 'other' and not (v_j #> '{value,channels,0}' ? 'countries')
    and v_j #>> '{value,channels,1,id}' = 'syriatel_cash' and v_j #> '{value,channels,1,countries}' = '["PL","ES"]'::jsonb, v_j::text);
  perform pg_temp.chk('pending: status and proposer kept', v_j ->> 'status' = 'pending' and v_j ->> 'proposedBy' = c_a::text and not (v_j ? 'channels'), v_j::text);
  perform pg_temp.chk('unknown limit code becomes a planned country', exists (select 1 from public.countries
    where code = 'PL' and status = 'planned' and name = 'PL' and name_en = 'PL' and name_de = 'PL' and currency = 'USD'));
  perform pg_temp.chk('the repaired proposal can be saved again', jsonb_array_length(private.clean_payment_instructions(v_j -> 'value') -> 'channels') = 2);
  perform pg_temp.chk('running it again changes nothing', private.repair_stored_payment_channels() = 0);

  perform pg_temp.chk('helper: orphan merges into the next channel with an id', private.repair_payment_channels(
    '[{"countries":["ES"]},{"id":"a"},{"id":"b"}]'::jsonb) = '[{"id":"a","countries":["ES"]},{"id":"b"}]'::jsonb);
  perform pg_temp.chk('helper: a channel keeps its own limit', private.repair_payment_channels(
    '[{"countries":["ES"]},{"id":"a","countries":["SY"]}]'::jsonb) = '[{"id":"a","countries":["SY"]}]'::jsonb);
  perform pg_temp.chk('helper: a clean list is unchanged', private.repair_payment_channels('[{"id":"a"},{"id":"b","countries":["SY"]}]'::jsonb)
    = '[{"id":"a"},{"id":"b","countries":["SY"]}]'::jsonb);
  perform pg_temp.chk('helper: no list stays as it is', private.repair_payment_channels(null) is null and private.repair_payment_channels('{}'::jsonb) = '{}'::jsonb);
  perform pg_temp.chk('helpers are not callable by API roles', not has_function_privilege('authenticated', 'private.repair_stored_payment_channels()', 'execute')
    and not has_function_privilege('anon', 'private.repair_payment_channels(jsonb)', 'execute'));

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
