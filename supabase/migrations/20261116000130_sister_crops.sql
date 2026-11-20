-- Faseela (migration 44): the four sister crops become real catalogue entries. The ids match the entries the web
-- app already shows (tree_12, tree_14, tree_15, tree_16); texts, prices and images are the ones shown there.
-- They start UNLISTED: nobody can buy them until an admin has checked the figures and switches them on.
-- No land option, no farm, no mill yet. Harvest handling for non-olive crops is not defined yet (the oil
-- allocation is olive-specific), so these trees can be sold but not yet settled after harvest.
alter table public.trees_public drop constraint if exists trees_public_crop_category_check;
alter table public.trees_public add constraint trees_public_crop_category_check
  check (crop_category in ('olive', 'pistachio', 'almond', 'pomegranate', 'walnut'));

with v(tree_id, crop, name, name_en, region, region_en, tree_type, tree_type_en, planted_year, yield_kg, images, price_minor) as (values
  ('tree_12', 'pistachio', 'أم الذهب الأخضر - فستق مورك العاشوري المعمر', 'Mother of Green Gold - Mork Ashouri Pistachio', 'حماة', 'Hama',
   'فستق حلبي عاشوري (حمراوي)', 'Ashouri Aleppo Pistachio', 1974, 38, array['images/tree_pistachio_mork.webp', 'images/pistachio_clusters_macro.webp'], 4800),
  ('tree_14', 'almond', 'زهرة المخرم - اللوز السوري الفرك المعمر', 'Blossom of Mukharram - Syrian Soft-Shell Almond', 'حمص', 'Homs',
   'لوز بلدي فرك عالي الزيوت', 'Syrian Native Soft-Shell Almond', 2008, 28, array['images/tree_almond_homs.webp'], 2900),
  ('tree_15', 'pomegranate', 'درة حوران - رمان اليرموك السكري العصيري', 'Houran Jewel - Yarmouk Sweet Pomegranate', 'درعا', 'Daraa',
   'رمان فرنسي عصيري فاخر', 'Premium Yarmouk Sweet Pomegranate', 2012, 58, array['images/pomegranate_tree_daraa.webp'], 2400),
  ('tree_16', 'walnut', 'سيدة الظلال - جوز بردى البلدي الشاهق', 'Lady of Shadows - Barada Valley Heritage Walnut', 'ريف دمشق', 'Rural Damascus',
   'جوز بلدي سوري معمر', 'Syrian Mountain Heritage Walnut', 1965, 45, array['images/walnut_tree_barada.webp'], 5200)
), ins as (
  insert into public.trees_public (tree_id, status, crop_category, name, name_en, region, region_en, tree_type, tree_type_en,
    planted_year, estimated_annual_yield_kg, images, total_shares, available_shares, price_per_share_minor,
    land_price_minor, has_land_option, land_area_sqm, currency, updated_at)
  select tree_id, 'unlisted', crop, name, name_en, region, region_en, tree_type, tree_type_en, planted_year, yield_kg, images, 4, 4, price_minor, 0, false, 0, 'USD', now()
    from v
  on conflict (tree_id) do nothing
  returning tree_id, price_per_share_minor
)
insert into private.trees (tree_id, total_shares, price_per_share_minor, land_price_minor, currency)
select tree_id, 4, price_per_share_minor, 0, 'USD' from ins
on conflict (tree_id) do nothing;
