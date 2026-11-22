-- Receiving accounts can be limited to countries; a country's payment route can only be confirmed once at least
-- one receiving account covers it.
-- Recovered from the live project (applied there as 20261114174814 payment_channels_by_country); the statements
-- below are the applied text, unchanged.
create or replace function private.payment_channels_for(p_code text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from private.app_settings s, jsonb_array_elements(s.value -> 'channels') ch
   where s.key = 'payment_instructions'
     and jsonb_typeof(s.value -> 'channels') = 'array'
     and (coalesce(jsonb_typeof(ch -> 'countries'), 'null') <> 'array' or ch -> 'countries' ? p_code);
$$;
revoke all on function private.payment_channels_for(text) from public, anon, authenticated;

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
          if v_code !~ '^[A-Z]{2}$' or not exists (select 1 from private.countries c where c.code = v_code) then
            perform private.fail('invalid-argument', 'A country code of a payment channel is not registered.');
          end if;
          if not v_countries ? v_code then
            v_countries := v_countries || to_jsonb(v_code);
          end if;
        end loop;
      end if;
    end if;
    v_clean := v_clean || jsonb_strip_nulls(jsonb_build_object('countries', v_countries))
      || jsonb_build_object('id', v_id, 'titleAr', v_title_ar, 'titleEn', v_title_en, 'account', v_account, 'hintAr', v_hint_ar, 'hintEn', v_hint_en);
  end loop;
  return jsonb_build_object('channels', v_clean, 'noteAr', v_note_ar, 'noteEn', v_note_en);
end;
$$;
revoke all on function private.clean_payment_instructions(jsonb) from public, anon, authenticated;

create or replace function private.admin_list_countries()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('code', c.code, 'status', c.status, 'plannedCurrency', c.planned_currency,
            'legalCleared', c.legal_cleared, 'paymentReady', c.payment_ready, 'note', c.note, 'updatedAt', private.epoch_ms(c.updated_at),
            'paymentChannels', private.payment_channels_for(c.code),
            'trees', (select count(*) from public.trees_public t where t.country = c.code),
            'listedTrees', (select count(*) from public.trees_public t where t.country = c.code and t.status = 'listed'))
            order by (c.status = 'open') desc, c.code), '[]'::jsonb)
            from private.countries c);
end;
$$;

do $$
declare
  v_def text;
  v_old text := '  v_status := case when p ? ''open''';
  v_new text := '  if v_pay and not v_row.payment_ready and private.payment_channels_for(v_code) = 0 then
    perform private.fail(''failed-precondition'', ''Add a receiving account for this country before confirming its payment route.'');
  end if;
';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'admin_set_country';
  if v_def like '%payment_channels_for%' then
    return;
  end if;
  if position(v_old in v_def) = 0 then
    raise exception 'admin_set_country: expected fragment not found';
  end if;
  execute replace(v_def, v_old, v_new || v_old);
end;
$$;
