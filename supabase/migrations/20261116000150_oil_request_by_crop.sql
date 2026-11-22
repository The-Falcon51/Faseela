-- Faseela (migration 46): one request carries either olive oil or weighed harvest, never both — the two amounts
-- have different units (millilitres vs grams). Referral credits are olive oil and ride along with oil requests only.
-- request_oil is changed in place so its current body is kept; a missing fragment aborts the migration.
do $$
declare
  c record;
  v_def text;
begin
  for c in select * from (values
    ('  select coalesce(sum(liters_ml), 0) into v_credit from public.reward_credits where user_id = v_uid and status = ''granted'';
  v_ml := v_ml + v_credit;',
     '  if (select count(distinct (tp.crop_category = ''olive'')) from public.oil_allocations a join public.trees_public tp on tp.tree_id = a.tree_id where a.id = any(v_ids)) > 1 then
    perform private.fail(''invalid-argument'', ''Olive oil and weighed harvest must be requested separately.'');
  end if;
  if not exists (select 1 from public.oil_allocations a join public.trees_public tp on tp.tree_id = a.tree_id where a.id = any(v_ids) and tp.crop_category <> ''olive'') then
    select coalesce(sum(liters_ml), 0) into v_credit from public.reward_credits where user_id = v_uid and status = ''granted'';
    v_ml := v_ml + v_credit;
  end if;'),
    ('oil_request_id = v_request_id
   where user_id = v_uid and status = ''granted'';',
     'oil_request_id = v_request_id
   where user_id = v_uid and status = ''granted'' and v_credit > 0;')
  ) as x(old, new) loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'request_oil';
    if position(c.new in v_def) > 0 then
      continue;
    end if;
    if position(c.old in v_def) = 0 then
      raise exception 'fragment not found in private.request_oil';
    end if;
    execute replace(v_def, c.old, c.new);
  end loop;
end;
$$;
