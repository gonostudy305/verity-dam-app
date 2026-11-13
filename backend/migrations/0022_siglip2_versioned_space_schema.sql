-- Migration 0022: SigLIP2 Versioned Space Additive Schema & Governance
-- Authorized under explicit Phase 4 GO decision.
-- ADDITIVE-ONLY: Never alters or drops legacy 512-d columns or frozen benchmark tables.

-- 1. Table: public.embedding_spaces (Space registry & cryptographic artifact pins)
CREATE TABLE IF NOT EXISTS public.embedding_spaces (
    space_id TEXT PRIMARY KEY,
    model_family TEXT NOT NULL,
    model_name TEXT NOT NULL,
    model_revision TEXT NULL,
    dimension INTEGER NOT NULL CHECK (dimension > 0),
    distance_metric TEXT NOT NULL DEFAULT 'cosine' CHECK (distance_metric IN ('cosine', 'l2', 'ip')),
    provider TEXT NOT NULL,
    runtime TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('CANDIDATE', 'SHADOW', 'ACTIVE', 'DEPRECATED', 'RETIRED')),
    vision_artifact_sha256 TEXT NOT NULL,
    text_artifact_sha256 TEXT NULL,
    tokenizer_snapshot_sha256 TEXT NULL,
    preprocess_spec_sha256 TEXT NULL,
    exporter_version TEXT NULL,
    opset INTEGER NULL,
    runtime_version TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ NULL
);

-- Invariant: At most one space can have status = 'ACTIVE' at any time
CREATE UNIQUE INDEX IF NOT EXISTS uq_embedding_spaces_single_active
    ON public.embedding_spaces (status)
    WHERE status = 'ACTIVE';

-- Seed DataComp baseline (ACTIVE, dim 512)
INSERT INTO public.embedding_spaces (
    space_id, model_family, model_name, model_revision,
    dimension, distance_metric, provider, runtime,
    status, vision_artifact_sha256, text_artifact_sha256,
    tokenizer_snapshot_sha256, preprocess_spec_sha256,
    exporter_version, opset, runtime_version,
    created_at, activated_at
) VALUES (
    'verity-openclip-b32-datacomp-256-v1',
    'openclip',
    'openclip-b32-datacomp-256',
    'v1',
    512,
    'cosine',
    'local_openclip',
    'onnxruntime',
    'ACTIVE',
    '824eb237a1b6ad7708cb0ffe8292322df2302c242180c2fb90f93a44e8b70474',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    'onnxruntime',
    now(),
    now()
) ON CONFLICT (space_id) DO NOTHING;

-- Seed SigLIP2 candidate (SHADOW, dim 768)
INSERT INTO public.embedding_spaces (
    space_id, model_family, model_name, model_revision,
    dimension, distance_metric, provider, runtime,
    status, vision_artifact_sha256, text_artifact_sha256,
    tokenizer_snapshot_sha256, preprocess_spec_sha256,
    exporter_version, opset, runtime_version,
    created_at, activated_at
) VALUES (
    'verity-siglip2-b32-256-webli-v1',
    'siglip2',
    'timm/ViT-B-32-SigLIP2-256',
    'cd1efb47643f2794413dd79ef24397c175032780',
    768,
    'cosine',
    'local_onnx',
    'onnxruntime',
    'SHADOW',
    '7df69b5ab53b6ce7c403ad74eae6500e868614e98a8043ade2bfc452c5db92d4',
    'adcae27298c2c29987daea9cb6123baff2085545afc761702e3ee3f0521257b6',
    '0f278a1fe8928a571a95cdb4335afc1396c5cd935eff24a530b24c8fa2026633',
    '59605890f620cc6b101ee85f9cc22cc62b80651022841ee50b96ce03fbf3746d',
    'torch.onnx dynamo exporter',
    18,
    'onnxruntime 1.24.4',
    now(),
    NULL
) ON CONFLICT (space_id) DO NOTHING;


-- 2. Table: public.embedding_runtime_state (Singleton pointer routing)
CREATE TABLE IF NOT EXISTS public.embedding_runtime_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    active_space_id TEXT NOT NULL REFERENCES public.embedding_spaces(space_id),
    nl_search_space_id TEXT NULL REFERENCES public.embedding_spaces(space_id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed singleton state pointing to DataComp (NL search disabled initially)
INSERT INTO public.embedding_runtime_state (
    singleton_id, active_space_id, nl_search_space_id, updated_at
) VALUES (
    1,
    'verity-openclip-b32-datacomp-256-v1',
    NULL,
    now()
) ON CONFLICT (singleton_id) DO NOTHING;


-- 3. Table: public.asset_embeddings (Generic vector storage for media assets)
CREATE TABLE IF NOT EXISTS public.asset_embeddings (
    embedding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES public.embedding_spaces(space_id),
    kind TEXT NOT NULL DEFAULT 'global' CHECK (kind IN ('global', 'product_crop', 'scene_region')),
    region_id TEXT NULL,
    region_bbox JSONB NULL,
    vector VECTOR NOT NULL,
    source_sha256 TEXT NULL,
    input_fingerprint_sha256 TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique: exactly 1 global embedding per (asset, space)
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_embeddings_global
    ON public.asset_embeddings(asset_id, space_id)
    WHERE kind = 'global';

-- Deterministic uniqueness for cropped regions
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_embeddings_region
    ON public.asset_embeddings(asset_id, space_id, region_id)
    WHERE region_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_asset_embeddings_space_asset
    ON public.asset_embeddings(space_id, asset_id);

CREATE INDEX IF NOT EXISTS idx_asset_embeddings_source_sha
    ON public.asset_embeddings(source_sha256);


-- 4. Reference Generalization: Business truth decoupled from space representations
CREATE TABLE IF NOT EXISTS public.sku_references (
    reference_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT NOT NULL,
    source_media_asset_id UUID REFERENCES public.media_assets(id) ON DELETE SET NULL,
    source_url TEXT NULL,
    verified BOOLEAN NOT NULL DEFAULT true,
    match_eligible BOOLEAN NOT NULL DEFAULT true,
    reference_role TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
    curation_status TEXT NOT NULL DEFAULT 'UNREVIEWED',
    quality_score SMALLINT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_frozen_benchmark BOOLEAN NOT NULL DEFAULT false,
    created_by UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sku_references_source_asset
    ON public.sku_references(sku, source_media_asset_id)
    WHERE source_media_asset_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sku_references_source_url
    ON public.sku_references(sku, source_url)
    WHERE source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sku_references_sku_eligible
    ON public.sku_references(sku, is_active, match_eligible);

-- 4b. Per-space representation table
CREATE TABLE IF NOT EXISTS public.reference_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_id UUID NOT NULL REFERENCES public.sku_references(reference_id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES public.embedding_spaces(space_id),
    vector VECTOR NOT NULL,
    source_sha256 TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_reference_embeddings_ref_space UNIQUE (reference_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_reference_embeddings_space_ref
    ON public.reference_embeddings(space_id, reference_id);

-- Populate sku_references from existing sku_reference_embeddings (non-destructive copy)
INSERT INTO public.sku_references (
    reference_id, sku, source_media_asset_id, source_url,
    is_primary, is_active, match_eligible, reference_role,
    curation_status, quality_score, is_frozen_benchmark,
    created_by, created_at
)
SELECT
    id, sku, source_media_asset_id, source_url,
    is_primary, is_active, match_eligible, reference_role,
    curation_status, quality_score, is_frozen_benchmark,
    created_by, created_at
FROM public.sku_reference_embeddings
ON CONFLICT (reference_id) DO NOTHING;


-- 5. Table: public.embedding_space_calibration (Per-space tuned decision thresholds)
CREATE TABLE IF NOT EXISTS public.embedding_space_calibration (
    space_id TEXT PRIMARY KEY REFERENCES public.embedding_spaces(space_id),
    sku_high DOUBLE PRECISION NOT NULL,
    sku_low DOUBLE PRECISION NOT NULL,
    ambiguity_margin DOUBLE PRECISION NOT NULL,
    consistency_primary_min DOUBLE PRECISION NOT NULL,
    consistency_spread_max DOUBLE PRECISION NOT NULL,
    scene_duplicate_threshold DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed DataComp baseline thresholds (from contracts.py & production_config.py)
INSERT INTO public.embedding_space_calibration (
    space_id, sku_high, sku_low, ambiguity_margin,
    consistency_primary_min, consistency_spread_max, scene_duplicate_threshold,
    created_at, updated_at
) VALUES (
    'verity-openclip-b32-datacomp-256-v1',
    0.90,
    0.70,
    0.08,
    0.80,
    0.15,
    0.92,
    now(),
    now()
) ON CONFLICT (space_id) DO NOTHING;

-- Seed SigLIP2 candidate thresholds (P3 calibrated values)
INSERT INTO public.embedding_space_calibration (
    space_id, sku_high, sku_low, ambiguity_margin,
    consistency_primary_min, consistency_spread_max, scene_duplicate_threshold,
    created_at, updated_at
) VALUES (
    'verity-siglip2-b32-256-webli-v1',
    0.85,
    0.65,
    0.08,
    0.75,
    0.15,
    0.85,
    now(),
    now()
) ON CONFLICT (space_id) DO NOTHING;


-- 6. Trigger Functions: Enforce dynamic vector dimensions and non-zero vectors
CREATE OR REPLACE FUNCTION trg_enforce_asset_embedding_dimension()
RETURNS TRIGGER AS $func$
DECLARE
    target_dim INTEGER;
BEGIN
    IF NEW.space_id IS NULL THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: space_id cannot be NULL';
    END IF;

    SELECT dimension INTO target_dim
    FROM public.embedding_spaces
    WHERE space_id = NEW.space_id;

    IF target_dim IS NULL THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: space_id % not found in embedding_spaces', NEW.space_id;
    END IF;

    IF NEW.vector IS NULL THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: vector cannot be NULL for space %', NEW.space_id;
    END IF;

    IF vector_dims(NEW.vector) <> target_dim THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: vector dimension % does not match expected dimension % for space %',
            vector_dims(NEW.vector), target_dim, NEW.space_id;
    END IF;

    IF vector_norm(NEW.vector) = 0 THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: zero-vector is degenerate and forbidden for space %', NEW.space_id;
    END IF;

    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_embeddings_dimension ON public.asset_embeddings;
CREATE TRIGGER trg_asset_embeddings_dimension
BEFORE INSERT OR UPDATE ON public.asset_embeddings
FOR EACH ROW EXECUTE FUNCTION trg_enforce_asset_embedding_dimension();

CREATE OR REPLACE FUNCTION trg_enforce_reference_embedding_dimension()
RETURNS TRIGGER AS $func$
DECLARE
    target_dim INTEGER;
BEGIN
    IF NEW.space_id IS NULL THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: space_id cannot be NULL';
    END IF;

    SELECT dimension INTO target_dim
    FROM public.embedding_spaces
    WHERE space_id = NEW.space_id;

    IF target_dim IS NULL THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: space_id % not found in embedding_spaces', NEW.space_id;
    END IF;

    IF NEW.vector IS NULL THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: vector cannot be NULL for space %', NEW.space_id;
    END IF;

    IF vector_dims(NEW.vector) <> target_dim THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: vector dimension % does not match expected dimension % for space %',
            vector_dims(NEW.vector), target_dim, NEW.space_id;
    END IF;

    IF vector_norm(NEW.vector) = 0 THEN
        RAISE EXCEPTION 'DIMENSION_ENFORCEMENT_FAILED: zero-vector is degenerate and forbidden for space %', NEW.space_id;
    END IF;

    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reference_embeddings_dimension ON public.reference_embeddings;
CREATE TRIGGER trg_reference_embeddings_dimension
BEFORE INSERT OR UPDATE ON public.reference_embeddings
FOR EACH ROW EXECUTE FUNCTION trg_enforce_reference_embedding_dimension();


-- 7. Trigger Function: Absolute immutability of space identity & artifact pins
CREATE OR REPLACE FUNCTION trg_protect_space_immutability()
RETURNS TRIGGER AS $func$
DECLARE
    has_asset_rows BOOLEAN;
    has_ref_rows BOOLEAN;
BEGIN
    IF OLD.status IN ('SHADOW', 'ACTIVE', 'DEPRECATED', 'RETIRED') THEN
        IF OLD.space_id <> NEW.space_id
           OR OLD.dimension <> NEW.dimension
           OR OLD.distance_metric <> NEW.distance_metric
           OR OLD.model_family <> NEW.model_family
           OR OLD.model_name <> NEW.model_name
           OR (OLD.model_revision IS DISTINCT FROM NEW.model_revision)
           OR (OLD.vision_artifact_sha256 IS DISTINCT FROM NEW.vision_artifact_sha256)
           OR (OLD.text_artifact_sha256 IS DISTINCT FROM NEW.text_artifact_sha256)
           OR (OLD.tokenizer_snapshot_sha256 IS DISTINCT FROM NEW.tokenizer_snapshot_sha256)
           OR (OLD.preprocess_spec_sha256 IS DISTINCT FROM NEW.preprocess_spec_sha256)
           OR (OLD.opset IS DISTINCT FROM NEW.opset)
           OR (OLD.exporter_version IS DISTINCT FROM NEW.exporter_version)
           OR (OLD.runtime_version IS DISTINCT FROM NEW.runtime_version) THEN
            RAISE EXCEPTION 'CANNOT_MUTATE_IMMUTABLE_SPACE: Space % is in status %; identity and artifact hashes are immutable. Register a new space_id instead.',
                OLD.space_id, OLD.status;
        END IF;
    ELSE
        SELECT EXISTS (SELECT 1 FROM public.asset_embeddings WHERE space_id = OLD.space_id LIMIT 1) INTO has_asset_rows;
        SELECT EXISTS (SELECT 1 FROM public.reference_embeddings WHERE space_id = OLD.space_id LIMIT 1) INTO has_ref_rows;
        IF (has_asset_rows OR has_ref_rows) THEN
            IF OLD.space_id <> NEW.space_id
               OR OLD.dimension <> NEW.dimension
               OR OLD.distance_metric <> NEW.distance_metric
               OR OLD.model_family <> NEW.model_family
               OR OLD.model_name <> NEW.model_name
               OR (OLD.model_revision IS DISTINCT FROM NEW.model_revision)
               OR (OLD.vision_artifact_sha256 IS DISTINCT FROM NEW.vision_artifact_sha256)
               OR (OLD.text_artifact_sha256 IS DISTINCT FROM NEW.text_artifact_sha256)
               OR (OLD.tokenizer_snapshot_sha256 IS DISTINCT FROM NEW.tokenizer_snapshot_sha256)
               OR (OLD.preprocess_spec_sha256 IS DISTINCT FROM NEW.preprocess_spec_sha256) THEN
                RAISE EXCEPTION 'CANNOT_MUTATE_IMMUTABLE_SPACE: Space % has populated embedding rows; identity and artifact hashes are immutable.',
                    OLD.space_id;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_embedding_spaces_immutability ON public.embedding_spaces;
CREATE TRIGGER trg_embedding_spaces_immutability
BEFORE UPDATE ON public.embedding_spaces
FOR EACH ROW EXECUTE FUNCTION trg_protect_space_immutability();


-- 8. Runtime State Invariants and Atomic Transition Procedure
CREATE OR REPLACE FUNCTION trg_check_embedding_runtime_state_invariants()
RETURNS TRIGGER AS $func$
DECLARE
    recog_status TEXT;
    nl_status TEXT;
    nl_text_sha TEXT;
BEGIN
    -- 1. Recognition space must exist and be ACTIVE
    SELECT status INTO recog_status
    FROM public.embedding_spaces
    WHERE space_id = NEW.active_space_id;

    IF recog_status IS NULL THEN
        RAISE EXCEPTION 'RUNTIME_STATE_INVARIANT_FAILED: active_space_id % does not exist in embedding_spaces', NEW.active_space_id;
    END IF;

    IF recog_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'RUNTIME_STATE_INVARIANT_FAILED: active_space_id % must have status ACTIVE, but found %',
            NEW.active_space_id, recog_status;
    END IF;

    -- 2. NL search space (if non-null) must be ACTIVE or SHADOW and have text capability
    IF NEW.nl_search_space_id IS NOT NULL THEN
        SELECT status, text_artifact_sha256 INTO nl_status, nl_text_sha
        FROM public.embedding_spaces
        WHERE space_id = NEW.nl_search_space_id;

        IF nl_status IS NULL THEN
            RAISE EXCEPTION 'RUNTIME_STATE_INVARIANT_FAILED: nl_search_space_id % does not exist in embedding_spaces', NEW.nl_search_space_id;
        END IF;

        IF nl_status NOT IN ('ACTIVE', 'SHADOW') THEN
            RAISE EXCEPTION 'RUNTIME_STATE_INVARIANT_FAILED: nl_search_space_id % must have status ACTIVE or SHADOW, but found %',
                NEW.nl_search_space_id, nl_status;
        END IF;

        IF nl_text_sha IS NULL OR btrim(nl_text_sha) = '' THEN
            RAISE EXCEPTION 'RUNTIME_STATE_INVARIANT_FAILED: nl_search_space_id % lacks text capability (text_artifact_sha256 is NULL)',
                NEW.nl_search_space_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_embedding_runtime_state_invariants ON public.embedding_runtime_state;
CREATE TRIGGER trg_embedding_runtime_state_invariants
BEFORE INSERT OR UPDATE ON public.embedding_runtime_state
FOR EACH ROW EXECUTE FUNCTION trg_check_embedding_runtime_state_invariants();

-- 8b. Atomic space transition procedure (SECURITY DEFINER, operator-gated)
CREATE OR REPLACE FUNCTION public.transition_runtime_spaces(
    new_recognition_space_id TEXT,
    new_nl_search_space_id TEXT DEFAULT NULL
)
RETURNS JSONB AS $func$
DECLARE
    current_recog TEXT;
    current_nl TEXT;
    target_recog_status TEXT;
    target_nl_status TEXT;
    target_nl_text_sha TEXT;
    res JSONB;
BEGIN
    -- 1. Explicitly acquire exclusive lock on singleton row
    SELECT active_space_id, nl_search_space_id
    INTO current_recog, current_nl
    FROM public.embedding_runtime_state
    WHERE singleton_id = 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'TRANSITION_FAILED: embedding_runtime_state singleton row (singleton_id=1) not found';
    END IF;

    -- 2. Validate target recognition space
    SELECT status INTO target_recog_status
    FROM public.embedding_spaces
    WHERE space_id = new_recognition_space_id;

    IF target_recog_status IS NULL THEN
        RAISE EXCEPTION 'TRANSITION_FAILED: new_recognition_space_id % does not exist in embedding_spaces', new_recognition_space_id;
    END IF;

    IF target_recog_status = 'RETIRED' THEN
        RAISE EXCEPTION 'TRANSITION_FAILED: new_recognition_space_id % is RETIRED and cannot be activated', new_recognition_space_id;
    END IF;

    -- 3. Validate target NL search space (if provided)
    IF new_nl_search_space_id IS NOT NULL THEN
        SELECT status, text_artifact_sha256 INTO target_nl_status, target_nl_text_sha
        FROM public.embedding_spaces
        WHERE space_id = new_nl_search_space_id;

        IF target_nl_status IS NULL THEN
            RAISE EXCEPTION 'TRANSITION_FAILED: new_nl_search_space_id % does not exist in embedding_spaces', new_nl_search_space_id;
        END IF;

        IF target_nl_text_sha IS NULL OR btrim(target_nl_text_sha) = '' THEN
            RAISE EXCEPTION 'TRANSITION_FAILED: new_nl_search_space_id % lacks text artifact capability (text_artifact_sha256 is NULL)', new_nl_search_space_id;
        END IF;

        IF target_nl_status = 'RETIRED' THEN
            RAISE EXCEPTION 'TRANSITION_FAILED: new_nl_search_space_id % is RETIRED and cannot be used for search', new_nl_search_space_id;
        END IF;
    END IF;

    -- 4. Atomically transition space lifecycle statuses if recognition space changed
    IF new_recognition_space_id <> current_recog THEN
        -- Step A: Demote current active space to DEPRECATED
        UPDATE public.embedding_spaces
        SET status = 'DEPRECATED'
        WHERE space_id = current_recog;

        -- Step B: Promote target space to ACTIVE
        UPDATE public.embedding_spaces
        SET status = 'ACTIVE',
            activated_at = COALESCE(activated_at, now())
        WHERE space_id = new_recognition_space_id;
    END IF;

    -- 5. Update runtime state pointers atomically
    UPDATE public.embedding_runtime_state
    SET active_space_id = new_recognition_space_id,
        nl_search_space_id = new_nl_search_space_id,
        updated_at = now()
    WHERE singleton_id = 1;

    res := jsonb_build_object(
        'previous_recognition_space', current_recog,
        'new_recognition_space', new_recognition_space_id,
        'previous_nl_search_space', current_nl,
        'new_nl_search_space', new_nl_search_space_id,
        'transitioned_at', now()
    );

    RETURN res;
END;
$func$ LANGUAGE plpgsql SECURITY DEFINER;

-- Privilege configuration: Revoke execute from PUBLIC by default
REVOKE ALL ON FUNCTION public.transition_runtime_spaces(TEXT, TEXT) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verity_operator') THEN
        GRANT EXECUTE ON FUNCTION public.transition_runtime_spaces(TEXT, TEXT) TO verity_operator;
    END IF;
END $$;


-- 9. Ingest Content Hash Contract Index
CREATE INDEX IF NOT EXISTS idx_native_media_content_hash
    ON public.media_assets(content_hash)
    WHERE content_hash IS NOT NULL;
