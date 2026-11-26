-- Country registry: a tree can only be listed in a country that is open for sales, and a country opens only
-- after its legal review and its payment route are confirmed.
-- Recovered from the live project (applied there as 20261114173919 country_registry); the statements below are
-- the applied text, unchanged.
create table if not exists private.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  status text not null default 'closed' check (status in ('closed', 'open')),
  planned_currency text not null default 'USD' check (planned_currency ~ '^[A-Z]{3}$'),
  legal_cleared boolean not null default false,
  payment_ready boolean not null default false,
  note text check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
alter table private.countries enable row level security;
revoke all on private.countries from public, anon, authenticated;

insert into private.countries (code, status, planned_currency, note) values ('SY', 'open', 'USD', 'Open before the country gate existed; legal review and payment route not confirmed yet.')
on conflict (code) do nothing;
insert into private.countries (code, planned_currency)
select c, cur from (values
  ('ES', 'EUR'), ('IT', 'EUR'), ('GR', 'EUR'), ('TR', 'TRY'),
  ('PL', 'PLN'), ('CZ', 'CZK'), ('SK', 'EUR'), ('HU', 'HUF'), ('RO', 'RON'), ('BG', 'EUR'), ('HR', 'EUR'), ('SI', 'EUR'), ('EE', 'EUR'), ('LV', 'EUR'), ('LT', 'EUR'),
  ('SA', 'SAR'), ('QA', 'QAR'), ('AE', 'AED'), ('KW', 'KWD'), ('BH', 'BHD'), ('OM', 'OMR')
) as v(c, cur)
on conflict (code) do nothing;

create or replace function private.enforce_country_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'listed'
     and (tg_op = 'INSERT' or old.status is distinct from 'listed' or old.country is distinct from new.country)
     and not exists (select 1 from private.countries c where c.code = new.country and c.status = 'open') then
    perform private.fail('failed-precondition', 'This country is not open for sales yet.');
  end if;
  return new;
end;
$$;
create or replace trigger trees_public_country_gate before insert or update of status, country on public.trees_public
  for each row execute function private.enforce_country_open();

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
            'trees', (select count(*) from public.trees_public t where t.country = c.code),
            'listedTrees', (select count(*) from public.trees_public t where t.country = c.code and t.status = 'listed'))
            order by (c.status = 'open') desc, c.code), '[]'::jsonb)
            from private.countries c);
end;
$$;

create or replace function private.admin_set_country(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_code text := private.req_id(p, 'code', '^[A-Z]{2}$');
  v_note text := nullif(btrim(coalesce(private.opt_text(p, 'note', 500), '')), '');
  v_row private.countries;
  v_legal boolean;
  v_pay boolean;
  v_status text;
begin
  select * into v_row from private.countries where code = v_code for update;
  if not found then
    perform private.fail('not-found', 'Country is not registered.');
  end if;
  if (p ? 'legalCleared' and jsonb_typeof(p -> 'legalCleared') <> 'boolean') or (p ? 'paymentReady' and jsonb_typeof(p -> 'paymentReady') <> 'boolean')
     or (p ? 'open' and jsonb_typeof(p -> 'open') <> 'boolean') then
    perform private.fail('invalid-argument', 'Country flags must be true or false.');
  end if;
  v_legal := coalesce((p ->> 'legalCleared')::boolean, v_row.legal_cleared);
  v_pay := coalesce((p ->> 'paymentReady')::boolean, v_row.payment_ready);
  v_status := case when p ? 'open' then case when (p ->> 'open')::boolean then 'open' else 'closed' end else v_row.status end;
  if v_status = 'open' and not (v_legal and v_pay)
     and (v_row.status = 'closed' or (v_row.legal_cleared and not v_legal) or (v_row.payment_ready and not v_pay)) then
    perform private.fail('failed-precondition', 'A country opens only after the legal review and the payment route are confirmed.');
  end if;
  if v_status = 'closed' and v_row.status = 'open' and exists (select 1 from public.trees_public where country = v_code and status = 'listed') then
    perform private.fail('failed-precondition', 'Hide the listed trees of this country before closing it.');
  end if;
  update private.countries set status = v_status, legal_cleared = v_legal, payment_ready = v_pay, note = coalesce(v_note, note), updated_at = now(), updated_by = v_uid where code = v_code;
  perform private.audit(v_uid, 'country.changed', 'countries/' || v_code, jsonb_build_object('statusBefore', v_row.status, 'statusAfter', v_status,
    'legalCleared', v_legal, 'paymentReady', v_pay));
  return jsonb_build_object('code', v_code, 'status', v_status, 'legalCleared', v_legal, 'paymentReady', v_pay);
end;
$$;

create or replace function public.admin_list_countries() returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_list_countries(); $$;
create or replace function public.admin_set_country(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_country(payload); $$;
revoke all on function private.enforce_country_open(), private.admin_list_countries(), private.admin_set_country(jsonb), public.admin_list_countries(), public.admin_set_country(jsonb) from public, anon, authenticated;
grant execute on function private.admin_list_countries(), private.admin_set_country(jsonb), public.admin_list_countries(), public.admin_set_country(jsonb) to authenticated;
