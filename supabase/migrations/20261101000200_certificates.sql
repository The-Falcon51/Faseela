-- Share certificates: data for the PDF (owner only) and a public verification lookup by serial.
-- Serial = 'FSL-' || year || '-' || first 16 hex chars of the share id (upper case). The share id is a
-- sha256 hex of user:idempotency-key, so the prefix is unguessable and unique in practice; the
-- verifier reveals only non-personal facts (tree, shares, land, issue date, status, holder initials).

create or replace function private.certificate_serial(p_share public.shares)
returns text
language sql
immutable
set search_path = ''
as $$ select 'FSL-' || to_char(p_share.created_at, 'YYYY') || '-' || upper(substr(p_share.id, 1, 16)); $$;

create or replace function private.share_certificate(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id text := private.req_id(coalesce(payload, '{}'::jsonb), 'shareId', '^[0-9a-f]{64}$');
  v_share public.shares;
  v_tree public.trees_public;
  v_holder text;
begin
  select * into v_share from public.shares where id = v_id and (user_id = v_uid or private.has_any_role('{}'::text[]));
  if not found then
    perform private.fail('not-found', 'Share not found.');
  end if;
  select * into v_tree from public.trees_public where tree_id = v_share.tree_id;
  select coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1)) into v_holder from public.profiles where id = v_share.user_id;
  return jsonb_build_object(
    'serial', private.certificate_serial(v_share),
    'shareId', v_share.id,
    'treeId', v_share.tree_id,
    'treeName', coalesce(nullif(v_tree.name_en, ''), nullif(v_tree.name, ''), v_share.tree_id),
    'treeNameAr', coalesce(nullif(v_tree.name, ''), v_share.tree_id),
    'region', coalesce(nullif(v_tree.region_en, ''), nullif(v_tree.region, ''), ''),
    'shareCount', v_share.share_count,
    'totalShares', v_tree.total_shares,
    'includesLand', v_share.includes_land,
    'landAreaSqm', case when v_share.includes_land then v_tree.land_area_sqm else null end,
    'purchasePriceMinor', v_share.purchase_price_minor,
    'currency', v_share.currency,
    'status', v_share.status,
    'holderName', coalesce(v_holder, 'Faseela member'),
    'issuedAt', private.epoch_ms(v_share.created_at)
  );
end;
$$;

-- Anonymous verification: {serial}
create or replace function private.verify_certificate(payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_serial text := upper(btrim(coalesce(private.opt_text(coalesce(payload, '{}'::jsonb), 'serial', 40), '')));
  v_prefix text;
  v_year text;
  v_share public.shares;
  v_tree public.trees_public;
  v_initials text;
begin
  if v_serial !~ '^FSL-[0-9]{4}-[0-9A-F]{16}$' then
    return jsonb_build_object('valid', false, 'reason', 'format');
  end if;
  v_year := substr(v_serial, 5, 4);
  v_prefix := lower(substr(v_serial, 10, 16));
  select * into v_share from public.shares
   where id like v_prefix || '%' and to_char(created_at, 'YYYY') = v_year
   limit 1;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'unknown');
  end if;
  select * into v_tree from public.trees_public where tree_id = v_share.tree_id;
  select string_agg(upper(left(w, 1)), '.') || '.' into v_initials
    from regexp_split_to_table(coalesce((select nullif(btrim(display_name), '') from public.profiles where id = v_share.user_id), 'F M'), '\s+') w
   where w <> '';
  return jsonb_build_object(
    'valid', true,
    'serial', v_serial,
    'treeId', v_share.tree_id,
    'treeName', coalesce(nullif(v_tree.name_en, ''), nullif(v_tree.name, ''), v_share.tree_id),
    'treeNameAr', coalesce(nullif(v_tree.name, ''), v_share.tree_id),
    'shareCount', v_share.share_count,
    'totalShares', v_tree.total_shares,
    'includesLand', v_share.includes_land,
    'status', v_share.status,
    'holderInitials', coalesce(v_initials, ''),
    'issuedAt', private.epoch_ms(v_share.created_at)
  );
end;
$$;

create or replace function public.share_certificate(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.share_certificate(payload); $$;
create or replace function public.verify_certificate(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.verify_certificate(payload); $$;

revoke all on function private.certificate_serial(public.shares), private.share_certificate(jsonb), private.verify_certificate(jsonb),
  public.share_certificate(jsonb), public.verify_certificate(jsonb) from public, anon, authenticated;
grant execute on function private.share_certificate(jsonb), public.share_certificate(jsonb) to authenticated;
grant execute on function private.verify_certificate(jsonb), public.verify_certificate(jsonb) to anon, authenticated;
