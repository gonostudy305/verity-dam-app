-- Refresh unreviewed queue items after the catalog identity backfill.
-- Approved/rejected items are intentionally left untouched.
update public.media_assets a
set brand = p.brand,
    ai_confidence = coalesce(a.ai_confidence, '{}'::jsonb)
      || jsonb_build_object('brand', 0.95)
from public.review_queue q
join public.verity_products p
  on lower(p.primary_sku) = lower(q.sku_match->>'sku')
where q.media_asset_id = a.id
  and q.status = 'pending'
  and a.deleted_at is null
  and nullif(trim(p.brand), '') is not null
  and lower(trim(p.brand)) <> 'unknown';

update public.review_queue q
set sku_match = coalesce(q.sku_match, '{}'::jsonb)
      || jsonb_build_object(
        'catalog_identity',
        jsonb_strip_nulls(jsonb_build_object(
          'brand', p.brand,
          'model_name', p.model_name,
          'display_name', p.display_name,
          'catalog_sku_kind', p.catalog_sku_kind
        ))
      ),
    metadata_draft = case
      when nullif(trim(p.brand), '') is not null and lower(trim(p.brand)) <> 'unknown'
        then coalesce(q.metadata_draft, '{}'::jsonb)
          || jsonb_build_object('brand', p.brand, 'brand_confidence', 0.95)
      else q.metadata_draft
    end
from public.verity_products p
where q.status = 'pending'
  and lower(p.primary_sku) = lower(q.sku_match->>'sku');
