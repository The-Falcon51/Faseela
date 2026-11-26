-- Receiving accounts limited to countries are shown only to sponsors of a tree in those countries.
-- 20261116000180 lets an admin limit a receiving account to countries and 20261121000100 uses that limit to decide
-- whether a country may be activated (private.payment_channels_for). payment_instructions() still returns every
-- account, so a sponsor of a tree in one country could be told to transfer to an account meant for another one.
-- payment_instructions_for(country) returns the live instructions with only the accounts that cover the country,
-- with the same rule as payment_channels_for: an account without a country list covers every country.
-- payment_instructions() stays unchanged for older app versions.
-- Down: drop function public.payment_instructions_for(text); drop function private.payment_instructions_for(text);

create or replace function private.payment_instructions_for(p_country text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := upper(btrim(coalesce(p_country, '')));
  v_value jsonb;
  v_updated timestamptz;
begin
  perform private.require_user(); -- raises for anonymous callers
  if v_code !~ '^[A-Z]{2}$' then
    perform private.fail('invalid-argument', 'Country code is invalid.');
  end if;
  select s.value, s.updated_at into v_value, v_updated
    from private.app_settings s where s.key = 'payment_instructions';
  if v_value is null then
    return null; -- nothing configured: the client renders the fail-closed state
  end if;
  return v_value || jsonb_build_object(
    'channels', coalesce((
      select jsonb_agg(e.ch order by e.ord)
        from jsonb_array_elements(case when jsonb_typeof(v_value -> 'channels') = 'array' then v_value -> 'channels' else '[]'::jsonb end)
             with ordinality as e(ch, ord)
       where coalesce(jsonb_typeof(e.ch -> 'countries'), 'null') <> 'array' or e.ch -> 'countries' ? v_code
    ), '[]'::jsonb),
    'country', v_code,
    'updatedAt', private.epoch_ms(v_updated));
end;
$$;

create or replace function public.payment_instructions_for(p_country text) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('payment_instructions', 60, 60);
  select private.payment_instructions_for(p_country);
$$;

revoke all on function private.payment_instructions_for(text), public.payment_instructions_for(text) from public, anon, authenticated;
grant execute on function private.payment_instructions_for(text), public.payment_instructions_for(text) to authenticated;
