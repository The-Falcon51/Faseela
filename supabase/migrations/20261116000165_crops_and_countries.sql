-- Faseela (migration 48): more crops and more countries.
--  a) New crop category 'date' (date palm). Like every non-olive crop it is settled by weight (kg).
--  b) Every tree belongs to a country (ISO 3166-1 alpha-2). Existing trees are in Syria ('SY').
--  c) The admin panel can set crop and country of a tree. The crop cannot change once a harvest or an allocation
--     exists for the tree, because the unit of those amounts (millilitres vs grams) follows from the crop.
alter table public.trees_public drop constraint if exists trees_public_crop_category_check;
alter table public.trees_public add constraint trees_public_crop_category_check
  check (crop_category in ('olive', 'pistachio', 'almond', 'pomegranate', 'walnut', 'date'));
alter table public.trees_public add column if not exists country text not null default 'SY' check (country ~ '^[A-Z]{2}$');
create index if not exists trees_public_country_idx on public.trees_public (country, status);

create or replace function private.admin_set_tree_class(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_crop text := nullif(btrim(coalesce(private.opt_text(p, 'cropCategory', 20), '')), '');
  v_country text := nullif(upper(btrim(coalesce(private.opt_text(p, 'country', 2), ''))), '');
  v_row public.trees_public;
begin
  if v_crop is not null and v_crop not in ('olive', 'pistachio', 'almond', 'pomegranate', 'walnut', 'date') then
    perform private.fail('invalid-argument', 'Field cropCategory is invalid.');
  end if;
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    perform private.fail('invalid-argument', 'Field country is invalid.');
  end if;
  select * into v_row from public.trees_public where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  if v_crop is not null and v_crop <> v_row.crop_category
     and (exists (select 1 from public.pressing_batches where tree_id = v_tree) or exists (select 1 from public.oil_allocations where tree_id = v_tree)) then
    perform private.fail('failed-precondition', 'The crop cannot change after a harvest was recorded for this tree.');
  end if;
  update public.trees_public set crop_category = coalesce(v_crop, crop_category), country = coalesce(v_country, country), updated_at = now() where tree_id = v_tree;
  perform private.audit(v_uid, 'tree.class_changed', 'trees_public/' || v_tree,
    jsonb_build_object('cropBefore', v_row.crop_category, 'cropAfter', coalesce(v_crop, v_row.crop_category), 'countryBefore', v_row.country, 'countryAfter', coalesce(v_country, v_row.country)));
  return jsonb_build_object('treeId', v_tree, 'cropCategory', coalesce(v_crop, v_row.crop_category), 'country', coalesce(v_country, v_row.country));
end;
$$;

create or replace function private.admin_get_tree_class(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  v_tree text := private.req_id(coalesce(payload, '{}'::jsonb), 'treeId', '^[A-Za-z0-9_-]{1,80}$');
begin
  return (select jsonb_build_object('treeId', tree_id, 'cropCategory', crop_category, 'country', country) from public.trees_public where tree_id = v_tree);
end;
$$;

create or replace function public.admin_set_tree_class(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_tree_class(payload); $$;
create or replace function public.admin_get_tree_class(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_get_tree_class(payload); $$;
revoke all on function private.admin_set_tree_class(jsonb), private.admin_get_tree_class(jsonb), public.admin_set_tree_class(jsonb), public.admin_get_tree_class(jsonb) from public, anon, authenticated;
grant execute on function private.admin_set_tree_class(jsonb), private.admin_get_tree_class(jsonb), public.admin_set_tree_class(jsonb), public.admin_get_tree_class(jsonb) to authenticated;
