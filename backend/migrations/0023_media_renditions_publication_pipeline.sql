-- 0023_media_renditions_publication_pipeline.sql
-- Canonical Media Publication Pipeline (Image SEO V2)
-- Authorized by ADR at plans/2026-09-07-canonical-media-publication-pipeline/ADR-0023-media-renditions.md

create table if not exists public.media_renditions (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  purpose text not null check (purpose in ('web-responsive', 'social-og', 'square', 'thumbnail')),
  format text not null check (format in ('webp', 'jpeg', 'png')),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  size_bytes bigint not null check (size_bytes > 0),
  cdn_key text not null unique,
  cdn_url text not null,
  mime_type text not null,
  rendition_fingerprint text not null,
  metadata_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_renditions_asset_purpose_format_width_unq unique (media_asset_id, purpose, format, width),
  constraint media_renditions_mime_format_ck check (
    (format = 'webp' and mime_type = 'image/webp') or
    (format = 'jpeg' and mime_type = 'image/jpeg') or
    (format = 'png' and mime_type = 'image/png')
  )
);

create index if not exists idx_media_renditions_asset_lookup 
  on public.media_renditions(media_asset_id, purpose, width);
