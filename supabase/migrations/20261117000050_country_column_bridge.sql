-- Bridge between the country registry that was applied to the live project (migrations 20261116000165-180) and the
-- master data model that follows (20261118000100_master_data.sql). Both describe the country of a tree; from here
-- on there is one column and one registry.
--  a) trees_public.country is renamed to country_code (values are kept). Its format check and its old index go:
--     master data adds a foreign key to public.countries and its own index.
--  b) admin_set_tree_class / admin_get_tree_class go: crop and origin are set by admin_set_tree_crop
--     (20261117000100_date_crop.sql) and admin_set_tree_origin (master data).
--  c) The listing gate and the two registry RPCs read the old column, so they go here; the gate comes back on the
--     master data model in 20261121000100_country_model_unified.sql.
-- Safe to run on a database that never had the registry (every step checks first).
-- Down: forward-only once 20261118000100_master_data.sql has run (master data, later migrations and the gate of
--       20261121000100 use country_code, and the Down of master data drops the column with its values).
--       Before that, and only then: alter table public.trees_public rename column country_code to country; then
--       re-run 20261116000165 and 20261116000170. Do not re-run 20261116000180 as it stands: it writes a separate
--       element in front of every receiving account (repaired by 20261121000100).
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trees_public' and column_name = 'country')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trees_public' and column_name = 'country_code') then
    alter table public.trees_public rename column country to country_code;
  end if;
end;
$$;
alter table public.trees_public drop constraint if exists trees_public_country_check;
drop index if exists public.trees_public_country_idx;

drop trigger if exists trees_public_country_gate on public.trees_public;
drop function if exists private.enforce_country_open();
drop function if exists public.admin_set_tree_class(jsonb);
drop function if exists public.admin_get_tree_class(jsonb);
drop function if exists private.admin_set_tree_class(jsonb);
drop function if exists private.admin_get_tree_class(jsonb);
drop function if exists public.admin_list_countries();
drop function if exists public.admin_set_country(jsonb);
drop function if exists private.admin_list_countries();
drop function if exists private.admin_set_country(jsonb);
