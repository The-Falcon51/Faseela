-- Faseela (migration 31): four-eyes principle for the receiving accounts (payment-diversion defence).
-- With two or more admins a change is only a proposal until a DIFFERENT admin approves it. With a single admin
-- (bootstrap) the change applies at once but every admin/finance mailbox is notified, so a hijacked session is noticed.
-- The proposal lives in private.app_settings under 'payment_instructions_pending'; "no proposal" is {"status":"none"}.

/** Validates and normalises a payment-instructions payload (shared by propose/apply). */
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
  v_note_ar text := nullif(btrim(coalesce(private.opt_text(p, 'noteAr', 300), '')), '');
  v_note_en text := nullif(btrim(coalesce(private.opt_text(p, 'noteEn', 300), '')), '');
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
  return jsonb_build_object('channels', v_clean, 'noteAr', v_note_ar, 'noteEn', v_note_en);
end;
$$;
revoke all on function private.clean_payment_instructions(jsonb) from public, anon, authenticated;

/** Writes the live instructions and tells every admin + finance admin (detection control). */
create or replace function private.apply_payment_instructions(p_value jsonb, p_actor uuid, p_proposer uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.app_settings (key, value, updated_at, updated_by)
  values ('payment_instructions', p_value, now(), p_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = p_actor;
  insert into private.app_settings (key, value, updated_at, updated_by)
  values ('payment_instructions_pending', '{"status":"none"}'::jsonb, now(), p_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = p_actor;
  perform private.audit(p_actor, 'settings.payment_instructions', 'app_settings/payment_instructions',
    jsonb_build_object('channels', jsonb_array_length(p_value -> 'channels'), 'proposedBy', p_proposer, 'fourEyes', p_actor <> p_proposer));
  perform private.notify_role('finance_admin', 'payment_accounts_changed',
    jsonb_build_object('channels', jsonb_array_length(p_value -> 'channels'), 'fourEyes', p_actor <> p_proposer));
end;
$$;
revoke all on function private.apply_payment_instructions(jsonb, uuid, uuid) from public, anon, authenticated;

create or replace function private.admin_set_payment_instructions(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['admin']);
  v_value jsonb := private.clean_payment_instructions(coalesce(payload, '{}'::jsonb));
  v_admins integer;
begin
  select count(*) into v_admins
    from private.user_roles r join auth.users u on u.id = r.user_id
   where r.role = 'admin' and u.deleted_at is null and u.banned_until is null;
  if v_admins >= 2 then
    insert into private.app_settings (key, value, updated_at, updated_by)
    values ('payment_instructions_pending', jsonb_build_object('status', 'pending', 'value', v_value, 'proposedBy', v_uid), now(), v_uid)
    on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_uid;
    perform private.audit(v_uid, 'settings.payment_instructions.proposed', 'app_settings/payment_instructions',
      jsonb_build_object('channels', jsonb_array_length(v_value -> 'channels')));
    perform private.notify_role('admin', 'payment_change_pending', jsonb_build_object('channels', jsonb_array_length(v_value -> 'channels')));
    return jsonb_build_object('status', 'pending');
  end if;
  perform private.apply_payment_instructions(v_value, v_uid, v_uid);
  return jsonb_build_object('status', 'applied');
end;
$$;

create or replace function private.admin_review_payment_instructions(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['admin']);
  v_decision text := private.opt_text(coalesce(payload, '{}'::jsonb), 'decision', 10);
  v_row private.app_settings;
  v_proposer uuid;
begin
  if v_decision is null or v_decision not in ('approve', 'reject') then
    perform private.fail('invalid-argument', 'Decision is invalid.');
  end if;
  select * into v_row from private.app_settings where key = 'payment_instructions_pending' for update;
  if not found or coalesce(v_row.value ->> 'status', 'none') <> 'pending' or v_row.updated_at < now() - interval '7 days' then
    perform private.fail('not-found', 'There is no open proposal.');
  end if;
  v_proposer := (v_row.value ->> 'proposedBy')::uuid;
  if v_decision = 'approve' then
    -- Four eyes: the approving admin must not be the proposer.
    perform private.assert_not_self_review(v_uid, v_proposer);
    perform private.apply_payment_instructions(v_row.value -> 'value', v_uid, v_proposer);
    return jsonb_build_object('status', 'applied');
  end if;
  -- Reject / withdraw: allowed for every admin including the proposer.
  update private.app_settings set value = '{"status":"none"}'::jsonb, updated_at = now(), updated_by = v_uid
   where key = 'payment_instructions_pending';
  perform private.audit(v_uid, 'settings.payment_instructions.rejected', 'app_settings/payment_instructions',
    jsonb_build_object('proposedBy', v_proposer));
  return jsonb_build_object('status', 'rejected');
end;
$$;

/** Admin view: live value, open proposal (if any) and whether four-eyes is active. */
create or replace function private.admin_payment_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['admin']);
  v_live private.app_settings;
  v_pending private.app_settings;
  v_admins integer;
  v_open boolean;
begin
  select * into v_live from private.app_settings where key = 'payment_instructions';
  select * into v_pending from private.app_settings where key = 'payment_instructions_pending';
  select count(*) into v_admins
    from private.user_roles r join auth.users u on u.id = r.user_id
   where r.role = 'admin' and u.deleted_at is null and u.banned_until is null;
  v_open := v_pending.key is not null and coalesce(v_pending.value ->> 'status', 'none') = 'pending'
            and v_pending.updated_at >= now() - interval '7 days';
  return jsonb_build_object(
    'live', case when v_live.key is null then null else v_live.value || jsonb_build_object('updatedAt', private.epoch_ms(v_live.updated_at)) end,
    'pending', case when v_open then (v_pending.value -> 'value') || jsonb_build_object(
                 'proposedAt', private.epoch_ms(v_pending.updated_at),
                 'proposedBySelf', (v_pending.value ->> 'proposedBy')::uuid = v_uid) else null end,
    'fourEyes', v_admins >= 2,
    'adminCount', v_admins);
end;
$$;

create or replace function public.admin_review_payment_instructions(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_review_payment_instructions(payload); $$;
create or replace function public.admin_payment_state() returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_payment_state(); $$;

revoke all on function private.admin_set_payment_instructions(jsonb), private.admin_review_payment_instructions(jsonb), private.admin_payment_state(),
  public.admin_review_payment_instructions(jsonb), public.admin_payment_state() from public, anon, authenticated;
grant execute on function private.admin_set_payment_instructions(jsonb), private.admin_review_payment_instructions(jsonb), private.admin_payment_state(),
  public.admin_review_payment_instructions(jsonb), public.admin_payment_state() to authenticated;
