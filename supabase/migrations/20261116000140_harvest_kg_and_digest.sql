-- Faseela (migration 45): weighed harvest for the non-olive crops, second pistachio tree, weekly digest.
--  a) Harvest in kilograms: same path as olive oil (record -> review -> allocation by shares -> delivery, pickup or
--     donation). A harvest row lives in pressing_batches with mill_id = 'farm'; olives_weight_kg holds the gross
--     weight and oil_yield_liters the net weight in kg, so an allocation's liters_ml holds GRAMS for these trees.
--  b) Mill pressing is for olive trees only, and only olive trees need a mill in the task list and checklist.
--  c) tree_13 (second pistachio), unlisted.
--  d) Weekly digest rule gets its runner. The "delete unconfirmed accounts" rule is NOT implemented.

-- Existing functions are changed in place so their current bodies are kept. A missing fragment aborts the migration.
do $$
declare
  c record;
  v_def text;
begin
  for c in select * from (values
    ('admin_tasks', 'where p.status = ''listed'' and t.mill_id is null', 'where p.status = ''listed'' and p.crop_category = ''olive'' and t.mill_id is null'),
    ('admin_readiness', 'where p.status = ''listed'' and t.mill_id is null', 'where p.status = ''listed'' and p.crop_category = ''olive'' and t.mill_id is null'),
    ('submit_pressing_batch', 'where tree_id = v_tree_id and status = ''listed'')', 'where tree_id = v_tree_id and status = ''listed'' and crop_category = ''olive'')'),
    ('allocate_oil', '''certificateSerial'', p_serial));', '''certificateSerial'', p_serial, ''unit'', case when (select crop_category from public.trees_public where tree_id = p_batch.tree_id) = ''olive'' then ''l'' else ''kg'' end));')
  ) as x(fn, old, new) loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = c.fn;
    if position(c.new in v_def) > 0 then
      continue;
    end if;
    if position(c.old in v_def) = 0 then
      raise exception 'fragment not found in private.%', c.fn;
    end if;
    execute replace(v_def, c.old, c.new);
  end loop;
end;
$$;

/** Records the weighed harvest of a non-olive tree: by its assigned farmer, or by an admin. One per tree and season. */
create or replace function private.submit_harvest_batch(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role(array['farmer']);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_gross numeric := private.opt_num(p, 'harvestKg', 0.1, 5000);
  v_net numeric := private.opt_num(p, 'netKg', 0, 5000);
  v_year integer := extract(year from (now() at time zone 'utc'))::integer;
  v_admin boolean := exists (select 1 from private.user_roles where user_id = v_uid and role = 'admin');
  v_id uuid;
begin
  if v_gross is null or v_net is null or v_net > v_gross then
    perform private.fail('invalid-argument', 'Harvest weights are missing or the net weight exceeds the gross weight.');
  end if;
  if not exists (select 1 from public.trees_public where tree_id = v_tree and crop_category <> 'olive') then
    perform private.fail('not-found', 'This tree has no weighed harvest.');
  end if;
  if not v_admin and not exists (select 1 from public.farmer_assignments a where a.tree_id = v_tree and a.farmer_uid = v_uid and a.revoked_at is null) then
    perform private.fail('permission-denied', 'This tree is not assigned to this account.');
  end if;
  if exists (select 1 from public.pressing_batches where tree_id = v_tree and season_year = v_year and status in ('pending_review', 'certified')) then
    perform private.fail('already-exists', 'A harvest for this tree and season is already recorded.');
  end if;
  insert into public.pressing_batches (submitted_by_uid, tree_id, mill_id, olives_weight_kg, oil_yield_liters,
                                       temperature_celsius, acidity_pct, peroxide_value, season_year, status)
  values (v_uid, v_tree, 'farm', v_gross, v_net, 0, 0, 0, v_year, 'pending_review')
  returning id into v_id;
  perform private.notify_role('quality_auditor', 'review_needed', jsonb_build_object('queue', 'pressing_batches', 'treeId', v_tree));
  perform private.audit(v_uid, 'harvest.submitted', 'pressing_batches/' || v_id::text, jsonb_build_object('treeId', v_tree, 'harvestKg', v_gross, 'netKg', v_net));
  return jsonb_build_object('batchId', v_id, 'status', 'pending_review');
end;
$$;

create or replace function public.submit_harvest_batch(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('submit_harvest_batch', 20, 3600); select private.submit_harvest_batch(payload); $$;
revoke all on function private.submit_harvest_batch(jsonb), public.submit_harvest_batch(jsonb) from public, anon, authenticated;
grant execute on function private.submit_harvest_batch(jsonb), public.submit_harvest_batch(jsonb) to authenticated;

-- c)
with ins as (
  insert into public.trees_public (tree_id, status, crop_category, name, name_en, region, region_en, tree_type, tree_type_en,
    planted_year, estimated_annual_yield_kg, images, total_shares, available_shares, price_per_share_minor,
    land_price_minor, has_land_option, land_area_sqm, currency, updated_at)
  values ('tree_13', 'unlisted', 'pistachio', 'ياقوتة الشهباء - فستق حلب الباتوري', 'Aleppo Ruby - Batouri Pistachio Heritage', 'حلب وعفرين', 'Aleppo & Afrin',
    'فستق حلبي باتوري أصيل', 'Authentic Batouri Aleppo Pistachio', 1990, 32, array['images/pistachio_clusters_macro.webp', 'images/tree_pistachio_mork.webp'], 4, 4, 4400, 0, false, 0, 'USD', now())
  on conflict (tree_id) do nothing
  returning tree_id
)
insert into private.trees (tree_id, total_shares, price_per_share_minor, land_price_minor, currency)
select tree_id, 4, 4400, 0, 'USD' from ins on conflict (tree_id) do nothing;

-- d)
create or replace function private.run_housekeeping()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sent boolean := false;
begin
  if not exists (select 1 from private.automation_rules where key = 'weekly_digest' and enabled) then
    return;
  end if;
  begin
    if extract(isodow from now()) = 1 and extract(hour from now()) >= 6 then
      insert into private.automation_log (rule, subject) values ('weekly_digest', to_char(now(), 'IYYY-"W"IW')) on conflict do nothing;
      if found then
        perform private.notify_role('admin', 'admin_digest', jsonb_build_object(
          'users', (select count(*) from auth.users where deleted_at is null),
          'newUsers', (select count(*) from auth.users where deleted_at is null and created_at > now() - interval '7 days'),
          'owners', (select count(distinct user_id) from public.shares where status = 'active'),
          'approvedMinor', (select coalesce(sum(amount_minor), 0) from public.investment_requests where status = 'approved' and reviewed_at > now() - interval '7 days'),
          'currency', 'USD',
          'openReviews', (select count(*) from public.investment_requests where status = 'under_review'),
          'failedMails', (select count(*) from private.email_outbox where status = 'failed' and created_at > now() - interval '7 days')));
        v_sent := true;
      end if;
    end if;
    update private.automation_rules set last_run_at = now(), last_result = jsonb_build_object('ok', true, 'done', case when v_sent then '["digest"]'::jsonb else '[]'::jsonb end) where key = 'weekly_digest';
  exception when others then
    update private.automation_rules set last_run_at = now(), last_result = jsonb_build_object('ok', false, 'error', left(sqlerrm, 200)) where key = 'weekly_digest';
  end;
end;
$$;
revoke all on function private.run_housekeeping() from public, anon, authenticated;
select cron.unschedule('faseela-automations') where exists (select 1 from cron.job where jobname = 'faseela-automations');
select cron.schedule('faseela-automations', '25 * * * *', $job$select private.run_automations(); select private.run_housekeeping()$job$);
