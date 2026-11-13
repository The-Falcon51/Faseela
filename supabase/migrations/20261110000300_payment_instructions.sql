-- Faseela (migration 29): server-managed payment instructions. The checkout used to ship hard-coded demo account
-- numbers; now admins maintain the receiving accounts in private.app_settings and the checkout refuses to proceed
-- while none are configured (fail-closed). Values are public to signed-in buyers by design (they must transfer to them).
create table if not exists private.app_settings (
  key text primary key check (key ~ '^[a-z_]{2,40}$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
revoke all on private.app_settings from public, anon, authenticated;

create or replace function private.payment_instructions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_user(); -- raises for anonymous callers
  -- null (not an error) while nothing is configured: the client renders the fail-closed state.
  return (select value || jsonb_build_object('updatedAt', private.epoch_ms(updated_at))
            from private.app_settings where key = 'payment_instructions');
end;
$$;

create or replace function private.admin_set_payment_instructions(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_channels jsonb := p -> 'channels';
  v_ch jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_id text; v_title_ar text; v_title_en text; v_account text; v_hint_ar text; v_hint_en text;
  v_note_ar text := nullif(btrim(coalesce(private.opt_text(p, 'noteAr', 300), '')), '');
  v_note_en text := nullif(btrim(coalesce(private.opt_text(p, 'noteEn', 300), '')), '');
  v_value jsonb;
begin
  if coalesce(jsonb_typeof(v_channels), 'missing') <> 'array' or jsonb_array_length(v_channels) < 1 or jsonb_array_length(v_channels) > 6 then
    perform private.fail('invalid-argument', 'Provide between 1 and 6 payment channels.');
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
    v_clean := v_clean || jsonb_build_object('id', v_id, 'titleAr', v_title_ar, 'titleEn', v_title_en, 'account', v_account,
                                             'hintAr', v_hint_ar, 'hintEn', v_hint_en);
  end loop;
  v_value := jsonb_build_object('channels', v_clean, 'noteAr', v_note_ar, 'noteEn', v_note_en);
  insert into private.app_settings (key, value, updated_at, updated_by)
  values ('payment_instructions', v_value, now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_uid;
  perform private.audit(v_uid, 'settings.payment_instructions', 'app_settings/payment_instructions',
    jsonb_build_object('channels', jsonb_array_length(v_clean)));
  return v_value || jsonb_build_object('updatedAt', private.epoch_ms(now()));
end;
$$;

create or replace function public.payment_instructions() returns jsonb
language sql security invoker set search_path = '' as $$ select private.payment_instructions(); $$;
create or replace function public.admin_set_payment_instructions(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_payment_instructions(payload); $$;

revoke all on function private.payment_instructions(), private.admin_set_payment_instructions(jsonb),
  public.payment_instructions(), public.admin_set_payment_instructions(jsonb) from public, anon, authenticated;
grant execute on function private.payment_instructions(), private.admin_set_payment_instructions(jsonb),
  public.payment_instructions(), public.admin_set_payment_instructions(jsonb) to authenticated;
