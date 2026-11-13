-- Farmers and mill operators need their own active assignments to file reports from the mobile quick form.
create or replace function private.my_assignments()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'trees', coalesce((select jsonb_agg(jsonb_build_object('treeId', t.tree_id, 'name', t.name, 'nameEn', t.name_en, 'region', t.region, 'regionEn', t.region_en)
                                        order by a.assigned_at)
                         from public.farmer_assignments a join public.trees_public t on t.tree_id = a.tree_id
                        where a.farmer_uid = (select auth.uid()) and a.revoked_at is null), '[]'::jsonb),
    'mills', coalesce((select jsonb_agg(m.mill_id order by m.assigned_at)
                         from public.mill_assignments m
                        where m.operator_uid = (select auth.uid()) and m.revoked_at is null), '[]'::jsonb));
$$;
create or replace function public.my_assignments() returns jsonb
language sql security invoker set search_path = '' as $$ select private.my_assignments(); $$;
revoke all on function private.my_assignments(), public.my_assignments() from public, anon, authenticated;
grant execute on function private.my_assignments(), public.my_assignments() to authenticated;
