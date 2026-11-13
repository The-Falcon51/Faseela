-- Faseela screening + finance-export suite (migration 32). One transaction, always rolls back via the final RAISE.
-- Run: npm run test:db (psql) or paste into the SQL editor. Creates its own test tree.
do $t$
declare
  c_f constant uuid := 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1'; -- finance admin
  c_i constant uuid := 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2'; -- investor
  r1 constant text := repeat('7', 64); -- investor, approved after clear screening
  r2 constant text := repeat('8', 64); -- finance admin's own request
  r3 constant text := repeat('9', 64); -- rejected without screening
  r4 constant text := repeat('0', 64); -- stale screening
  v_j jsonb;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  grant insert on t_chk to anon, authenticated;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,300), '') end, coalesce(p_cond,false)); end $f$;
  create function pg_temp.as_user(p uuid) returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims', json_build_object('sub',p,'role','authenticated')::text, true); perform set_config('role','authenticated',true); end $f$;
  create function pg_temp.as_pg() returns void language plpgsql as $f$
  begin perform set_config('role','none',true); perform set_config('request.jwt.claims','',true); end $f$;
  create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
  declare h text; begin begin execute p_sql; return 'OK'; exception when others then get stacked diagnostics h = pg_exception_hint; perform set_config('role','none',true); return coalesce(nullif(h,''),'ERR'); end; end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n, 'requested_role', 'investor'), now(), now()
  from (values (c_f, 'sf@t.faseela.invalid', 'Fin Admin'), (c_i, 'si@t.faseela.invalid', 'Payer One')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_f, 'finance_admin');
  insert into public.trees_public (tree_id, total_shares, available_shares, price_per_share_minor) values ('tree_s1', 4, 0, 3500);
  insert into private.trees (tree_id, total_shares, price_per_share_minor) values ('tree_s1', 4, 3500);
  update private.trees set reserved_shares = 4 where tree_id = 'tree_s1';
  insert into public.investment_requests (id, user_id, tree_id, share_count, includes_land, amount_minor, currency, status, expires_at, proof_submitted_at, payment_proof_path) values
    (r1, c_i, 'tree_s1', 1, false, 3500, 'USD', 'under_review', now() + interval '1 day', now(), c_i::text || '/' || r1 || '/r.pdf'),
    (r2, c_f, 'tree_s1', 1, false, 3500, 'USD', 'under_review', now() + interval '1 day', now(), null),
    (r3, c_i, 'tree_s1', 1, false, 3500, 'USD', 'under_review', now() + interval '1 day', now(), null),
    (r4, c_i, 'tree_s1', 1, false, 3500, 'USD', 'under_review', now() + interval '1 day', now(), null);

  -- ---------------------------------------------------------------- screening gate
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot record a screening', pg_temp.try(format('select public.record_payment_screening(%L)', jsonb_build_object('requestId', r1, 'result', 'clear', 'listsChecked', 'EU, UN'))) = 'permission-denied');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('approval without screening refused', pg_temp.try(format('select public.review_investment_request(%L)', jsonb_build_object('requestId', r1, 'decision', 'approve'))) = 'screening-required');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('lists are mandatory', pg_temp.try(format('select public.record_payment_screening(%L)', jsonb_build_object('requestId', r1, 'result', 'clear'))) = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('hit needs a note', pg_temp.try(format('select public.record_payment_screening(%L)', jsonb_build_object('requestId', r1, 'result', 'hit', 'listsChecked', 'EU, UN'))) = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('unknown result rejected', pg_temp.try(format('select public.record_payment_screening(%L)', jsonb_build_object('requestId', r1, 'result', 'fine', 'listsChecked', 'EU, UN'))) = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  v_j := public.record_payment_screening(jsonb_build_object('requestId', r1, 'result', 'unclear', 'listsChecked', 'EU, UN', 'note', 'Name similarity, clarifying'));
  perform pg_temp.chk('unclear recorded', (v_j->>'result') = 'unclear', v_j::text);
  perform pg_temp.chk('unclear blocks approval', pg_temp.try(format('select public.review_investment_request(%L)', jsonb_build_object('requestId', r1, 'decision', 'approve'))) = 'screening-blocked');
  perform pg_temp.as_user(c_f);
  perform public.record_payment_screening(jsonb_build_object('requestId', r1, 'result', 'clear', 'listsChecked', 'EU, UN, OFAC', 'reference', 'CASE-1'));
  v_j := public.payment_screening_state(jsonb_build_object('requestId', r1));
  perform pg_temp.chk('state shows the latest screening', (v_j->>'result') = 'clear' and (v_j->>'reference') = 'CASE-1' and (v_j->>'checkedBySelf') = 'true', v_j::text);
  v_j := public.review_investment_request(jsonb_build_object('requestId', r1, 'decision', 'approve', 'note', 'ok'));
  perform pg_temp.chk('clear screening allows approval', (v_j->>'status') = 'approved', v_j::text);
  perform pg_temp.chk('screening closed after decision', pg_temp.try(format('select public.record_payment_screening(%L)', jsonb_build_object('requestId', r1, 'result', 'clear', 'listsChecked', 'EU, UN'))) = 'failed-precondition');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('no screening of own request', pg_temp.try(format('select public.record_payment_screening(%L)', jsonb_build_object('requestId', r2, 'result', 'clear', 'listsChecked', 'EU, UN'))) = 'permission-denied');
  perform pg_temp.as_user(c_f);
  v_j := public.review_investment_request(jsonb_build_object('requestId', r3, 'decision', 'reject', 'note', 'receipt unreadable'));
  perform pg_temp.chk('rejection needs no screening', (v_j->>'status') = 'rejected', v_j::text);
  perform public.record_payment_screening(jsonb_build_object('requestId', r4, 'result', 'clear', 'listsChecked', 'EU, UN'));
  perform pg_temp.as_pg();
  update private.payment_screenings set checked_at = now() - interval '31 days' where request_id = r4;
  perform pg_temp.chk('share exists only for the approved request', (select count(*) from public.shares where id in (r1, r2, r3, r4)) = 1);
  perform pg_temp.chk('audit has result but no free-text note', (select count(*) from public.audit_logs where action like 'payment_screening.%' and actor_uid = c_f and details::text not like '%similarity%') = 3);
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('stale screening (>30 d) does not count', pg_temp.try(format('select public.review_investment_request(%L)', jsonb_build_object('requestId', r4, 'decision', 'approve'))) = 'screening-required');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('screenings table hidden', pg_temp.try('select count(*) from private.payment_screenings') <> 'OK');
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot read screening state', pg_temp.try(format('select public.payment_screening_state(%L)', jsonb_build_object('requestId', r1))) = 'permission-denied');

  -- ---------------------------------------------------------------- finance export
  perform pg_temp.as_user(c_i);
  perform pg_temp.chk('investor cannot export', pg_temp.try(format('select public.finance_export(%L)', jsonb_build_object('from', current_date::text, 'to', current_date::text))) = 'permission-denied');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('bad date rejected', pg_temp.try('select public.finance_export(''{"from":"2026-13-40","to":"2026-12-01"}'')') = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  perform pg_temp.chk('period over 366 days rejected', pg_temp.try('select public.finance_export(''{"from":"2024-01-01","to":"2026-01-01"}'')') = 'invalid-argument');
  perform pg_temp.as_user(c_f);
  v_j := public.finance_export(jsonb_build_object('from', current_date::text, 'to', current_date::text));
  perform pg_temp.chk('export contains the period rows', (select count(*) from jsonb_array_elements(v_j->'rows') e where e->>'requestId' in (r1, r2, r3, r4)) = 4, (v_j->'rows')::text);
  perform pg_temp.chk('export row carries payer, reviewer, screening', (select (e->>'payerEmail') = 'si@t.faseela.invalid' and (e->>'payerName') = 'Payer One' and (e->>'reviewedBy') = 'sf@t.faseela.invalid'
      and (e->>'screeningResult') = 'clear' and (e->>'screeningReference') = 'CASE-1' and (e->>'hasProof') = 'true' and (e->>'amountMinor') = '3500' and (e->>'status') = 'approved'
      from jsonb_array_elements(v_j->'rows') e where e->>'requestId' = r1), (v_j->'rows')::text);
  perform pg_temp.chk('export exposes no storage path', (v_j::text not like '%/r.pdf%'));
  perform pg_temp.as_pg();
  perform pg_temp.chk('export audited', (select count(*) from public.audit_logs where action = 'finance.export' and actor_uid = c_f) = 1);
  raise exception using errcode = 'P0002', message = (select format('TEST SUMMARY passed=%s failed=%s %s', count(*) filter (where ok), count(*) filter (where not ok), coalesce(string_agg(name, ' | ') filter (where not ok), '')) from t_chk);
end $t$;
