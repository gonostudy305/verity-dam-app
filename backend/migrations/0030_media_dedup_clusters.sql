-- Persisted duplicate-workbench state.  media_dedup_matches remains the
-- directional evidence ledger; reviewer decisions live in side tables so a
-- future detector rebuild cannot erase or reinterpret human decisions.

create table if not exists public.media_dedup_clusters (
  id uuid primary key default gen_random_uuid(),
  canonical_media_asset_id uuid references public.media_assets(id) on delete set null,
  tier text not null check (tier in ('exact', 'near', 'similar')),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution text check (resolution in ('keep_one', 'keep_all', 'not_duplicate')),
  method_summary jsonb not null default '{}'::jsonb,
  member_count integer not null default 0 check (member_count >= 2),
  estimated_reclaim_bytes bigint not null default 0 check (estimated_reclaim_bytes >= 0),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'open') = (resolution is null))
);

create table if not exists public.media_dedup_cluster_members (
  cluster_id uuid not null references public.media_dedup_clusters(id) on delete cascade,
  media_asset_id uuid not null references public.media_assets(id) on delete cascade,
  variant text not null check (variant in ('canonical', 'exact_bytes', 'phash_near', 'scene_similar')),
  similarity real,
  decision text not null default 'undecided' check (decision in ('keep', 'remove', 'undecided')),
  primary key (cluster_id, media_asset_id)
);

create table if not exists public.media_dedup_pair_suppressions (
  asset_min_id uuid not null,
  asset_max_id uuid not null,
  reason text not null default 'not_duplicate',
  cluster_id uuid references public.media_dedup_clusters(id) on delete set null,
  suppressed_by uuid,
  note text,
  created_at timestamptz not null default now(),
  primary key (asset_min_id, asset_max_id),
  check (asset_min_id < asset_max_id)
);

create table if not exists public.media_dedup_cluster_events (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references public.media_dedup_clusters(id) on delete cascade,
  action text not null check (action in ('built', 'resolved', 'dismissed', 'undone', 'rebuilt_reopened')),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_native_media_dedup_clusters_status_tier_updated
  on public.media_dedup_clusters(status, tier, updated_at desc);
create index if not exists idx_native_media_dedup_cluster_members_asset
  on public.media_dedup_cluster_members(media_asset_id);
create index if not exists idx_native_media_dedup_cluster_events_cluster_created
  on public.media_dedup_cluster_events(cluster_id, created_at desc);
create index if not exists idx_native_media_dedup_suppressions_pair
  on public.media_dedup_pair_suppressions(asset_min_id, asset_max_id);
create index if not exists idx_native_media_content_hash
  on public.media_assets(content_hash) where content_hash is not null and deleted_at is null;
