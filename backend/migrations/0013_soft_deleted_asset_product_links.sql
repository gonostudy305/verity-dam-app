-- Migration 0013: Clean and deactivate media_asset_products for soft-deleted assets
-- Ensure deleted assets never hold active/operational primary links.

-- 1. Backfill existing soft-deleted assets in media_asset_products
update public.media_asset_products map
   set review_state = 'rejected',
       source = case when map.source = 'human' then map.source else 'soft_deleted' end
  from public.media_assets a
 where a.id = map.media_asset_id
   and a.deleted_at is not null
   and map.role = 'primary'
   and map.review_state <> 'rejected';

-- 2. Update trigger function to also handle deleted_at
create or replace function public.sync_primary_product_from_sku()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_sku           text := nullif(trim(new.sku), '');
  v_actor         text := case when current_setting('verity.sync_actor', true) = 'human'
                               then 'human' else 'machine' end;
  v_is_human      boolean := (v_actor = 'human');
  v_actor_id      uuid;
  v_product_id    uuid;
  v_confidence    real := 0;
  v_confidence_raw text := nullif(trim(new.ai_confidence ->> 'sku'), '');
  v_has_confirmed boolean;
  v_source        text;
  v_state         text;
begin
  -- Serialize all writers for one asset.
  perform pg_advisory_xact_lock(hashtextextended(new.id::text, 0));

  -- Soft-deleted or rejected assets must not maintain operational primary links.
  if new.deleted_at is not null or new.review_state = 'rejected' then
    update public.media_asset_products
       set review_state = 'rejected',
           source = case
             when new.deleted_at is not null and source <> 'human' then 'soft_deleted'
             when source = 'human' then source
             else 'review_rejected'
           end
     where media_asset_id = new.id
       and role = 'primary'
       and review_state <> 'rejected';
    return new;
  end if;

  select bool_or(role = 'primary' and review_state = 'confirmed')
    into v_has_confirmed
    from public.media_asset_products
   where media_asset_id = new.id;

  -- A machine pass cannot override a human-confirmed anchor.
  if not v_is_human and coalesce(v_has_confirmed, false) then
    return new;
  end if;

  if v_sku is null then
    if v_is_human then
      delete from public.media_asset_products
       where media_asset_id = new.id and role = 'primary';
    elsif not coalesce(v_has_confirmed, false) then
      delete from public.media_asset_products
       where media_asset_id = new.id and role = 'primary' and review_state = 'draft';
    end if;
    return new;
  end if;

  -- Resolve only searchable lifecycle entities.
  select p.id into v_product_id
    from public.verity_products p
   where p.lifecycle <> 'discontinued'
     and (lower(p.primary_sku) = lower(v_sku)
       or lower(p.code) = lower(v_sku)
       or exists (select 1 from unnest(p.aliases) alias where lower(alias) = lower(v_sku)))
   order by (p.lifecycle = 'active') desc, p.created_at asc
   limit 1;

  if v_product_id is null then
    if not exists (
      select 1 from public.verity_products existing
       where lower(existing.code) = lower(v_sku)
          or lower(existing.primary_sku) = lower(v_sku)
          or exists (select 1 from unnest(existing.aliases) alias where lower(alias) = lower(v_sku))
    ) then
      insert into public.verity_products
        (code, display_name, brand, primary_sku, lifecycle, source_system, external_id, catalog_sku_kind)
      values (
        v_sku, v_sku, coalesce(nullif(trim(new.brand), ''), 'unknown'), v_sku,
        'draft', 'auto_sku', v_sku,
        case when v_sku ~ '^[-A-Za-z0-9_./]+$' then 'machine_code' else 'model_name' end
      )
      on conflict (code) do nothing;
    end if;

    select p.id into v_product_id
      from public.verity_products p
     where p.lifecycle <> 'discontinued'
       and lower(p.code) = lower(v_sku)
     order by (p.lifecycle = 'active') desc, p.created_at asc
     limit 1;
  end if;

  if v_product_id is null then
    if v_is_human then
      delete from public.media_asset_products
       where media_asset_id = new.id and role = 'primary';
    else
      delete from public.media_asset_products
       where media_asset_id = new.id and role = 'primary' and review_state = 'draft';
    end if;
    return new;
  end if;

  if v_confidence_raw ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' then
    begin
      v_confidence := least(greatest(v_confidence_raw::numeric / 100, 0), 1)::real;
    exception when others then
      v_confidence := 0;
    end;
  end if;

  if v_is_human then
    v_source := 'human';
    v_state := 'confirmed';
    begin
      v_actor_id := nullif(current_setting('verity.sync_actor_id', true), '')::uuid;
    exception when others then
      v_actor_id := null;
    end;
    delete from public.media_asset_products
     where media_asset_id = new.id and role = 'primary' and product_id <> v_product_id;
  else
    v_source := 'sku_embedding';
    v_state := 'draft';
    delete from public.media_asset_products
     where media_asset_id = new.id and role = 'primary'
       and review_state = 'draft' and product_id <> v_product_id;
  end if;

  insert into public.media_asset_products
    (media_asset_id, product_id, role, confidence, source, review_state, created_by)
  values (new.id, v_product_id, 'primary', v_confidence, v_source, v_state,
          case when v_is_human then v_actor_id else null end)
  on conflict (media_asset_id, product_id) do update
     set role = 'primary',
         confidence = excluded.confidence,
         source = excluded.source,
         created_by = coalesce(excluded.created_by, public.media_asset_products.created_by),
         review_state = case
           when public.media_asset_products.review_state = 'confirmed'
                and excluded.review_state = 'draft' then 'confirmed'
           else excluded.review_state
         end;

  return new;
end;
$$;

-- 3. Update trigger to fire on deleted_at updates as well
drop trigger if exists media_assets_sync_primary_product on public.media_assets;
create trigger media_assets_sync_primary_product
  after insert or update of sku, review_state, deleted_at on public.media_assets
  for each row execute function public.sync_primary_product_from_sku();

comment on function public.sync_primary_product_from_sku() is
  'Native SKU sync hardened in 0013: handles deleted_at to deactivate product links for soft-deleted assets.';
