-- Faseela (migration 32): sanctions/KYC screening as a precondition for payment approval + finance export.
-- The platform records THAT a screening happened, by whom, against which lists and with which result; it does not
-- decide which lists apply — that is a legal/compliance decision [PLATZHALTER: Listen, Schwellen, Aufbewahrungsfrist].
create table if not exists private.payment_screenings (
  id bigint generated always as identity primary key,
  request_id text not null references public.investment_requests (id),
  result text not null check (result in ('clear', 'hit', 'unclear')),
  lists_checked text not null check (char_length(lists_checked) between 3 and 300),
  reference text check (char_length(reference) <= 120),
  note text not null default '' check (char_length(note) <= 500),
  checked_by uuid not null,
  checked_at timestamptz not null default now()
);
create index if not exists payment_screenings_request_idx on private.payment_screenings (request_id, checked_at desc);
revoke all on private.payment_screenings from public, anon, authenticated;

/** Records one screening for a request under review (append-only; the latest row counts). */
create or replace function private.record_payment_screening(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_request_id text := private.req_id(p, 'requestId', '^[a-f0-9]{64}$');
  v_result text := private.req_id(p, 'result', '^(clear|hit|unclear)$');
  v_lists text := btrim(coalesce(private.opt_text(p, 'listsChecked', 300), ''));
  v_reference text := nullif(btrim(coalesce(private.opt_text(p, 'reference', 120), '')), '');
  v_note text := btrim(coalesce(private.opt_text(p, 'note', 500), ''));
  v_req public.investment_requests;
  v_id bigint;
begin
  if char_length(v_lists) < 3 then
    perform private.fail('invalid-argument', 'State which lists were checked.');
  end if;
  if v_result <> 'clear' and char_length(v_note) < 3 then
    perform private.fail('invalid-argument', 'A hit or unclear result needs a note.');
  end if;
  select * into v_req from public.investment_requests where id = v_request_id;
  if not found then
    perform private.fail('not-found', 'Investment request was not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_req.user_id);
  if v_req.status <> 'under_review' then
    perform private.fail('failed-precondition', 'Only requests under review can be screened.');
  end if;
  insert into private.payment_screenings (request_id, result, lists_checked, reference, note, checked_by)
  values (v_request_id, v_result, v_lists, v_reference, v_note, v_uid) returning id into v_id;
  -- The audit row carries the result but not the free-text note (may name third parties).
  perform private.audit(v_uid, 'payment_screening.' || v_result, 'investment_requests/' || v_request_id,
    jsonb_build_object('screeningId', v_id, 'reference', v_reference));
  return jsonb_build_object('requestId', v_request_id, 'result', v_result, 'screeningId', v_id);
end;
$$;

/** Latest screening of a request, for the reviewer UI. */
create or replace function private.payment_screening_state(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  v_request_id text := private.req_id(coalesce(payload, '{}'::jsonb), 'requestId', '^[a-f0-9]{64}$');
begin
  return (select jsonb_build_object('result', s.result, 'listsChecked', s.lists_checked, 'reference', s.reference, 'note', s.note,
                                    'checkedAt', private.epoch_ms(s.checked_at), 'checkedBySelf', s.checked_by = v_uid)
            from private.payment_screenings s where s.request_id = v_request_id order by s.checked_at desc, s.id desc limit 1);
end;
$$;

-- Approval gate: re-emit of review_investment_request with one added precondition (everything else unchanged).
create or replace function private.review_investment_request(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_request_id text := private.req_id(p, 'requestId', '^[a-f0-9]{64}$');
  v_decision text := private.req_id(p, 'decision', '^(approve|reject)$');
  v_note text := private.parse_note(p);
  v_status text := case when v_decision = 'approve' then 'approved' else 'rejected' end;
  v_req public.investment_requests;
  v_reserved integer;
  v_screening text;
begin
  select * into v_req from public.investment_requests where id = v_request_id for update;
  if not found then
    perform private.fail('not-found', 'Investment request was not found.');
  end if;
  perform private.assert_not_self_review(v_uid, v_req.user_id);
  if v_req.status <> 'under_review' then
    perform private.fail('failed-precondition', 'Only reviewed payment requests can be decided.');
  end if;
  if exists (select 1 from public.shares where id = v_request_id) then
    perform private.fail('already-exists', 'A share record already exists for this request.');
  end if;

  -- Sanctions/KYC gate (fail-closed): approval needs a latest screening with result 'clear', at most 30 days old.
  if v_decision = 'approve' then
    select s.result into v_screening from private.payment_screenings s
     where s.request_id = v_request_id and s.checked_at > now() - interval '30 days'
     order by s.checked_at desc, s.id desc limit 1;
    if v_screening is null then
      perform private.fail('screening-required', 'Record a sanctions/KYC screening before approving this payment.');
    elsif v_screening <> 'clear' then
      perform private.fail('screening-blocked', 'The latest screening is not clear; this payment cannot be approved.');
    end if;
  end if;

  select reserved_shares into v_reserved from private.trees where tree_id = v_req.tree_id for update;
  if not found or v_reserved < v_req.share_count then
    perform private.fail('failed-precondition', 'Reserved inventory is inconsistent.');
  end if;

  update private.trees
     set reserved_shares = reserved_shares - v_req.share_count,
         sold_shares = sold_shares + case when v_decision = 'approve' then v_req.share_count else 0 end,
         updated_at = now()
   where tree_id = v_req.tree_id;
  perform private.sync_available(v_req.tree_id);

  update public.investment_requests
     set status = v_status, reviewed_by_uid = v_uid, review_note = v_note, reviewed_at = now(), updated_at = now()
   where id = v_request_id;
  update public.transactions
     set status = case when v_decision = 'approve' then 'settled' else 'rejected' end,
         reviewed_by_uid = v_uid, reviewed_at = now(), updated_at = now()
   where id = v_request_id;

  if v_decision = 'approve' then
    insert into public.shares (id, request_id, user_id, tree_id, share_count, includes_land,
                               purchase_price_minor, currency, status)
    values (v_request_id, v_request_id, v_req.user_id, v_req.tree_id, v_req.share_count, v_req.includes_land,
            v_req.amount_minor, v_req.currency, 'active');
  end if;

  perform private.audit(v_uid, 'investment_request.' || v_status, 'investment_requests/' || v_request_id,
    jsonb_build_object('userId', v_req.user_id, 'treeId', v_req.tree_id, 'shareCount', v_req.share_count,
                       'amountMinor', v_req.amount_minor, 'note', v_note));
  perform private.notify_user(v_req.user_id, 'payment_' || v_status, jsonb_build_object('requestId', v_request_id, 'treeId', v_req.tree_id, 'shareCount', v_req.share_count, 'amountMinor', v_req.amount_minor, 'currency', v_req.currency, 'note', v_note));
  return jsonb_build_object('requestId', v_request_id, 'status', v_status);
end;
$$;

/** Bookkeeping export: one row per investment request created in [from, to); max 366 days, max 5000 rows. */
create or replace function private.finance_export(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_from date;
  v_to date;
  v_rows jsonb;
begin
  begin
    v_from := (private.req_id(p, 'from', '^\d{4}-\d{2}-\d{2}$'))::date;
    v_to := (private.req_id(p, 'to', '^\d{4}-\d{2}-\d{2}$'))::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    perform private.fail('invalid-argument', 'Dates are invalid.');
  end;
  if v_to < v_from or v_to - v_from > 366 then
    perform private.fail('invalid-argument', 'The period must be between 1 and 366 days.');
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x."createdAt"), '[]'::jsonb) into v_rows from (
    select r.id as "requestId", r.created_at as "createdAt", r.status, r.user_id as "userId",
           u.email as "payerEmail", pr.display_name as "payerName",
           r.tree_id as "treeId", r.share_count as "shareCount", r.includes_land as "includesLand",
           r.amount_minor as "amountMinor", r.currency,
           r.proof_submitted_at as "proofSubmittedAt", (r.payment_proof_path is not null) as "hasProof",
           r.reviewed_at as "reviewedAt", ru.email as "reviewedBy", r.review_note as "reviewNote",
           s.result as "screeningResult", s.lists_checked as "screeningLists", s.reference as "screeningReference", s.checked_at as "screeningAt"
      from public.investment_requests r
      left join auth.users u on u.id = r.user_id
      left join public.profiles pr on pr.id = r.user_id
      left join auth.users ru on ru.id = r.reviewed_by_uid
      left join lateral (select * from private.payment_screenings ps where ps.request_id = r.id order by ps.checked_at desc, ps.id desc limit 1) s on true
     where r.created_at >= v_from and r.created_at < v_to + 1
     order by r.created_at
     limit 5000) x;
  perform private.audit(v_uid, 'finance.export', 'investment_requests', jsonb_build_object('from', v_from, 'to', v_to, 'rows', jsonb_array_length(v_rows)));
  return jsonb_build_object('from', v_from, 'to', v_to, 'rows', v_rows, 'truncated', jsonb_array_length(v_rows) >= 5000);
end;
$$;

create or replace function public.record_payment_screening(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.record_payment_screening(payload); $$;
create or replace function public.payment_screening_state(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.payment_screening_state(payload); $$;
create or replace function public.finance_export(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('finance_export', 10, 600);
  select private.finance_export(payload);
$$;

revoke all on function private.record_payment_screening(jsonb), private.payment_screening_state(jsonb), private.finance_export(jsonb),
  public.record_payment_screening(jsonb), public.payment_screening_state(jsonb), public.finance_export(jsonb) from public, anon, authenticated;
grant execute on function private.record_payment_screening(jsonb), private.payment_screening_state(jsonb), private.finance_export(jsonb),
  public.record_payment_screening(jsonb), public.payment_screening_state(jsonb), public.finance_export(jsonb) to authenticated;
