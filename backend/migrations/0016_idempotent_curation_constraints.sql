-- Migration 0016: Idempotent Curation Constraints and Immutable Audit Trail

do $$
begin
  -- 1. Check constraints on sku_reference_embeddings_shadow
  if not exists (select 1 from pg_constraint where conname = 'chk_shadow_reference_role') then
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
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_shadow_curation_status') then
    alter table public.sku_reference_embeddings_shadow
      add constraint chk_shadow_curation_status
      check (
        curation_status in (
          'UNREVIEWED',
          'VERIFIED',
          'REJECTED'
        )
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'chk_shadow_quality_score') then
    alter table public.sku_reference_embeddings_shadow
      add constraint chk_shadow_quality_score
      check (
        quality_score is null
        or (quality_score >= 0 and quality_score <= 100)
      );
  end if;
end $$;

-- 2. Ensure Audit Event History is Immutable (ON DELETE RESTRICT)
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints 
    where constraint_name = 'reference_curation_events_reference_id_fkey'
  ) then
    alter table public.reference_curation_events
      drop constraint reference_curation_events_reference_id_fkey;
      
    alter table public.reference_curation_events
      add constraint reference_curation_events_reference_id_fkey
      foreign key (reference_id) references public.sku_reference_embeddings_shadow(id) on delete restrict;
  end if;
end $$;
