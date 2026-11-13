-- Migration 0019: Repair B32 Memory Governance — Canonical Trigger + Constraint Re-assertion
-- This migration provides an audit-grade idempotent repair of everything that 0018 intended
-- to establish, so that any DB that went through the old 0018 path converges to the same state.
-- Safe to re-apply on a DB where 0018 already created the correct structures.

-- 1. Create/replace the full-immutability protection function
CREATE OR REPLACE FUNCTION protect_frozen_catalog_memory_v2()
RETURNS TRIGGER AS $func$
BEGIN
    IF OLD.is_frozen_benchmark THEN
        RAISE EXCEPTION
            'CANNOT_MUTATE_FROZEN_BENCHMARK_MEMORY: Reference ID % (SKU %, Space %) is certified and immutable in Catalog Memory v2.',
            OLD.id, OLD.sku, OLD.space_id;
    END IF;
    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

-- 2. Re-create the trigger unconditionally (DROP + CREATE is safe because the function is idempotent)
DROP TRIGGER IF EXISTS trg_protect_frozen_catalog_memory_v2 ON public.sku_reference_embeddings_shadow;

CREATE TRIGGER trg_protect_frozen_catalog_memory_v2
BEFORE UPDATE OR DELETE ON public.sku_reference_embeddings_shadow
FOR EACH ROW EXECUTE FUNCTION protect_frozen_catalog_memory_v2();

-- 3. Re-assert media_assets production embedding space constraint
--    Allows both local_openclip (current canonical) and 9router (legacy rows, not new production writes).
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

-- 4. Re-assert sku_reference_embeddings production embedding space constraint
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

-- 5. Postcondition gate: assert frozen refs count = 73
DO $$
DECLARE
    frozen_count INTEGER;
BEGIN
    SELECT count(*) INTO frozen_count
    FROM public.sku_reference_embeddings_shadow
    WHERE is_frozen_benchmark = true;

    IF frozen_count <> 73 AND frozen_count <> 0 THEN
        RAISE EXCEPTION
            'MIGRATION_0019_POSTCONDITION_FAILED: Expected 73 frozen benchmark references, found %. '
            'Catalog Memory v2 integrity may be compromised.',
            frozen_count;
    END IF;
END;
$$;
