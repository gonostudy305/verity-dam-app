-- 0043_product_intake_enrichment.sql
--
-- Enrich the product-intake declaration flow so contributors can supply the
-- fields the reference-embedding corpus actually needs:
--   * product-level context (category, space/room)
--   * per-image reference labels: role (HERO/ANGLE), image_category
--     (REAL/STUDIO/DESIGN) and capture angle.
-- The uploader proposes; the reviewer confirms on approval, and the confirmed
-- labels flow into public.sku_references (reference_role, image_category)
-- when a reference image is promoted (see native_gateway._complete_product_intake_reference).
--
-- Every column is additive and nullable so open intakes, history rows and the
-- existing guard trigger (trg_guard_open_product_intake_asset, migration 0037)
-- are unaffected. No SQL function changes: the reference "RPC" is dispatched in
-- Python, not PL/pgSQL.

ALTER TABLE public.product_intakes
  ADD COLUMN IF NOT EXISTS proposed_category TEXT NULL,
  ADD COLUMN IF NOT EXISTS proposed_space TEXT NULL;

ALTER TABLE public.product_intake_assets
  ADD COLUMN IF NOT EXISTS proposed_role TEXT NULL,
  ADD COLUMN IF NOT EXISTS proposed_image_category TEXT NULL,
  ADD COLUMN IF NOT EXISTS proposed_angle TEXT NULL,
  ADD COLUMN IF NOT EXISTS confirmed_role TEXT NULL,
  ADD COLUMN IF NOT EXISTS confirmed_image_category TEXT NULL;

-- image_category uses the same closed vocabulary as public.sku_references
-- (migration 0040). reference_role is intentionally left unconstrained at the
-- DB level to match sku_references.reference_role, which has no CHECK; the
-- application layer validates the HERO/ANGLE choice the UI offers.
ALTER TABLE public.product_intake_assets
  DROP CONSTRAINT IF EXISTS product_intake_assets_proposed_image_category_ck;
ALTER TABLE public.product_intake_assets
  ADD CONSTRAINT product_intake_assets_proposed_image_category_ck
  CHECK (proposed_image_category IS NULL OR proposed_image_category IN ('REAL', 'STUDIO', 'DESIGN'));

ALTER TABLE public.product_intake_assets
  DROP CONSTRAINT IF EXISTS product_intake_assets_confirmed_image_category_ck;
ALTER TABLE public.product_intake_assets
  ADD CONSTRAINT product_intake_assets_confirmed_image_category_ck
  CHECK (confirmed_image_category IS NULL OR confirmed_image_category IN ('REAL', 'STUDIO', 'DESIGN'));
