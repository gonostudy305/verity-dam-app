-- Migration 0026: Add source import provenance columns and unique constraint to media_assets
--
-- Enables tracking bulk-imported assets from Google Drive, Zalo, and external sources
-- with strict idempotency (source_provider + source_file_id) and batch rollback support.
--
-- Approved in plan: Dev curated bulk-import -> dam.verity.internal hub (2026-09-08)

ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS source_file_id text,
  ADD COLUMN IF NOT EXISTS source_modified_time timestamptz,
  ADD COLUMN IF NOT EXISTS import_batch_id text,
  ADD COLUMN IF NOT EXISTS source_md5 text;

-- Exactly-once guarantee per external file:
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_source_file
ON public.media_assets(source_provider, source_file_id)
WHERE source_provider IS NOT NULL AND source_file_id IS NOT NULL;

-- Fast batch audit / rollback lookup:
CREATE INDEX IF NOT EXISTS idx_media_assets_import_batch
ON public.media_assets(import_batch_id)
WHERE import_batch_id IS NOT NULL;
