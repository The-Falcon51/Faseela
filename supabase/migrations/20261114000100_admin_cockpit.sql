-- Faseela (migration 36): read models and switches for the stand-alone admin panel (public/admin/).
-- Everything is aggregated or listed server-side behind role checks; the panel itself holds no privileges.
-- Admin-only unless stated; finance admins may list investments and trees (they review payments).

/** Key figures for the dashboard: users, requests, 12-month series, inventory, funnel, channels, operations. */
create or replace function private.admin_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
begin
  return jsonb_build_object(
    'generatedAt', private.epoch_ms(now()),
    'users', (select jsonb_build_object(
        'total', count(*),
        'confirmed', count(*) filter (where u.email_confirmed_at is not null),
        'new7d', count(*) filter (where u.created_at > now() - interval '7 days'),
        'new30d', count(*) filter (where u.created_at > now() - interval '30 days'),
        'suspended', count(*) filter (where u.banned_until is not null and u.banned_until > now()))
      from auth.users u where u.deleted_at is null),
    'roles', (select coalesce(jsonb_object_agg(x.role, x.n), '{}'::jsonb)
      from (select coalesce(r.role, 'investor') as role, count(*) as n
              from auth.users u left join private.user_roles r on r.user_id = u.id
             where u.deleted_at is null group by 1) x),
    'requests', (select jsonb_build_object(
        'byStatus', coalesce((select jsonb_object_agg(s.status, s.n) from (select status, count(*) n from public.investment_requests group by status) s), '{}'::jsonb),
        'approvedMinor', coalesce(sum(i.amount_minor) filter (where i.status = 'approved'), 0),
        'openMinor', coalesce(sum(i.amount_minor) filter (where i.status in ('awaiting_payment', 'under_review')), 0),
        'overdue', count(*) filter (where i.status = 'under_review' and i.sla_breached),
        'expiring24h', count(*) filter (where i.status = 'awaiting_payment' and i.expires_at < now() + interval '24 hours'))
      from public.investment_requests i),
    'months', (select jsonb_agg(jsonb_build_object(
        'month', to_char(m.d, 'YYYY-MM'),
        'requests', (select count(*) from public.investment_requests i where i.created_at >= m.d and i.created_at < m.d + interval '1 month'),
        'approved', (select count(*) from public.investment_requests i where i.status = 'approved' and i.reviewed_at >= m.d and i.reviewed_at < m.d + interval '1 month'),
        'approvedMinor', (select coalesce(sum(i.amount_minor), 0) from public.investment_requests i where i.status = 'approved' and i.reviewed_at >= m.d and i.reviewed_at < m.d + interval '1 month'),
        'signups', (select count(*) from auth.users u where u.deleted_at is null and u.created_at >= m.d and u.created_at < m.d + interval '1 month')) order by m.d)
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') as m(d)),
    'inventory', (select jsonb_build_object(
        'trees', count(*),
        'listed', (select count(*) from public.trees_public p where p.status = 'listed'),
        'totalShares', coalesce(sum(t.total_shares), 0),
        'soldShares', coalesce(sum(t.sold_shares), 0),
        'reservedShares', coalesce(sum(t.reserved_shares), 0))
      from private.trees t),
    'funnel', jsonb_build_object(
        'confirmed', (select count(*) from auth.users u where u.deleted_at is null and u.email_confirmed_at is not null),
        'requested', (select count(distinct user_id) from public.investment_requests),
        'proof', (select count(distinct user_id) from public.investment_requests where proof_submitted_at is not null),
        'owners', (select count(distinct user_id) from public.shares where status = 'active')),
    'gifts', coalesce((select jsonb_object_agg(g.status, g.n) from (select status, count(*) n from public.gifts group by status) g), '{}'::jsonb),
    'referrals', coalesce((select jsonb_object_agg(r.status, r.n) from (select status, count(*) n from public.referrals group by status) r), '{}'::jsonb),
    'oil', jsonb_build_object(
        'allocatedMl', (select coalesce(sum(liters_ml), 0) from public.oil_allocations),
        'requestsPending', (select count(*) from public.oil_requests where status = 'pending'),
        'requestsApproved', (select count(*) from public.oil_requests where status = 'approved')),
    'mail', jsonb_build_object(
        'sent', (select count(*) from private.email_outbox where status = 'sent'),
        'pending', (select count(*) from private.email_outbox where status in ('pending', 'sending')),
        'failed7d', (select count(*) from private.email_outbox where status = 'failed' and created_at > now() - interval '7 days')),
    'push', jsonb_build_object(
        'enabled', private.push_enabled(),
        'activeDevices', (select count(*) from private.push_tokens where disabled_at is null)),
    'errors', jsonb_build_object(
        'last24h', (select count(*) from private.client_errors where created_at > now() - interval '24 hours'),
        'last7d', (select count(*) from private.client_errors where created_at > now() - interval '7 days')),
    'operations', jsonb_build_object(
        'adminCount', (select count(*) from private.user_roles where role = 'admin'),
        'financeAdminCount', (select count(*) from private.user_roles where role = 'finance_admin'),
        'paymentAccountsConfigured', exists (select 1 from private.app_settings s where s.key = 'payment_instructions'
                                              and jsonb_array_length(coalesce(s.value -> 'channels', '[]'::jsonb)) > 0),
        'reviewQueues', jsonb_build_object(
            'payments', (select count(*) from public.investment_requests where status = 'under_review'),
            'roleApplications', (select count(*) from public.role_applications where status = 'pending'),
            'farmerUpdates', (select count(*) from public.farmer_updates where status = 'pending_review'),
            'pressingBatches', (select count(*) from public.pressing_batches where status = 'pending_review'),
            'oilRequests', (select count(*) from public.oil_requests where status in ('pending', 'approved')))));
end;
$$;

/** Investment requests with payer, newest first. Optional status filter; paged (max 100). */
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
  v_limit integer := least(greatest(coalesce(nullif(p ->> 'limit', '')::integer, 50), 1), 100);
  v_offset integer := greatest(coalesce(nullif(p ->> 'offset', '')::integer, 0), 0);
begin
  if v_status is not null and v_status !~ '^(awaiting_payment|under_review|approved|rejected|cancelled|expired)$' then
    perform private.fail('invalid-argument', 'Field status is invalid.');
  end if;
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
exception when invalid_text_representation then
  perform private.fail('invalid-argument', 'Paging values are invalid.');
  return null;
end;
$$;

/** Tree inventory with sales figures, holders and assigned farmers. */
create or replace function private.admin_list_trees()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['finance_admin']);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'treeId', t.tree_id, 'name', p.name, 'nameEn', p.name_en, 'region', p.region, 'regionEn', p.region_en,
      'status', coalesce(p.status, 'unlisted'), 'totalShares', t.total_shares, 'soldShares', t.sold_shares,
      'reservedShares', t.reserved_shares, 'availableShares', greatest(t.total_shares - t.sold_shares - t.reserved_shares, 0),
      'pricePerShareMinor', t.price_per_share_minor, 'landPriceMinor', t.land_price_minor, 'currency', t.currency,
      'holders', (select count(distinct s.user_id) from public.shares s where s.tree_id = t.tree_id and s.status = 'active'),
      'farmers', (select count(*) from public.farmer_assignments a where a.tree_id = t.tree_id and a.revoked_at is null),
      'revenueMinor', (select coalesce(sum(i.amount_minor), 0) from public.investment_requests i where i.tree_id = t.tree_id and i.status = 'approved'),
      'updatedAt', private.epoch_ms(t.updated_at)) order by t.tree_id)
    from private.trees t left join public.trees_public p on p.tree_id = t.tree_id), '[]'::jsonb);
end;
$$;

/** Shows or hides a tree in the public catalogue. Existing shares and open requests are not touched. */
create or replace function private.admin_set_tree_status(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[a-z0-9_]{1,40}$');
  v_status text := private.req_id(p, 'status', '^(listed|unlisted)$');
  v_previous text;
begin
  select status into v_previous from public.trees_public where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  if v_previous = v_status then
    return jsonb_build_object('treeId', v_tree, 'status', v_status, 'changed', false);
  end if;
  update public.trees_public set status = v_status, updated_at = now() where tree_id = v_tree;
  perform private.audit(v_uid, 'tree.' || v_status, 'trees_public/' || v_tree, jsonb_build_object('previous', v_previous));
  return jsonb_build_object('treeId', v_tree, 'status', v_status, 'changed', true);
end;
$$;

/** Client errors of the last 14 days, grouped by fingerprint (no user ids, no user agents). */
create or replace function private.admin_list_client_errors()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
begin
  return coalesce((select jsonb_agg(x.j order by x.n desc, x.last_seen desc) from (
      select count(*) as n, max(e.created_at) as last_seen, jsonb_build_object(
        'fingerprint', e.fingerprint, 'message', left(max(e.message), 240), 'source', max(e.source), 'page', max(e.page),
        'release', max(e.release), 'count', count(*), 'users', count(distinct e.user_id),
        'firstSeen', private.epoch_ms(min(e.created_at)), 'lastSeen', private.epoch_ms(max(e.created_at))) as j
        from private.client_errors e where e.created_at > now() - interval '14 days'
       group by e.fingerprint order by count(*) desc limit 50) x), '[]'::jsonb);
end;
$$;

/** Server switch for push notifications (see migration 35). */
create or replace function private.admin_set_push_enabled(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_raw jsonb := coalesce(payload, '{}'::jsonb) -> 'enabled';
  v_enabled boolean;
begin
  if v_raw is null or jsonb_typeof(v_raw) <> 'boolean' then
    perform private.fail('invalid-argument', 'Field enabled is invalid.');
  end if;
  v_enabled := v_raw::text = 'true';
  insert into private.app_settings (key, value, updated_at, updated_by)
  values ('push_enabled', to_jsonb(v_enabled), now(), v_uid)
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  perform private.audit(v_uid, 'settings.push_enabled', 'app_settings/push_enabled', jsonb_build_object('enabled', v_enabled));
  return jsonb_build_object('enabled', v_enabled);
end;
$$;

create or replace function public.admin_dashboard() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_dashboard();
$$;
create or replace function public.admin_list_investments(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_list_investments(payload);
$$;
create or replace function public.admin_list_trees() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_list_trees();
$$;
create or replace function public.admin_list_client_errors() returns jsonb
language sql security invoker set search_path = '' as $$
  select private.rate_limit('admin_read', 240, 60);
  select private.admin_list_client_errors();
$$;
create or replace function public.admin_set_tree_status(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_tree_status(payload); $$;
create or replace function public.admin_set_push_enabled(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_push_enabled(payload); $$;

revoke all on function private.admin_dashboard(), private.admin_list_investments(jsonb), private.admin_list_trees(),
  private.admin_set_tree_status(jsonb), private.admin_list_client_errors(), private.admin_set_push_enabled(jsonb),
  public.admin_dashboard(), public.admin_list_investments(jsonb), public.admin_list_trees(),
  public.admin_set_tree_status(jsonb), public.admin_list_client_errors(), public.admin_set_push_enabled(jsonb)
  from public, anon, authenticated;
grant execute on function private.admin_dashboard(), private.admin_list_investments(jsonb), private.admin_list_trees(),
  private.admin_set_tree_status(jsonb), private.admin_list_client_errors(), private.admin_set_push_enabled(jsonb),
  public.admin_dashboard(), public.admin_list_investments(jsonb), public.admin_list_trees(),
  public.admin_set_tree_status(jsonb), public.admin_list_client_errors(), public.admin_set_push_enabled(jsonb)
  to authenticated;
