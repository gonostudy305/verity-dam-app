-- 0029_universal_canonical_media_pipeline.sql
-- Authorized by plans/2026-09-08-universal-canonical-media-pipeline/ADR-0029-universal-canonical-media.md.
--
-- This is additive.  Originals remain at media_assets.storage_path; canonical
-- WebP renditions are written to a separate immutable CDN namespace.

alter table public.media_assets
  add column if not exists canonical_slug text,
  add column if not exists canonical_version integer not null default 1,
  add column if not exists canonical_published_version integer,
  add column if not exists canonical_published_at timestamptz;

alter table public.media_assets
  drop constraint if exists media_assets_canonical_slug_check;
alter table public.media_assets
  add constraint media_assets_canonical_slug_check
  check (canonical_slug is null or canonical_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

alter table public.media_assets
  drop constraint if exists media_assets_canonical_version_check;
alter table public.media_assets
  add constraint media_assets_canonical_version_check
  check (canonical_version >= 1 and (canonical_published_version is null or canonical_published_version >= 1));

alter table public.media_ingest_jobs
  drop constraint if exists media_ingest_jobs_job_kind_check;
alter table public.media_ingest_jobs
  add constraint media_ingest_jobs_job_kind_check
  check (job_kind in ('analyze_image', 'publish_wordpress', 'publish_canonical_media'));

create or replace function public.bump_media_asset_canonical_version()
returns trigger
language plpgsql
as $$
begin
  if row(
    old.title, old.sku, old.brand, old.category, old.space, old.status,
    old.suggested_caption, old.description, old.keywords, old.visible_text,
    old.author, old.copyright, old.credit
  ) is distinct from row(
    new.title, new.sku, new.brand, new.category, new.space, new.status,
    new.suggested_caption, new.description, new.keywords, new.visible_text,
    new.author, new.copyright, new.credit
  ) then
    new.canonical_version := greatest(coalesce(old.canonical_version, 1) + 1, coalesce(new.canonical_version, 1));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_media_asset_canonical_version on public.media_assets;
create trigger trg_bump_media_asset_canonical_version
before update of title, sku, brand, category, space, status, suggested_caption,
  description, keywords, visible_text, author, copyright, credit
on public.media_assets
for each row execute function public.bump_media_asset_canonical_version();

create or replace function public.enqueue_canonical_media_publication()
returns trigger
language plpgsql
as $$
begin
  if new.deleted_at is null
     and new.media_type in ('photo', 'render', 'screenshot')
     and new.ingest_status = 'ready'
     and coalesce(new.storage_path, '') <> ''
     and coalesce(new.canonical_published_version, 0) < new.canonical_version
     and (
       tg_op = 'INSERT'
       or old.ingest_status is distinct from new.ingest_status
       or old.canonical_version is distinct from new.canonical_version
     ) then
    insert into public.media_ingest_jobs (
      media_asset_id, job_kind, idempotency_key, payload
    ) values (
      new.id,
      'publish_canonical_media',
      'publish_canonical_media:' || new.id::text || ':' || new.canonical_version::text,
      jsonb_build_object('canonical_version', new.canonical_version)
    ) on conflict (idempotency_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enqueue_canonical_media_publication on public.media_assets;
create trigger trg_enqueue_canonical_media_publication
after insert or update of ingest_status, canonical_version
on public.media_assets
for each row execute function public.enqueue_canonical_media_publication();

create index if not exists idx_media_assets_canonical_pending
  on public.media_assets (canonical_version, created_at)
  where deleted_at is null
    and media_type in ('photo', 'render', 'screenshot')
    and ingest_status = 'ready';
