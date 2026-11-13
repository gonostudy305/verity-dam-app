-- Migration 0035: Add composite index for efficient channel-specific usage queries and LRU rotation
create index if not exists idx_media_usages_asset_channel_date
  on public.media_usages (
    media_asset_id,
    lower(channel),
    used_at desc
  );
