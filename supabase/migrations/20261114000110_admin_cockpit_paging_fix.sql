-- Faseela (migration 37): paging validation for admin_list_investments. A cast in the DECLARE section cannot be
-- caught by the function's own exception block, so a non-numeric limit surfaced as a raw database error instead
-- of 'invalid-argument' (found by the cockpit test suite). Values are now checked before they are cast.
create or replace function private.admin_list_investments(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_status text := nullif(p ->> 'status', '');
  v_limit_raw text := coalesce(nullif(p ->> 'limit', ''), '50');
  v_offset_raw text := coalesce(nullif(p ->> 'offset', ''), '0');
  v_limit integer;
  v_offset integer;
begin
  if v_status is not null and v_status !~ '^(awaiting_payment|under_review|approved|rejected|cancelled|expired)$' then
    perform private.fail('invalid-argument', 'Field status is invalid.');
  end if;
  if v_limit_raw !~ '^-?[0-9]{1,9}$' or v_offset_raw !~ '^-?[0-9]{1,9}$' then
    perform private.fail('invalid-argument', 'Paging values are invalid.');
  end if;
  v_limit := least(greatest(v_limit_raw::integer, 1), 100);
  v_offset := greatest(v_offset_raw::integer, 0);
  return jsonb_build_object(
    'total', (select count(*) from public.investment_requests i where v_status is null or i.status = v_status),
    'limit', v_limit, 'offset', v_offset,
    'rows', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
        select i.created_at, jsonb_build_object(
          'id', i.id, 'createdAt', private.epoch_ms(i.created_at), 'status', i.status,
          'payerName', pr.display_name, 'payerEmail', pr.email, 'userId', i.user_id,
          'treeId', i.tree_id, 'shareCount', i.share_count, 'includesLand', i.includes_land,
          'amountMinor', i.amount_minor, 'currency', i.currency,
          'proofSubmittedAt', private.epoch_ms(i.proof_submitted_at), 'reviewedAt', private.epoch_ms(i.reviewed_at),
          'expiresAt', private.epoch_ms(i.expires_at), 'slaBreached', i.sla_breached, 'hasProof', i.payment_proof_path is not null) as j
          from public.investment_requests i left join public.profiles pr on pr.id = i.user_id
         where v_status is null or i.status = v_status
         order by i.created_at desc limit v_limit offset v_offset) x), '[]'::jsonb));
end;
$$;
