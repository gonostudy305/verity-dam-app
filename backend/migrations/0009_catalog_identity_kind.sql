-- Keep machine SKU codes distinct from readable model names imported from
-- WooCommerce. The raw matching key remains backward compatible, while the
-- product catalog exposes the identity kind explicitly to the reviewer/UI.
alter table public.verity_products
  add column if not exists catalog_sku_kind text not null default 'unknown';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'verity_products_catalog_sku_kind_ck'
  ) then
    alter table public.verity_products
      add constraint verity_products_catalog_sku_kind_ck
      check (catalog_sku_kind in ('machine_code', 'model_name', 'missing', 'unknown'));
  end if;
end
$$;

update public.verity_products
set catalog_sku_kind = case
  when nullif(trim(primary_sku), '') is null then 'missing'
  when trim(primary_sku) ~ '^[A-Za-z0-9_.\-/]+$' then 'machine_code'
  else 'model_name'
end
where catalog_sku_kind = 'unknown';

create index if not exists idx_verity_products_catalog_sku_kind
  on public.verity_products (catalog_sku_kind) where is_searchable;
