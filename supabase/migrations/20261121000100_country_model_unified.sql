-- One country model. The registry that was applied to the live project (private.countries with its own
-- open/closed switch) and the master data model (public.countries, active/planned) described the same thing.
-- From here on public.countries is the registry and its status is the only switch.
--  a) Listing gate: a tree can be listed only in an active country (trigger, so it holds on every write path).
--  b) A country is activated only when at least one receiving account covers it (the rule of the old registry
--     that could be kept without a second switch; the legal review stays a decision of the admin who activates).
--  c) Receiving accounts: country codes are checked against public.countries. This also repairs the stored shape
--     (current setting and pending proposal): the applied version wrote a separate element in front of every
--     channel, {} or {"countries":[...]}; the country limit goes back onto its channel.
--  d) private.countries goes. It held defaults only.
-- Down (the data repair and the drop of private.countries are forward-only; run the steps in this order):
--   1. drop trigger if exists trees_public_country_gate on public.trees_public;
--      drop function if exists private.enforce_country_active();
--   2. restore private.admin_set_country_status from 20261118000100_master_data.sql (activation without the
--      receiving-account check);
--   3. drop function if exists private.repair_stored_payment_channels();
--      drop function if exists private.repair_payment_channels(jsonb);
--   4. keep private.clean_payment_instructions as defined here and keep the repaired channels.
--   Do not re-run 20261116000170 / 20261116000180: they read trees_public.country and private.countries, and 180
--   writes the broken channel shape again. Undoing 20261118000100_master_data.sql or 20261117000050 after this is
--   not supported (see their Down notes).

create or replace function private.enforce_country_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'listed'
     and (tg_op = 'INSERT' or old.status is distinct from 'listed' or old.country_code is distinct from new.country_code)
     and not exists (select 1 from public.countries c where c.code = new.country_code and c.status = 'active') then
    perform private.fail('failed-precondition', 'This country is not open for sales yet.');
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_country_active() from public, anon, authenticated;
drop trigger if exists trees_public_country_gate on public.trees_public;
create trigger trees_public_country_gate before insert or update of status, country_code on public.trees_public
  for each row execute function private.enforce_country_active();

create or replace function private.clean_payment_instructions(p jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_channels jsonb := p -> 'channels';
  v_ch jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_id text; v_title_ar text; v_title_en text; v_account text; v_hint_ar text; v_hint_en text;
  v_countries jsonb; v_code text;
  v_note_ar text := nullif(btrim(coalesce(private.opt_text(p, 'noteAr', 300), '')), '');
  v_note_en text := nullif(btrim(coalesce(private.opt_text(p, 'noteEn', 300), '')), '');
begin
  if coalesce(jsonb_typeof(v_channels), 'missing') <> 'array' or jsonb_array_length(v_channels) < 1 or jsonb_array_length(v_channels) > 12 then
    perform private.fail('invalid-argument', 'Provide between 1 and 12 payment channels.');
  end if;
  for v_ch in select * from jsonb_array_elements(v_channels) loop
    v_id := private.opt_text(v_ch, 'id', 20);
    v_title_ar := btrim(coalesce(private.opt_text(v_ch, 'titleAr', 80), ''));
    v_title_en := btrim(coalesce(private.opt_text(v_ch, 'titleEn', 80), ''));
    v_account := btrim(coalesce(private.opt_text(v_ch, 'account', 60), ''));
    v_hint_ar := nullif(btrim(coalesce(private.opt_text(v_ch, 'hintAr', 160), '')), '');
    v_hint_en := nullif(btrim(coalesce(private.opt_text(v_ch, 'hintEn', 160), '')), '');
    if v_id is null or v_id !~ '^(syriatel_cash|mtn_cash|bank_iban|exchange_office|other)$' then
      perform private.fail('invalid-argument', 'Channel type is invalid.');
    end if;
    if char_length(v_title_ar) < 2 or char_length(v_title_en) < 2 then
      perform private.fail('invalid-argument', 'Each channel needs an Arabic and an English title.');
    end if;
    if v_account !~ '^[A-Za-z0-9 +./-]{3,60}$' then
      perform private.fail('invalid-argument', 'Account / number may only contain letters, digits, space, + . / - (3-60 chars).');
    end if;
    v_countries := null;
    if v_ch ? 'countries' and jsonb_typeof(v_ch -> 'countries') <> 'null' then
      if jsonb_typeof(v_ch -> 'countries') <> 'array' or jsonb_array_length(v_ch -> 'countries') > 40 then
        perform private.fail('invalid-argument', 'Countries must be a list of at most 40 country codes.');
      end if;
      if jsonb_array_length(v_ch -> 'countries') > 0 then
        v_countries := '[]'::jsonb;
        for v_code in select jsonb_array_elements_text(v_ch -> 'countries') loop
          if v_code !~ '^[A-Z]{2}$' or not exists (select 1 from public.countries c where c.code = v_code) then
            perform private.fail('invalid-argument', 'A country code of a payment channel is not registered.');
          end if;
          if not v_countries ? v_code then
            v_countries := v_countries || to_jsonb(v_code);
          end if;
        end loop;
      end if;
    end if;
    -- One array element per channel (jsonb_build_array): array || object would append the object as its own element.
    v_clean := v_clean || jsonb_build_array(
      jsonb_build_object('id', v_id, 'titleAr', v_title_ar, 'titleEn', v_title_en, 'account', v_account, 'hintAr', v_hint_ar, 'hintEn', v_hint_en)
      || jsonb_strip_nulls(jsonb_build_object('countries', v_countries)));
  end loop;
  return jsonb_build_object('channels', v_clean, 'noteAr', v_note_ar, 'noteEn', v_note_en);
end;
$$;
revoke all on function private.clean_payment_instructions(jsonb) from public, anon, authenticated;

-- Stored receiving accounts. The applied version wrote a separate element in front of every channel: {} for a
-- channel without a country limit, {"countries":[...]} for a limited one (the channel itself then had no limit).
-- The limit is moved back onto the next channel that has an id; every element without an id goes.
create or replace function private.repair_payment_channels(p_channels jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ch jsonb;
  v_countries jsonb := null;
  v_out jsonb := '[]'::jsonb;
begin
  if coalesce(jsonb_typeof(p_channels), 'null') <> 'array' then
    return p_channels;
  end if;
  for v_ch in select t.e from jsonb_array_elements(p_channels) with ordinality t(e, i) order by t.i loop
    if jsonb_typeof(v_ch) <> 'object' then
      continue;
    elsif v_ch ? 'id' then
      if v_countries is not null and not (v_ch ? 'countries') then
        v_ch := v_ch || jsonb_build_object('countries', v_countries);
      end if;
      v_out := v_out || jsonb_build_array(v_ch);
      v_countries := null;
    elsif jsonb_typeof(v_ch -> 'countries') = 'array' and jsonb_array_length(v_ch -> 'countries') > 0 then
      v_countries := v_ch -> 'countries';
    end if;
  end loop;
  return v_out;
end;
$$;

-- Repairs the current setting (value.channels) and the pending four-eyes proposal (value.value.channels, see
-- 20261111000200_payment_four_eyes.sql). Country codes of a limit that public.countries does not know yet become
-- planned countries (code as neutral name, USD), so the limit is kept and the setting can be saved again.
create or replace function private.repair_stored_payment_channels()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_k integer;
begin
  update private.app_settings s
     set value = jsonb_set(s.value, '{channels}', private.repair_payment_channels(s.value -> 'channels'))
   where s.key = 'payment_instructions'
     and jsonb_typeof(s.value -> 'channels') = 'array'
     and exists (select 1 from jsonb_array_elements(s.value -> 'channels') ch
                  where jsonb_typeof(ch) <> 'object' or not (ch ? 'id'));
  get diagnostics v_k = row_count;
  v_n := v_n + v_k;
  update private.app_settings s
     set value = jsonb_set(s.value, '{value,channels}', private.repair_payment_channels(s.value #> '{value,channels}'))
   where s.key = 'payment_instructions_pending'
     and jsonb_typeof(s.value #> '{value,channels}') = 'array'
     and exists (select 1 from jsonb_array_elements(s.value #> '{value,channels}') ch
                  where jsonb_typeof(ch) <> 'object' or not (ch ? 'id'));
  get diagnostics v_k = row_count;
  v_n := v_n + v_k;
  insert into public.countries (code, name, name_en, name_de, currency, status)
    select distinct c.code, c.code, c.code, c.code, 'USD', 'planned'
      from private.app_settings s
      cross join lateral jsonb_array_elements(case s.key when 'payment_instructions' then s.value -> 'channels'
                                                          else s.value #> '{value,channels}' end) ch
      cross join lateral jsonb_array_elements_text(ch -> 'countries') c(code)
     where s.key in ('payment_instructions', 'payment_instructions_pending')
       and jsonb_typeof(case s.key when 'payment_instructions' then s.value -> 'channels' else s.value #> '{value,channels}' end) = 'array'
       and jsonb_typeof(ch) = 'object' and jsonb_typeof(ch -> 'countries') = 'array'
       and c.code ~ '^[A-Z]{2}$'
       and not exists (select 1 from public.countries x where x.code = c.code)
    on conflict (code) do nothing;
  return v_n;
end;
$$;
revoke all on function private.repair_payment_channels(jsonb), private.repair_stored_payment_channels() from public, anon, authenticated;
select private.repair_stored_payment_channels();

-- Activation needs a receiving account for the country. Changed in place so the rest of the function is kept.
do $$
declare
  v_def text;
  v_old text := '  update public.countries set status = v_status, updated_at = now() where code = v_code;';
  v_new text := '  if v_status = ''active'' and v_before <> ''active'' and private.payment_channels_for(v_code) = 0 then
    perform private.fail(''failed-precondition'', ''Add a receiving account for this country before activating it.'');
  end if;
';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'admin_set_country_status';
  if v_def like '%payment_channels_for%' then
    return;
  end if;
  if position(v_old in v_def) = 0 then
    raise exception 'admin_set_country_status: expected fragment not found';
  end if;
  execute replace(v_def, v_old, v_new || v_old);
end;
$$;

drop table if exists private.countries;
