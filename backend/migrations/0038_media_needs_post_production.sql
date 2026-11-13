-- 0038_media_needs_post_production.sql
--
-- Additive migration: adds the needs_post_production boolean flag to media_assets.
-- Indicates assets that require manual retouching or post-production processing.
-- Authorized by docs/adr/0038-media-needs-post-production.md.

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS needs_post_production BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_media_assets_needs_post_production
  ON public.media_assets (needs_post_production)
  WHERE needs_post_production;
