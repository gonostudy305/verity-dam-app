-- Migration 0017: Protect Frozen Benchmark Memory (Catalog Memory v2) and Support Live Overlay

-- 1. Add is_frozen_benchmark flag to sku_reference_embeddings_shadow
ALTER TABLE public.sku_reference_embeddings_shadow
ADD COLUMN IF NOT EXISTS is_frozen_benchmark BOOLEAN NOT NULL DEFAULT false;

-- 2. Create Immutability Trigger Function
CREATE OR REPLACE FUNCTION protect_frozen_catalog_memory_v2()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_frozen_benchmark THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'CANNOT_MUTATE_FROZEN_BENCHMARK_MEMORY: Reference ID % (SKU %, Space %) is certified and immutable in Catalog Memory v2.',
                OLD.id, OLD.sku, OLD.space_id;
        ELSIF TG_OP = 'UPDATE' AND (
            NEW.is_frozen_benchmark = false
            OR NEW.embedding IS DISTINCT FROM OLD.embedding
            OR NEW.sku IS DISTINCT FROM OLD.sku
            OR NEW.match_eligible IS DISTINCT FROM OLD.match_eligible
            OR NEW.is_active IS DISTINCT FROM OLD.is_active
            OR NEW.is_primary IS DISTINCT FROM OLD.is_primary
        ) THEN
            RAISE EXCEPTION 'CANNOT_MUTATE_FROZEN_BENCHMARK_MEMORY: Reference ID % (SKU %, Space %) is certified and immutable in Catalog Memory v2.',
                OLD.id, OLD.sku, OLD.space_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_frozen_catalog_memory_v2 ON public.sku_reference_embeddings_shadow;

CREATE TRIGGER trg_protect_frozen_catalog_memory_v2
BEFORE UPDATE OR DELETE ON public.sku_reference_embeddings_shadow
FOR EACH ROW EXECUTE FUNCTION protect_frozen_catalog_memory_v2();
