-- Keep deleted media recoverable for developers while removing it from the
-- operational pipeline.  Object bytes remain in R2 and all relational rows
-- remain available for audit/recovery.
alter table public.media_assets
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists idx_native_media_active_created
  on public.media_assets(created_at desc)
  where deleted_at is null;

comment on column public.media_assets.deleted_at is
  'Soft-delete timestamp. Non-null assets are excluded from operational reads and jobs.';
comment on column public.media_assets.deleted_by is
  'Better Auth user id that performed the soft delete.';
