-- 0040_sku_references_image_category.sql
-- Reference promotion writes the three-way image taxonomy used by the matcher.
-- Older native baselines did not carry this additive column even though the
-- review and worker paths already populate it; keep the upgrade safe for both
-- fresh and existing databases.

ALTER TABLE public.sku_references
  ADD COLUMN IF NOT EXISTS image_category TEXT NOT NULL DEFAULT 'STUDIO';

ALTER TABLE public.sku_references
  DROP CONSTRAINT IF EXISTS sku_references_image_category_ck;

ALTER TABLE public.sku_references
  ADD CONSTRAINT sku_references_image_category_ck
  CHECK (image_category IN ('REAL', 'STUDIO', 'DESIGN'));
