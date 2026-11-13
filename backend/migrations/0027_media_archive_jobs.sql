-- Server-prepared batch archives for the responsive media library.
-- This is deliberately separate from media_ingest_jobs: the Python worker
-- must never claim an archive job as an image-analysis or WordPress job.

create table if not exists public.media_archive_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  status text not null default 'queued'
    check (status in ('queued','processing','ready','failed','cancelled','expired')),
  asset_ids uuid[] not null,
  asset_manifest jsonb not null default '[]'::jsonb,
  total_assets integer not null check (total_assets between 1 and 25),
  processed_assets integer not null default 0 check (processed_assets >= 0),
  total_bytes bigint not null default 0 check (total_bytes >= 0),
  processed_bytes bigint not null default 0 check (processed_bytes >= 0),
  archive_key text,
  archive_size_bytes bigint,
  error_message text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  locked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_native_archive_jobs_owner_created
  on public.media_archive_jobs(created_by, created_at desc);
create index if not exists idx_native_archive_jobs_status_lock
  on public.media_archive_jobs(status, locked_at, created_at);
create index if not exists idx_native_archive_jobs_expiry
  on public.media_archive_jobs(status, expires_at);
