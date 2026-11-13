-- Migration 0015: Reference Curation Constraints and Audit Event History

-- 1. Enforce Constraints on sku_reference_embeddings_shadow
alter table public.sku_reference_embeddings_shadow
  drop constraint if exists chk_shadow_reference_role;

alter table public.sku_reference_embeddings_shadow
  add constraint chk_shadow_reference_role
  check (
    reference_role in (
      'HERO',
      'ANGLE',
      'DETAIL',
      'INSTALLATION',
      'REAL_WORLD',
      'PACKAGING',
      'LIFESTYLE',
      'BANNER',
      'LOGO',
      'MULTI_PRODUCT',
      'UNCLASSIFIED'
    )
  );

alter table public.sku_reference_embeddings_shadow
  drop constraint if exists chk_shadow_curation_status;

alter table public.sku_reference_embeddings_shadow
  add constraint chk_shadow_curation_status
  check (
    curation_status in (
      'UNREVIEWED',
      'VERIFIED',
      'REJECTED'
    )
  );

alter table public.sku_reference_embeddings_shadow
  drop constraint if exists chk_shadow_quality_score;

alter table public.sku_reference_embeddings_shadow
  add constraint chk_shadow_quality_score
  check (
    quality_score is null
    or (quality_score >= 0 and quality_score <= 100)
  );

-- 2. Normalize Legacy Unreviewed Rows: curation_version should be NULL until reviewed
alter table public.sku_reference_embeddings_shadow
  alter column curation_version drop not null,
  alter column curation_version drop default;

update public.sku_reference_embeddings_shadow
  set curation_version = null
  where curation_status = 'UNREVIEWED';

-- 3. Curation Audit Event History Table
create table if not exists public.reference_curation_events (
  id bigserial primary key,
  reference_id bigint not null references public.sku_reference_embeddings_shadow(id) on delete cascade,
  action text not null, -- 'UPDATE_ROLE', 'DISQUALIFY', 'APPROVE_PROTOTYPE', 'ADD_PROTOTYPE'
  old_reference_role text null,
  new_reference_role text not null,
  old_match_eligible boolean not null,
  new_match_eligible boolean not null,
  curation_version text not null default 'ref-curation-v1',
  exclude_reason text null,
  curated_by text not null default 'system',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ref_curation_events_ref_id
  on public.reference_curation_events(reference_id);

create index if not exists idx_ref_curation_events_version
  on public.reference_curation_events(curation_version, created_at desc);
