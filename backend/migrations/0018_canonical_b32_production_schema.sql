-- Migration 0018: Canonical B32 Production Schema, Live Prototype Curation & Idempotent Memory Protection

-- 1. Ensure sku_reference_embeddings has matching curation columns
ALTER TABLE public.sku_reference_embeddings
  ADD COLUMN IF NOT EXISTS match_eligible BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reference_role TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN IF NOT EXISTS curation_status TEXT NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN IF NOT EXISTS quality_score SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS is_frozen_benchmark BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sku_ref_match_eligible
  ON public.sku_reference_embeddings(is_active, match_eligible)
  WHERE is_active = true AND match_eligible = true;

-- 2. Ensure sku_reference_embeddings_shadow has is_frozen_benchmark column & HNSW index
ALTER TABLE public.sku_reference_embeddings_shadow
  ADD COLUMN IF NOT EXISTS is_frozen_benchmark BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sku_ref_shadow_embedding
  ON public.sku_reference_embeddings_shadow USING hnsw (embedding vector_cosine_ops)
  WITH (m=16, ef_construction=64);

-- 3. Absolute Immutability Trigger for Catalog Memory v2
CREATE OR REPLACE FUNCTION protect_frozen_catalog_memory_v2()
RETURNS TRIGGER AS $func$
BEGIN
    IF OLD.is_frozen_benchmark THEN
        RAISE EXCEPTION 'CANNOT_MUTATE_FROZEN_BENCHMARK_MEMORY: Reference ID % (SKU %, Space %) is certified and immutable in Catalog Memory v2.',
            OLD.id, OLD.sku, OLD.space_id;
    END IF;
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_frozen_catalog_memory_v2 ON public.sku_reference_embeddings_shadow;

CREATE TRIGGER trg_protect_frozen_catalog_memory_v2
BEFORE UPDATE OR DELETE ON public.sku_reference_embeddings_shadow
FOR EACH ROW EXECUTE FUNCTION protect_frozen_catalog_memory_v2();

-- 4. Update check constraints on media_assets & sku_reference_embeddings to allow local_openclip B32 space
ALTER TABLE public.media_assets
  DROP CONSTRAINT IF EXISTS media_assets_production_embedding_space_ck;

ALTER TABLE public.media_assets
  ADD CONSTRAINT media_assets_production_embedding_space_ck
  CHECK (
    image_embedding IS NULL
    OR (
      embedding_provider = 'local_openclip'
      AND embedding_model = 'openclip-b32-datacomp-256'
      AND embedding_version = 'v1'
      AND embedding_dimension = 512
      AND vector_dims(image_embedding) = 512
    )
    OR (
      embedding_provider = '9router'
      AND embedding_model = 'jina-ai/jina-clip-v2'
      AND embedding_version = 'jina-clip-v2-v1'
      AND embedding_dimension = 512
      AND vector_dims(image_embedding) = 512
    )
  );

ALTER TABLE public.sku_reference_embeddings
  DROP CONSTRAINT IF EXISTS sku_reference_production_embedding_space_ck;

ALTER TABLE public.sku_reference_embeddings
  ADD CONSTRAINT sku_reference_production_embedding_space_ck
  CHECK (
    embedding IS NULL
    OR (
      embedding_provider = 'local_openclip'
      AND embedding_model = 'openclip-b32-datacomp-256'
      AND embedding_version = 'v1'
      AND embedding_dimension = 512
      AND vector_dims(embedding) = 512
    )
    OR (
      embedding_provider = '9router'
      AND embedding_model = 'jina-ai/jina-clip-v2'
      AND embedding_version = 'jina-clip-v2-v1'
      AND embedding_dimension = 512
      AND vector_dims(embedding) = 512
    )
  );
