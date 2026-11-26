-- Faseela: one farm harvest per tree and season, held by the database (20261121000300_harvest_unique.sql).
-- One transaction, always rolls back via the final RAISE.
do $t$
declare
  c_f constant uuid := 'b3000000-0000-4000-8000-0000000000f1'; -- farmer (assigned to tree_14)
  c_q constant uuid := 'b3000000-0000-4000-8000-0000000000c1'; -- quality auditor
  v_year constant integer := extract(year from (now() at time zone 'utc'))::integer;
  v_j jsonb; v_b uuid; v_e text; v_n integer;
begin
  create temp table t_chk (name text, ok boolean) on commit drop;
  create function pg_temp.chk(p_name text, p_cond boolean, p_got text default null) returns void language plpgsql as $f$
  begin insert into t_chk values (p_name || case when coalesce(p_cond,false) then '' else coalesce(' got=' || left(p_got,400), '') end, coalesce(p_cond,false)); end $f$;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, '', now(), '{}'::jsonb, jsonb_build_object('display_name', u.n), now(), now()
  from (values (c_f, 'uf@t.faseela.invalid', 'U Farmer'), (c_q, 'uq@t.faseela.invalid', 'U Auditor')) u(id, email, n);
  insert into private.user_roles (user_id, role) values (c_f, 'farmer'), (c_q, 'quality_auditor');
  insert into public.farmer_assignments (farmer_uid, tree_id) values (c_f, 'tree_14');

  perform pg_temp.chk('the partial unique index exists', exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'pressing_batches'
    and indexname = 'pressing_batches_one_harvest_per_season' and indexdef like 'CREATE UNIQUE INDEX%(tree_id, season_year)%WHERE%farm%'));

  perform set_config('request.jwt.claims', json_build_object('sub', c_f, 'role', 'authenticated')::text, true);
  v_j := private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":30,"netKg":24}'::jsonb);
  v_b := (v_j ->> 'batchId')::uuid;
  perform pg_temp.chk('first harvest is recorded', v_j ->> 'status' = 'pending_review', v_j::text);

  -- A second row for the same tree and season is refused by the database itself.
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.pressing_batches (submitted_by_uid, tree_id, mill_id, olives_weight_kg, oil_yield_liters,
                                         temperature_celsius, acidity_pct, peroxide_value, season_year, status)
    values (c_f, 'tree_14', 'farm', 30, 24, 0, 0, 0, v_year, 'pending_review');
    v_e := 'inserted';
  exception when unique_violation then v_e := 'unique_violation'; end;
  perform pg_temp.chk('second farm harvest row is refused', v_e = 'unique_violation', v_e);

  -- Two submissions at the same moment: the other one lands between the check and the insert. A trigger stands in
  -- for it; the function must answer 'already-exists', not a raw database error.
  perform set_config('request.jwt.claims', json_build_object('sub', c_q, 'role', 'authenticated')::text, true);
  perform private.certify_pressing_batch(jsonb_build_object('batchId', v_b, 'decision', 'reject', 'note', 'Weights do not match.'));
  perform pg_temp.chk('rejected harvest frees the season', (select status from public.pressing_batches where id = v_b) = 'rejected');
  create function public.t_harvest_race() returns trigger language plpgsql as $f$
  begin
    if pg_trigger_depth() = 1 then
      insert into public.pressing_batches (submitted_by_uid, tree_id, mill_id, olives_weight_kg, oil_yield_liters,
                                           temperature_celsius, acidity_pct, peroxide_value, season_year, status)
      values (new.submitted_by_uid, new.tree_id, 'farm', 1, 1, 0, 0, 0, new.season_year, 'pending_review');
    end if;
    return new;
  end $f$;
  create trigger t_harvest_race before insert on public.pressing_batches for each row execute function public.t_harvest_race();
  perform set_config('request.jwt.claims', json_build_object('sub', c_f, 'role', 'authenticated')::text, true);
  begin
    perform private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":30,"netKg":24}'::jsonb);
    v_e := 'accepted';
  exception when others then get stacked diagnostics v_e = pg_exception_hint; end;
  perform pg_temp.chk('race: the second submission gets already-exists', v_e = 'already-exists', v_e);
  drop trigger t_harvest_race on public.pressing_batches;
  drop function public.t_harvest_race();
  -- (The stand-in row is undone together with the refused insert, so the season is free again here.)

  -- After a rejection a new harvest for the season can be recorded.
  perform set_config('request.jwt.claims', json_build_object('sub', c_f, 'role', 'authenticated')::text, true);
  v_j := private.submit_harvest_batch('{"treeId":"tree_14","harvestKg":31,"netKg":25}'::jsonb);
  perform pg_temp.chk('a new harvest after rejection is accepted', v_j ->> 'status' = 'pending_review', v_j::text);

  perform pg_temp.chk('submit_harvest_batch takes the per-tree lock', (select pg_get_functiondef(p.oid) like '%pg_advisory_xact_lock(hashtextextended(''faseela:harvest:''%'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'submit_harvest_batch'));

  select count(*) filter (where not ok) into v_n from t_chk;
  raise exception 'TEST SUMMARY passed=% failed=% :: %', (select count(*) filter (where ok) from t_chk), v_n, coalesce((select string_agg(name, ' | ') from t_chk where not ok), 'all good');
end
$t$;
