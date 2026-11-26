-- One weighed harvest per tree and season, enforced by the database.
-- private.submit_harvest_batch (20261116000140_harvest_kg_and_digest.sql) checked for an existing harvest and then
-- inserted, with nothing in between: two submissions at the same moment (the farmer twice, or the farmer and an
-- admin) both passed, and certifying both allocated the harvest to the sponsors twice.
--  a) Partial unique index on public.pressing_batches (tree_id, season_year) for farm harvests that are pending or
--     certified. A rejected harvest can be submitted again. The index is created only if no duplicates exist;
--     otherwise the migration stops and names them (reject the extra batch before running it again).
--  b) submit_harvest_batch takes a per-tree-and-season lock before its check, and a unique violation that still
--     reaches the insert is answered with 'already-exists'. Changed in place, so the rest of the function is kept.
-- Down: drop index if exists public.pressing_batches_one_harvest_per_season; then re-run the definition of
--       private.submit_harvest_batch from 20261116000140_harvest_kg_and_digest.sql.

do $$
declare
  v_dup text;
begin
  select string_agg(tree_id || ' ' || season_year::text || ' (' || n::text || ')', ', ' order by tree_id, season_year) into v_dup
    from (select tree_id, season_year, count(*) as n from public.pressing_batches
           where mill_id = 'farm' and status in ('pending_review', 'certified')
           group by tree_id, season_year having count(*) > 1) d;
  if v_dup is not null then
    raise exception 'Several farm harvests per tree and season: %. Reject the extra batches before applying this migration.', v_dup;
  end if;
end;
$$;

create unique index if not exists pressing_batches_one_harvest_per_season
  on public.pressing_batches (tree_id, season_year)
  where mill_id = 'farm' and status in ('pending_review', 'certified');

do $$
declare
  v_def text;
  v_check text := '  if exists (select 1 from public.pressing_batches where tree_id = v_tree and season_year = v_year and status in (''pending_review'', ''certified'')) then';
  v_lock text := '  perform pg_advisory_xact_lock(hashtextextended(''faseela:harvest:'' || v_tree || '':'' || v_year::text, 0));
';
  v_ins_start text := '  insert into public.pressing_batches (submitted_by_uid, tree_id, mill_id, olives_weight_kg, oil_yield_liters,';
  v_ins_end text := '  returning id into v_id;
';
  v_catch text := '  exception when unique_violation then
    perform private.fail(''already-exists'', ''A harvest for this tree and season is already recorded.'');
  end;
';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'submit_harvest_batch';
  if v_def is null then
    raise exception 'submit_harvest_batch: function not found';
  end if;
  if v_def like '%unique_violation%' then
    return;
  end if;
  if position(v_check in v_def) = 0 or position(v_ins_start in v_def) = 0 or position(v_ins_end in v_def) = 0 then
    raise exception 'submit_harvest_batch: expected fragment not found';
  end if;
  v_def := replace(v_def, v_check, v_lock || v_check);
  v_def := replace(v_def, v_ins_start, '  begin
' || v_ins_start);
  v_def := replace(v_def, v_ins_end, v_ins_end || v_catch);
  execute v_def;
end;
$$;
