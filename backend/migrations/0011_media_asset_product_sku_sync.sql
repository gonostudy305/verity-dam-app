-- =============================================================================
-- A2 backbone — native SKU -> product sync/backfill (app-layer actor, no auth.uid)
--
-- The A2 tables already exist in 0003 (verity_products, media_asset_products,
-- uq_native_media_asset_primary_product, sku_reference_embeddings.product_id)
-- and 0009 added verity_products.catalog_sku_kind. What was still missing on the
-- native path is the *write wiring*: nothing kept media_asset_products in sync
-- with media_assets.sku, and no primary links existed for assets that already
-- carry a SKU. This migration adds:
--   1. supporting indexes for the resolver/join paths
--   2. a one-time backfill (draft products, reference product_id, primary links)
--   3. two triggers on media_assets.sku that keep the primary link in sync
--
-- Native adaptation of the Supabase-compat design (auth.uid()/RLS/security
-- definer are absent here):
--   * machine-vs-human is decided by the app and passed in as the custom GUC
--     verity.sync_actor ('human' | default 'machine'). The DB only *enforces* the
--     state machine; it never keys on auth.uid(). The Next.js review route sets
--     `set local verity.sync_actor = 'human'` on approval; the Python worker
--     (complete_media_analysis) leaves it unset => machine.
--   * no RLS/policies and no SECURITY DEFINER: the application role owns these
--     tables and has full DML.
--
-- Invariants preserved:
--   * No product is inferred by Vision. media_assets.sku is only written by the
--     reference-embedding match path (complete_media_analysis p_sku_suggestion)
--     or a reviewer's explicit correction; the trigger reads media_assets.sku,
--     so the link inherits that boundary. The two large RPCs are left untouched.
--   * Backward-compatible dual-running: media_assets.sku/brand/category stay
--     readable and writable; nothing is dropped.
-- =============================================================================

-- 1. Supporting indexes (0003 created the tables/columns but not these) --------

create index if not exists idx_verity_products_primary_sku_lower
  on public.verity_products (lower(primary_sku));
create index if not exists idx_verity_products_code_lower
  on public.verity_products (lower(code));
create index if not exists idx_verity_products_lifecycle
  on public.verity_products (lifecycle) where is_searchable;

create index if not exists idx_media_asset_products_asset
  on public.media_asset_products (media_asset_id);
create index if not exists idx_media_asset_products_product
  on public.media_asset_products (product_id);
create index if not exists idx_media_asset_products_review
  on public.media_asset_products (review_state, created_at desc);

create index if not exists idx_sku_reference_product
  on public.sku_reference_embeddings (product_id) where is_active;

-- 2. Backfill -----------------------------------------------------------------

-- 2a. A draft product for every distinct SKU currently in use (assets + refs)
--     that does not already resolve to an existing (e.g. catalog-imported)
--     product. code = the raw SKU (distinct => unique); brand borrowed from any
--     asset. Guarding on "no existing product" avoids a unique(code) collision
--     with catalog rows that already use the SKU as their code.
insert into public.verity_products
  (code, display_name, brand, primary_sku, lifecycle, source_system, external_id, catalog_sku_kind)
select
  s.sku_key,
  s.sku_key,
  coalesce(b.brand, 'unknown'),
  s.sku_key,
  'draft',
  'backfill',
  s.sku_key,
  case when s.sku_key ~ '^[A-Za-z0-9_.\-/]+$' then 'machine_code' else 'model_name' end
from (
  select distinct trim(sku) as sku_key
  from (
    select sku from public.media_assets where sku is not null and trim(sku) <> ''
    union
    select sku from public.sku_reference_embeddings where sku is not null and trim(sku) <> ''
  ) u
) s
left join lateral (
  select nullif(trim(a.brand), '') as brand
  from public.media_assets a
  where trim(a.sku) = s.sku_key and nullif(trim(a.brand), '') is not null
  limit 1
) b on true
where not exists (
  select 1 from public.verity_products p
  where lower(p.code) = lower(s.sku_key)
     or lower(p.primary_sku) = lower(s.sku_key)
     or exists (select 1 from unnest(p.aliases) alias where lower(alias) = lower(s.sku_key))
)
on conflict (source_system, external_id) do nothing;

-- 2b. Point the reference set at its product (any matching product, not only
--     backfill rows). product_id is nullable, so unmatched SKUs stay null.
update public.sku_reference_embeddings r
set product_id = (
  select p.id from public.verity_products p
  where p.lifecycle <> 'discontinued'
    and (lower(p.primary_sku) = lower(trim(r.sku))
         or lower(p.code) = lower(trim(r.sku))
         or exists (select 1 from unnest(p.aliases) alias where lower(alias) = lower(trim(r.sku))))
  order by (p.lifecycle = 'active') desc, p.created_at asc
  limit 1
)
where r.product_id is null and r.sku is not null and trim(r.sku) <> '';

-- 2c. A primary link for every live asset that already carries a SKU.
--     Approved assets => 'catalog_import' + 'confirmed' (a human has signed off).
--     Pending/draft assets => 'sku_embedding' + 'draft' so subsequent machine
--     re-analysis can update them without divergence.
insert into public.media_asset_products
  (media_asset_id, product_id, role, source, review_state, confidence)
select
  a.id,
  p.id,
  'primary',
  case when a.review_state = 'approved' then 'catalog_import' else 'sku_embedding' end,
  case when a.review_state = 'approved' then 'confirmed' else 'draft' end,
  least(greatest(coalesce((a.ai_confidence ->> 'sku')::numeric, 0) / 100.0, 0), 1)::real
from public.media_assets a
join lateral (
  select p.id from public.verity_products p
  where p.lifecycle <> 'discontinued'
    and (lower(p.primary_sku) = lower(trim(a.sku))
         or lower(p.code) = lower(trim(a.sku))
         or exists (select 1 from unnest(p.aliases) alias where lower(alias) = lower(trim(a.sku))))
  order by (p.lifecycle = 'active') desc, p.created_at asc
  limit 1
) p on true
where a.sku is not null and trim(a.sku) <> '' and a.deleted_at is null
on conflict (media_asset_id, product_id) do nothing;

-- 3. Write wiring -------------------------------------------------------------

-- 3a. BEFORE UPDATE guard: a machine pass may not overwrite (or clear) a SKU
--     that already backs a human-confirmed product link. Human writes
--     (verity.sync_actor = 'human') pass through untouched.
create or replace function public.guard_confirmed_sku_on_media_assets()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_actor         text := coalesce(nullif(current_setting('verity.sync_actor', true), ''), 'machine');
  v_has_confirmed boolean;
begin
  if v_actor <> 'human' then
    select bool_or(role = 'primary' and review_state = 'confirmed')
    into v_has_confirmed
    from public.media_asset_products
    where media_asset_id = NEW.id;

    if coalesce(v_has_confirmed, false) then
      NEW.sku := OLD.sku;  -- machine cannot override a human-confirmed SKU
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists media_assets_guard_confirmed_sku on public.media_assets;
create trigger media_assets_guard_confirmed_sku
  before update of sku on public.media_assets
  for each row execute function public.guard_confirmed_sku_on_media_assets();

-- 3b. AFTER INSERT/UPDATE sync: keep the primary product link aligned with
--     media_assets.sku. Machine writes create/replace a draft link; human
--     writes create/confirm the link and supersede any prior primary.
create or replace function public.sync_primary_product_from_sku()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_sku           text := nullif(trim(NEW.sku), '');
  v_actor         text := coalesce(nullif(current_setting('verity.sync_actor', true), ''), 'machine');
  v_is_human      boolean := (v_actor = 'human');
  v_actor_id      uuid;
  v_product_id    uuid;
  v_confidence    real;
  v_has_confirmed boolean;
  v_source        text;
  v_state         text;
begin
  select bool_or(role = 'primary' and review_state = 'confirmed')
  into v_has_confirmed
  from public.media_asset_products
  where media_asset_id = NEW.id;

  -- Case A: SKU cleared (null/empty)
  if v_sku is null then
    if v_is_human then
      delete from public.media_asset_products
      where media_asset_id = NEW.id and role = 'primary';
    elsif not coalesce(v_has_confirmed, false) then
      delete from public.media_asset_products
      where media_asset_id = NEW.id and role = 'primary' and review_state = 'draft';
    end if;
    return NEW;
  end if;

  -- Case B: a machine pass never overrides a human-confirmed anchor
  if not v_is_human and coalesce(v_has_confirmed, false) then
    return NEW;
  end if;

  -- Resolve the product entity from the SKU
  select id into v_product_id
  from public.verity_products
  where lifecycle <> 'discontinued'
    and (lower(primary_sku) = lower(v_sku)
         or lower(code) = lower(v_sku)
         or exists (select 1 from unnest(aliases) alias where lower(alias) = lower(v_sku)))
  order by (lifecycle = 'active') desc, created_at asc
  limit 1;

  -- Unknown SKU => create a draft product (reconciled to the catalog by
  -- code/alias on the next Product-DB sync) rather than dropping the link.
  if v_product_id is null then
    insert into public.verity_products
      (code, display_name, brand, primary_sku, lifecycle, source_system, external_id, catalog_sku_kind)
    values (
      v_sku, v_sku, coalesce(nullif(trim(NEW.brand), ''), 'unknown'), v_sku, 'draft', 'auto_sku', v_sku,
      case when v_sku ~ '^[A-Za-z0-9_.\-/]+$' then 'machine_code' else 'model_name' end
    )
    on conflict (code) do update set updated_at = now()
    returning id into v_product_id;
  end if;

  v_confidence := least(greatest(coalesce((NEW.ai_confidence ->> 'sku')::numeric, 0) / 100.0, 0), 1)::real;

  if v_is_human then
    v_source := 'human';
    v_state  := 'confirmed';
    -- Optional attribution; native user ids are not necessarily uuids, so an
    -- invalid/absent value simply leaves created_by null (audit lives elsewhere).
    begin
      v_actor_id := nullif(current_setting('verity.sync_actor_id', true), '')::uuid;
    exception when others then
      v_actor_id := null;
    end;
    delete from public.media_asset_products
    where media_asset_id = NEW.id and role = 'primary' and product_id <> v_product_id;
  else
    v_source := 'sku_embedding';
    v_state  := 'draft';
    delete from public.media_asset_products
    where media_asset_id = NEW.id and role = 'primary'
      and review_state = 'draft' and product_id <> v_product_id;
  end if;

  insert into public.media_asset_products
    (media_asset_id, product_id, role, confidence, source, review_state, created_by)
  values (NEW.id, v_product_id, 'primary', v_confidence, v_source, v_state,
          case when v_is_human then v_actor_id else null end)
  on conflict (media_asset_id, product_id) do update
  set role         = 'primary',
      confidence   = excluded.confidence,
      source       = excluded.source,
      created_by   = coalesce(excluded.created_by, public.media_asset_products.created_by),
      review_state = case
        -- never downgrade a confirmed link back to draft on a machine pass
        when public.media_asset_products.review_state = 'confirmed' and excluded.review_state = 'draft'
          then 'confirmed'
        else excluded.review_state
      end;

  return NEW;
end;
$$;

comment on function public.sync_primary_product_from_sku() is
  'Keeps media_asset_products primary in sync with media_assets.sku. verity.sync_actor=''human'' => confirmed/human link (reviewer); default => machine draft (sku_embedding). Never overrides a human-confirmed link.';

drop trigger if exists media_assets_sync_primary_product on public.media_assets;
create trigger media_assets_sync_primary_product
  after insert or update of sku on public.media_assets
  for each row execute function public.sync_primary_product_from_sku();
