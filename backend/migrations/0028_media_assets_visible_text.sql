-- Migration 0028: Add visible_text column to media_assets.
-- Preserves OCR text extracted from product logos, nameplates, and labels by AI Vision
-- so it is not lost at the schema boundary and can be consumed by review UI, MCP agents, and SEO.

alter table public.media_assets add column if not exists visible_text text[];
