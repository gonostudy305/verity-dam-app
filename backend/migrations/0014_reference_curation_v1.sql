-- Migration 0014: Reference Curation v1 Schema for SKU Multi-Prototype Store

alter table public.sku_reference_embeddings_shadow
  add column if not exists reference_role text not null default 'UNCLASSIFIED',
  add column if not exists match_eligible boolean not null default true,
  add column if not exists curation_status text not null default 'UNREVIEWED',
  add column if not exists quality_score smallint null,
  add column if not exists curation_version text not null default 'ref-curation-v1',
  add column if not exists curated_by text null,
  add column if not exists curated_at timestamptz null,
  add column if not exists exclude_reason text null,
  add column if not exists origin_group_id text null;

-- Index for high performance match retrieval on eligible prototypes
create index if not exists idx_sku_ref_shadow_match_eligible
  on public.sku_reference_embeddings_shadow(space_id, is_active, match_eligible)
  where is_active = true and match_eligible = true;
