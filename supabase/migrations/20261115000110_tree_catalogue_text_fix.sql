-- Faseela (migration 39): data fix for the three launch trees. The English name and variety columns carried the
-- Arabic text and both region columns were empty (the original seed copied the wrong fields). The values below are
-- the ones the app has always shown for these trees. Each row is only touched while it still has the faulty value,
-- so texts edited later in the admin panel are never overwritten. No inventory or price column is changed.
update public.trees_public p
   set name_en = case when p.name_en = p.name then v.name_en else p.name_en end,
       tree_type_en = case when p.tree_type_en = p.tree_type then v.tree_type_en else p.tree_type_en end,
       region = case when coalesce(p.region, '') = '' then v.region else p.region end,
       region_en = case when coalesce(p.region_en, '') = '' then v.region_en else p.region_en end,
       updated_at = now()
  from (values
    ('tree_01', 'The Century Olive - Mountain Guardian', 'Coastal Khodairi Olive', 'طرطوس', 'Tartus'),
    ('tree_02', 'The Golden Sourani - Sector 4', 'Heritage Sourani Olive', 'إدلب', 'Idlib'),
    ('tree_03', 'Houran Qaisi - Red Ruby', 'Irrigated Qaisi Olive', 'درعا', 'Daraa')
  ) as v(tree_id, name_en, tree_type_en, region, region_en)
 where p.tree_id = v.tree_id
   and (p.name_en = p.name or p.tree_type_en = p.tree_type or coalesce(p.region, '') = '' or coalesce(p.region_en, '') = '');
