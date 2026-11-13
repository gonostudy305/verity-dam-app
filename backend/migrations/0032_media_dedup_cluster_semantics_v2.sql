-- A materialized dedup cluster is an interpretation of evidence.  Version 1
-- merged content-hash, pHash, and scene edges into one connected component,
-- which allowed a scene-similarity chain to mislabel a mixed group as exact.
-- Version 2 makes the builder rebuild all open clusters from isolated lanes.

alter table public.media_dedup_clusters
  add column if not exists build_version integer not null default 1;

alter table public.media_dedup_clusters
  drop constraint if exists media_dedup_clusters_build_version_positive;

alter table public.media_dedup_clusters
  add constraint media_dedup_clusters_build_version_positive
  check (build_version > 0);

-- The API sees v1 open rows and rebuilds them before serving the workbench.
-- Closed rows intentionally retain their historical decision/audit trail.
