-- Faseela (migration 45): the date palm becomes the sixth crop, and the admin panel can set the crop of a tree.
-- Until now every tree created in the panel was stored as 'olive' (admin_create_tree writes the default), so a
-- pistachio or date tree could only be added by SQL. The crop is set through its own function, like the mill.
-- Rollback: drop the two functions and their public wrappers, then restore the five-value check constraint
-- (only possible while no tree has crop_category = 'date').
alter table public.trees_public drop constraint if exists trees_public_crop_category_check;
alter table public.trees_public add constraint trees_public_crop_category_check
  check (crop_category in ('olive', 'pistachio', 'almond', 'pomegranate', 'date', 'walnut'));

/**
 * Sets the crop of a tree. Allowed only while nothing is sold or reserved: afterwards the crop is part of what
 * the holders bought and can no longer change.
 */
create or replace function private.admin_set_tree_crop(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_crop text := private.opt_text(p, 'cropCategory', 20);
  v_row private.trees;
  v_before text;
begin
  if v_crop is null or v_crop not in ('olive', 'pistachio', 'almond', 'pomegranate', 'date', 'walnut') then
    perform private.fail('invalid-argument', 'Field cropCategory is invalid.');
  end if;
  select * into v_row from private.trees where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  select crop_category into v_before from public.trees_public where tree_id = v_tree;
  if v_before is distinct from v_crop and v_row.sold_shares + v_row.reserved_shares > 0 then
    perform private.fail('failed-precondition', 'The crop cannot change once shares are sold or reserved.');
  end if;
  update public.trees_public set crop_category = v_crop, updated_at = now() where tree_id = v_tree;
  perform private.audit(v_uid, 'tree.crop_changed', 'trees_public/' || v_tree, jsonb_build_object('before', v_before, 'after', v_crop));
  return jsonb_build_object('treeId', v_tree, 'cropCategory', v_crop);
end;
$$;

/** Crop of a tree for the edit form (unlisted trees are not readable through the public table). */
create or replace function private.admin_get_tree_crop(payload jsonb)
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
  return (select jsonb_build_object('treeId', tree_id, 'cropCategory', crop_category) from public.trees_public where tree_id = v_tree);
end;
$$;

create or replace function public.admin_set_tree_crop(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_tree_crop(payload); $$;
create or replace function public.admin_get_tree_crop(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_get_tree_crop(payload); $$;
revoke all on function private.admin_set_tree_crop(jsonb), private.admin_get_tree_crop(jsonb), public.admin_set_tree_crop(jsonb), public.admin_get_tree_crop(jsonb) from public, anon, authenticated;
grant execute on function private.admin_set_tree_crop(jsonb), private.admin_get_tree_crop(jsonb), public.admin_set_tree_crop(jsonb), public.admin_get_tree_crop(jsonb) to authenticated;
