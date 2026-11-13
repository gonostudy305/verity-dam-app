-- 0036_sku_reference_primary_integrity.sql
-- Repair and protect the primary anchor required by the SKU matcher.

WITH ranked AS (
    SELECT
        reference_id,
        row_number() OVER (
            PARTITION BY sku
            ORDER BY
                is_primary DESC,
                (reference_role = 'HERO') DESC,
                (curation_status = 'REVIEWED') DESC,
                quality_score DESC NULLS LAST,
                created_at ASC,
                reference_id ASC
        ) AS rank_in_sku
    FROM public.sku_references
    WHERE is_active = true
      AND match_eligible = true
)
UPDATE public.sku_references AS r
SET is_primary = (ranked.rank_in_sku = 1),
    updated_at = now()
FROM ranked
WHERE r.reference_id = ranked.reference_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sku_references_one_primary_eligible
    ON public.sku_references (sku)
    WHERE is_active = true
      AND match_eligible = true
      AND is_primary = true;
