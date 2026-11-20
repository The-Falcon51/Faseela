-- Faseela (migration 47): the second pair of eyes must be independent of the first.
-- Every review path (payment approval, payment-account changes, screening, farmer reports, pressing batches,
-- oil requests, role applications) calls private.assert_not_self_review(reviewer, owner). Until now it only
-- compared the two user ids, so one admin could appoint a second account as admin or finance admin and let it
-- approve the first account's own proposals minutes later.
-- New rule: a reviewer and a submitter are not independent for 7 days after one of them gave the other a
-- reviewing role (admin, finance_admin, quality_auditor). The appointment itself stays possible, so a team
-- with a single admin can still grow; the audit log shows who appointed whom and when.
-- Rollback: restore the two-argument id comparison (IMMUTABLE, no table access).
create or replace function private.assert_not_self_review(p_reviewer uuid, p_owner uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_reviewer is null or p_owner is null or p_reviewer = p_owner then
    perform private.fail('permission-denied', 'Reviewers cannot decide on their own submissions.');
  end if;
  if exists (
    select 1 from private.user_roles r
     where r.role in ('admin', 'finance_admin', 'quality_auditor')
       and r.granted_at > now() - interval '7 days'
       and ((r.user_id = p_reviewer and r.granted_by = p_owner)
         or (r.user_id = p_owner and r.granted_by = p_reviewer))
  ) then
    perform private.fail('permission-denied',
      'This reviewer and the submitter are not independent yet: one appointed the other to a reviewing role within the last 7 days.');
  end if;
end;
$$;
