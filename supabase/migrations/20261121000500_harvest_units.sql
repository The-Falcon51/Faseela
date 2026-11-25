-- Faseela: units of the weighed harvest, decided on the server.
--
--  a) public.oil_allocations gets a `unit` column ('l' = olive oil, liters_ml holds millilitres; 'kg' = weighed
--     harvest, liters_ml holds grams). A trigger fills it from the tree's crop on every insert, and existing rows are
--     backfilled. The app used to read the crop from the public catalogue, which only shows listed trees, so an
--     allocation of a sold-out or unlisted tree had no unit at all. The sponsor's own rows now carry it.
--  b) private.admin_user_detail reports olive oil (millilitres) and weighed harvest (grams) as two separate counts
--     instead of adding millilitres and grams together.
--  c) private.certify_pressing_batch sends 'unit' with the batch_certified / batch_rejected notification, so a
--     weighed harvest (mill_id 'farm') gets harvest wording in the mail instead of "pressing batch".
--  d) private.my_assignments returns each assigned tree's cropCategory, also for unlisted trees, so the farmer's
--     harvest form never offers an olive tree.
--
-- Existing function bodies are changed in place (same pattern as 20261116000140); a missing fragment aborts the
-- migration. Idempotent: a second run changes nothing.
-- Down: alter table public.oil_allocations drop column unit; drop function private.oil_allocation_unit();
--       re-run the original definitions of the three patched functions.

-- a)
alter table public.oil_allocations add column if not exists unit text;
alter table public.oil_allocations drop constraint if exists oil_allocations_unit_check;
alter table public.oil_allocations add constraint oil_allocations_unit_check check (unit in ('l', 'kg'));

create or replace function private.oil_allocation_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.unit := case when (select tp.crop_category from public.trees_public tp where tp.tree_id = new.tree_id) = 'olive'
                   then 'l' else 'kg' end;
  return new;
end;
$$;
revoke all on function private.oil_allocation_unit() from public, anon, authenticated;
drop trigger if exists oil_allocations_unit on public.oil_allocations;
create trigger oil_allocations_unit before insert on public.oil_allocations
  for each row execute function private.oil_allocation_unit();

update public.oil_allocations o
   set unit = case when tp.crop_category = 'olive' then 'l' else 'kg' end
  from public.trees_public tp
 where tp.tree_id = o.tree_id and o.unit is null;
alter table public.oil_allocations alter column unit set not null;

-- b), c), d)
do $$
declare
  c record;
  v_def text;
begin
  for c in select * from (values
    ('admin_user_detail',
     '''oilAllocatedMl'', (select coalesce(sum(o.liters_ml), 0) from public.oil_allocations o where o.user_id = u.id),',
     '''oilAllocatedMl'', (select coalesce(sum(o.liters_ml), 0) from public.oil_allocations o where o.user_id = u.id and o.unit = ''l''),
          ''harvestAllocatedG'', (select coalesce(sum(o.liters_ml), 0) from public.oil_allocations o where o.user_id = u.id and o.unit = ''kg''),'),
    ('certify_pressing_batch',
     '''certificateSerial'', v_serial, ''note'', v_note));',
     '''certificateSerial'', v_serial, ''note'', v_note, ''unit'', case when v_batch.mill_id = ''farm'' then ''kg'' else ''l'' end));'),
    ('my_assignments',
     '''regionEn'', t.region_en)',
     '''regionEn'', t.region_en, ''cropCategory'', t.crop_category)')
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
