-- PostgreSQL-native prerequisites for the VerityDAM migration.
--
-- This migration is intentionally additive. It does not drop Supabase tables,
-- alter auth.users, or switch application traffic. Apply it only to the
-- isolated PostgreSQL staging database until the native repositories are live.

create extension if not exists vector;
create extension if not exists pgcrypto;

create schema if not exists verity;

create table if not exists verity.migration_state (
  migration_id text primary key,
  applied_at timestamptz not null default now(),
  checksum text not null,
  notes text
);

create table if not exists verity.r2_object_manifest (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  object_key text not null,
  content_type text,
  size_bytes bigint,
  etag text,
  media_asset_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, object_key),
  check (bucket <> '' and length(bucket) <= 63),
  check (
    object_key <> ''
    and object_key !~ '(^/|/$|//|(^|/)\.\.?($|/))'
  ),
  check (size_bytes is null or size_bytes >= 0)
);

create index if not exists idx_r2_object_manifest_asset
  on verity.r2_object_manifest (media_asset_id);

comment on table verity.r2_object_manifest is
  'Metadata for objects stored in Cloudflare R2; file bytes never live in PostgreSQL.';

create or replace function verity.touch_r2_object_manifest_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_r2_object_manifest_updated_at on verity.r2_object_manifest;
create trigger trg_r2_object_manifest_updated_at
before update on verity.r2_object_manifest
for each row execute function verity.touch_r2_object_manifest_updated_at();
