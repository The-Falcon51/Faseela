-- Faseela (migration 42): the admin panel can set or clear the oil mill of a tree. Without it the task
-- "tree without mill" could be seen but not resolved in the panel.
create or replace function private.admin_set_tree_mill(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_role('{}'::text[]);
  p jsonb := coalesce(payload, '{}'::jsonb);
  v_tree text := private.req_id(p, 'treeId', '^[A-Za-z0-9_-]{1,80}$');
  v_mill text := nullif(btrim(coalesce(private.opt_text(p, 'millId', 80), '')), '');
  v_before text;
begin
  if v_mill is not null and v_mill !~ '^[A-Za-z0-9_-]{1,80}$' then
    perform private.fail('invalid-argument', 'Field millId is invalid.');
  end if;
  select mill_id into v_before from private.trees where tree_id = v_tree for update;
  if not found then
    perform private.fail('not-found', 'Tree was not found.');
  end if;
  update private.trees set mill_id = v_mill, updated_at = now() where tree_id = v_tree;
  perform private.audit(v_uid, 'tree.mill_changed', 'trees_public/' || v_tree, jsonb_build_object('before', v_before, 'after', v_mill));
  return jsonb_build_object('treeId', v_tree, 'millId', v_mill);
end;
$$;

/** Mill of a tree for the edit form (kept separate so the catalogue record stays unchanged). */
create or replace function private.admin_get_tree_mill(payload jsonb)
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
  return (select jsonb_build_object('treeId', tree_id, 'millId', mill_id) from private.trees where tree_id = v_tree);
end;
$$;

create or replace function public.admin_set_tree_mill(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_set_tree_mill(payload); $$;
create or replace function public.admin_get_tree_mill(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.rate_limit('admin_read', 240, 60); select private.admin_get_tree_mill(payload); $$;
revoke all on function private.admin_set_tree_mill(jsonb), private.admin_get_tree_mill(jsonb), public.admin_set_tree_mill(jsonb), public.admin_get_tree_mill(jsonb) from public, anon, authenticated;
grant execute on function private.admin_set_tree_mill(jsonb), private.admin_get_tree_mill(jsonb), public.admin_set_tree_mill(jsonb), public.admin_get_tree_mill(jsonb) to authenticated;
