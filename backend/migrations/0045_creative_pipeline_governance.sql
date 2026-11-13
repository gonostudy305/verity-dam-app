-- 0045_creative_pipeline_governance.sql
-- Database authority for synthetic-data isolation and creative review derivation.

CREATE OR REPLACE FUNCTION public.guard_no_synthetic_reference_asset(p_asset_id UUID, p_context TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF p_asset_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.media_assets a
    WHERE a.id = p_asset_id
      AND COALESCE(a.ai_flags -> 'is_ai', 'false'::jsonb) = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'SYNTHETIC_REFERENCE_FORBIDDEN: AI media asset % cannot be used as %', p_asset_id, p_context
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_sku_reference_not_synthetic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.guard_no_synthetic_reference_asset(NEW.source_media_asset_id, 'sku reference');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_sku_reference_not_synthetic ON public.sku_references;
CREATE TRIGGER trg_guard_sku_reference_not_synthetic
BEFORE INSERT OR UPDATE OF source_media_asset_id ON public.sku_references
FOR EACH ROW EXECUTE FUNCTION public.guard_sku_reference_not_synthetic();

CREATE OR REPLACE FUNCTION public.guard_legacy_sku_reference_not_synthetic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.guard_no_synthetic_reference_asset(NEW.source_media_asset_id, 'legacy SKU reference embedding');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_legacy_sku_reference_not_synthetic ON public.sku_reference_embeddings;
CREATE TRIGGER trg_guard_legacy_sku_reference_not_synthetic
BEFORE INSERT OR UPDATE OF source_media_asset_id ON public.sku_reference_embeddings
FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_sku_reference_not_synthetic();

CREATE OR REPLACE FUNCTION public.guard_creative_product_reference_not_synthetic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.reference_role IN ('identity', 'cutout') THEN
    PERFORM public.guard_no_synthetic_reference_asset(NEW.media_asset_id, 'creative product ' || NEW.reference_role || ' reference');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_creative_product_reference_not_synthetic ON public.creative_product_references;
CREATE TRIGGER trg_guard_creative_product_reference_not_synthetic
BEFORE INSERT OR UPDATE OF media_asset_id, reference_role ON public.creative_product_references
FOR EACH ROW EXECUTE FUNCTION public.guard_creative_product_reference_not_synthetic();

CREATE OR REPLACE FUNCTION public.guard_few_shot_example_not_synthetic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.is_active THEN
    PERFORM public.guard_no_synthetic_reference_asset(NEW.source_media_asset_id, 'active metadata few-shot example');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_few_shot_example_not_synthetic ON public.metadata_few_shot_examples;
CREATE TRIGGER trg_guard_few_shot_example_not_synthetic
BEFORE INSERT OR UPDATE OF source_media_asset_id, is_active ON public.metadata_few_shot_examples
FOR EACH ROW EXECUTE FUNCTION public.guard_few_shot_example_not_synthetic();

-- Reference corpora are identity truth and must fail migration loudly if they
-- are already contaminated. Few-shot rows are audit-adjacent and are instead
-- quarantined below so correction history remains available.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sku_references r
    JOIN public.media_assets a ON a.id = r.source_media_asset_id
    WHERE COALESCE(a.ai_flags -> 'is_ai', 'false'::jsonb) = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'SYNTHETIC_REFERENCE_MIGRATION_BLOCKED: sku_references contains AI source media';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sku_reference_embeddings r
    JOIN public.media_assets a ON a.id = r.source_media_asset_id
    WHERE COALESCE(a.ai_flags -> 'is_ai', 'false'::jsonb) = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION 'SYNTHETIC_REFERENCE_MIGRATION_BLOCKED: sku_reference_embeddings contains AI source media';
  END IF;
END;
$$;

-- Quarantine pre-existing synthetic few-shot records instead of deleting audit data.
UPDATE public.metadata_few_shot_examples f
SET is_active = false
FROM public.media_assets a
WHERE a.id = f.source_media_asset_id
  AND f.is_active
  AND COALESCE(a.ai_flags -> 'is_ai', 'false'::jsonb) = 'true'::jsonb;

CREATE OR REPLACE FUNCTION public.guard_creative_slot_resolution()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_asset_state TEXT;
  v_output_state TEXT;
  v_output_review TEXT;
  v_output_slot UUID;
  v_output_asset UUID;
  v_review_sync BOOLEAN := current_setting('verity.creative_review_sync', true) = 'true';
BEGIN
  SELECT review_state INTO v_asset_state FROM public.media_assets WHERE id = NEW.media_asset_id;
  IF v_asset_state IS NULL THEN
    RAISE EXCEPTION 'CREATIVE_RESOLUTION_ASSET_NOT_FOUND: asset % does not exist', NEW.media_asset_id;
  END IF;

  IF NEW.source_kind = 'library' THEN
    IF TG_OP = 'INSERT' AND NEW.status <> 'active' THEN
      RAISE EXCEPTION 'CREATIVE_LIBRARY_RESOLUTION_MUST_START_ACTIVE';
    END IF;
    IF NEW.status = 'active' AND v_asset_state <> 'approved' THEN
      RAISE EXCEPTION 'CREATIVE_LIBRARY_RESOLUTION_REQUIRES_APPROVED_ASSET';
    END IF;
    RETURN NEW;
  END IF;

  SELECT g.slot_id, o.media_asset_id, o.creative_state, o.review_state
    INTO v_output_slot, v_output_asset, v_output_state, v_output_review
    FROM public.ai_image_generation_outputs o
    JOIN public.ai_image_generations g ON g.id = o.generation_id
   WHERE o.id = NEW.generation_output_id;
  IF v_output_slot IS DISTINCT FROM NEW.slot_id OR v_output_asset IS DISTINCT FROM NEW.media_asset_id THEN
    RAISE EXCEPTION 'CREATIVE_AI_RESOLUTION_OUTPUT_MISMATCH';
  END IF;
  IF v_output_state <> 'promoted' THEN
    RAISE EXCEPTION 'CREATIVE_AI_RESOLUTION_REQUIRES_PROMOTED_OUTPUT';
  END IF;
  IF NEW.status = 'proposed' AND NOT (v_output_review = 'pending' AND v_asset_state = 'pending') THEN
    RAISE EXCEPTION 'CREATIVE_PROPOSAL_REQUIRES_PENDING_REVIEW';
  END IF;
  IF NEW.status = 'active' AND (NOT v_review_sync OR v_output_review <> 'approved' OR v_asset_state <> 'approved') THEN
    RAISE EXCEPTION 'CREATIVE_ACTIVE_AI_RESOLUTION_REQUIRES_REVIEW_SYNC';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_creative_slot_resolution ON public.creative_slot_resolutions;
CREATE TRIGGER trg_guard_creative_slot_resolution
BEFORE INSERT OR UPDATE OF slot_id, source_kind, media_asset_id, generation_output_id, status
ON public.creative_slot_resolutions
FOR EACH ROW EXECUTE FUNCTION public.guard_creative_slot_resolution();

CREATE OR REPLACE FUNCTION public.reserve_creative_budget(
  p_budget_period_id UUID,
  p_generation_id UUID,
  p_reserved_minor BIGINT
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_cap BIGINT;
  v_reserved BIGINT;
  v_id UUID;
BEGIN
  IF p_reserved_minor < 0 THEN RAISE EXCEPTION 'CREATIVE_BUDGET_NEGATIVE_RESERVATION'; END IF;
  SELECT hard_cap_minor INTO v_cap FROM public.creative_budget_periods WHERE id = p_budget_period_id FOR UPDATE;
  IF v_cap IS NULL THEN RAISE EXCEPTION 'CREATIVE_BUDGET_PERIOD_NOT_FOUND'; END IF;
  SELECT COALESCE(sum(CASE
    WHEN status IN ('settled', 'resolved_spent') THEN COALESCE(actual_minor, reserved_minor)
    WHEN status IN ('reserved', 'held_unknown') THEN reserved_minor
    ELSE 0 END), 0)
    INTO v_reserved
    FROM public.creative_budget_reservations
   WHERE budget_period_id = p_budget_period_id;
  IF v_reserved + p_reserved_minor > v_cap THEN
    RAISE EXCEPTION 'CREATIVE_BUDGET_HARD_CAP_EXCEEDED';
  END IF;
  INSERT INTO public.creative_budget_reservations(budget_period_id, generation_id, reserved_minor)
  VALUES (p_budget_period_id, p_generation_id, p_reserved_minor)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_creative_candidates(p_now TIMESTAMPTZ DEFAULT now())
RETURNS TABLE(output_id UUID, temp_storage_key TEXT)
LANGUAGE sql
SET search_path = public, pg_catalog
AS $$
  UPDATE public.ai_image_generation_outputs
     SET creative_state = 'expired', updated_at = now()
   WHERE creative_state = 'candidate'
     AND expires_at <= p_now
     AND NOT EXISTS (
       SELECT 1 FROM public.creative_storage_sagas s
       WHERE s.output_id = public.ai_image_generation_outputs.id
         AND s.state IN ('pending_copy', 'copied', 'verified', 'db_finalized', 'cleanup_pending')
     )
  RETURNING id, temp_storage_key;
$$;

CREATE OR REPLACE FUNCTION public.recompute_creative_slots(p_slot_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_request_ids UUID[];
BEGIN
  IF COALESCE(array_length(p_slot_ids, 1), 0) = 0 THEN RETURN; END IF;

  PERFORM id FROM public.creative_slots WHERE id = ANY(p_slot_ids) ORDER BY id FOR UPDATE;

  UPDATE public.creative_slots s
  SET status = CASE
      WHEN EXISTS (
        SELECT 1 FROM public.creative_slot_resolutions r
        JOIN public.media_assets a ON a.id = r.media_asset_id
        WHERE r.slot_id = s.id AND r.status = 'active' AND a.review_state = 'approved'
      ) THEN 'resolved'
      WHEN EXISTS (SELECT 1 FROM public.creative_slot_resolutions r WHERE r.slot_id = s.id AND r.status = 'proposed') THEN 'awaiting_review'
      WHEN EXISTS (SELECT 1 FROM public.ai_image_generation_outputs o JOIN public.ai_image_generations g ON g.id = o.generation_id WHERE g.slot_id = s.id AND o.creative_state = 'candidate') THEN 'candidate_ready'
      WHEN EXISTS (SELECT 1 FROM public.ai_image_generations g WHERE g.slot_id = s.id AND g.provider_call_state IN ('queued', 'executing')) THEN 'generating'
      ELSE s.status
    END,
    updated_at = now()
  WHERE s.id = ANY(p_slot_ids);

  SELECT array_agg(DISTINCT request_id ORDER BY request_id)
    INTO v_request_ids
    FROM public.creative_slots
   WHERE id = ANY(p_slot_ids);
  PERFORM public.recompute_creative_requests(v_request_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_creative_requests(p_request_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF COALESCE(array_length(p_request_ids, 1), 0) = 0 THEN RETURN; END IF;
  PERFORM id FROM public.creative_requests WHERE id = ANY(p_request_ids) ORDER BY id FOR UPDATE;

  UPDATE public.creative_requests r
  SET status = CASE
      WHEN r.status = 'superseded_for_placement' THEN r.status
      WHEN NOT EXISTS (SELECT 1 FROM public.creative_slots s WHERE s.request_id = r.id) THEN 'planning'
      WHEN NOT EXISTS (SELECT 1 FROM public.creative_slots s WHERE s.request_id = r.id AND s.status <> 'resolved') THEN 'resolved'
      WHEN EXISTS (SELECT 1 FROM public.creative_slots s WHERE s.request_id = r.id AND s.status = 'awaiting_review') THEN 'awaiting_review'
      WHEN EXISTS (SELECT 1 FROM public.creative_slots s WHERE s.request_id = r.id AND s.status = 'candidate_ready') THEN 'candidate_ready'
      WHEN EXISTS (SELECT 1 FROM public.creative_slots s WHERE s.request_id = r.id AND s.status = 'generating') THEN 'generating'
      ELSE r.status
    END,
    updated_at = now()
  WHERE r.id = ANY(p_request_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_creative_missing_shots(p_shot_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF COALESCE(array_length(p_shot_ids, 1), 0) = 0 THEN RETURN; END IF;

  UPDATE public.missing_shots ms
  SET status = 'completed',
      completed_by_resolution_id = candidate.resolution_id,
      completed_at = now()
  FROM LATERAL (
    SELECT r.id AS resolution_id
    FROM public.creative_slots s
    JOIN public.creative_slot_resolutions r ON r.slot_id = s.id
    JOIN public.ai_image_generation_outputs o ON o.id = r.generation_output_id
    JOIN public.media_assets a ON a.id = r.media_asset_id
    WHERE s.missing_shot_id = ms.id
      AND r.source_kind = 'ai'
      AND r.status = 'active'
      AND o.creative_state = 'promoted'
      AND o.review_state = 'approved'
      AND a.review_state = 'approved'
    ORDER BY r.resolved_at DESC NULLS LAST, r.id
    LIMIT 1
  ) candidate
  WHERE ms.id = ANY(p_shot_ids)
    AND ms.completed_by_resolution_id IS DISTINCT FROM candidate.resolution_id;

  UPDATE public.missing_shots ms
  SET status = 'assigned', completed_by_resolution_id = NULL, completed_at = NULL
  WHERE ms.id = ANY(p_shot_ids)
    AND ms.completed_by_resolution_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.creative_slot_resolutions r
      JOIN public.ai_image_generation_outputs o ON o.id = r.generation_output_id
      JOIN public.media_assets a ON a.id = r.media_asset_id
      WHERE r.id = ms.completed_by_resolution_id
        AND r.status = 'active'
        AND o.review_state = 'approved'
        AND a.review_state = 'approved'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_creative_review_states()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_slot_ids UUID[];
  v_shot_ids UUID[];
BEGIN
  -- Transition tables make this one set-based operation for single, batch and MCP updates.
  PERFORM set_config('verity.creative_review_sync', 'true', true);
  WITH changed AS (
    SELECT n.id, n.review_state
    FROM new_rows n
    JOIN old_rows o USING (id)
    WHERE n.review_state IS DISTINCT FROM o.review_state
  ), updated AS (
    UPDATE public.ai_image_generation_outputs out
    SET review_state = CASE changed.review_state
          WHEN 'approved' THEN 'approved'
          WHEN 'rejected' THEN 'rejected'
          ELSE out.review_state
        END,
        updated_at = now()
    FROM changed
    WHERE out.media_asset_id = changed.id
    RETURNING out.id, out.generation_id, out.review_state
  ), touched AS (
    SELECT DISTINCT g.slot_id
    FROM updated u
    JOIN public.ai_image_generations g ON g.id = u.generation_id
    UNION
    SELECT DISTINCT r.slot_id
    FROM public.creative_slot_resolutions r
    JOIN changed ON changed.id = r.media_asset_id
    WHERE r.source_kind = 'library' AND r.status = 'active'
  )
  SELECT array_agg(slot_id ORDER BY slot_id) INTO v_slot_ids FROM touched;

  IF COALESCE(array_length(v_slot_ids, 1), 0) = 0 THEN
    RETURN NULL;
  END IF;

  -- Rejection dismisses the chosen resolution. Approval activates only the
  -- still-proposed resolution; a superseded proposal can never win late.
  UPDATE public.creative_slot_resolutions r
  SET status = 'dismissed', updated_at = now()
  FROM public.ai_image_generation_outputs o
  WHERE r.generation_output_id = o.id
    AND r.slot_id = ANY(v_slot_ids)
    AND r.status IN ('proposed', 'active')
    AND o.review_state = 'rejected';

  UPDATE public.creative_slot_resolutions r
  SET status = 'dismissed', updated_at = now()
  FROM public.media_assets a
  WHERE r.slot_id = ANY(v_slot_ids)
    AND r.source_kind = 'library'
    AND r.status = 'active'
    AND a.id = r.media_asset_id
    AND a.review_state = 'rejected';

  UPDATE public.creative_slot_resolutions prior
  SET status = 'superseded', updated_at = now()
  WHERE prior.slot_id IN (
    SELECT r.slot_id
    FROM public.creative_slot_resolutions r
    JOIN public.ai_image_generation_outputs o ON o.id = r.generation_output_id
    WHERE r.slot_id = ANY(v_slot_ids)
      AND r.status = 'proposed'
      AND o.review_state = 'approved'
  )
    AND prior.status = 'active';

  UPDATE public.creative_slot_resolutions r
  SET status = 'active', resolved_at = now(), updated_at = now()
  FROM public.ai_image_generation_outputs o
  WHERE r.generation_output_id = o.id
    AND r.slot_id = ANY(v_slot_ids)
    AND r.status = 'proposed'
    AND o.review_state = 'approved';

  SELECT array_agg(DISTINCT missing_shot_id ORDER BY missing_shot_id)
    INTO v_shot_ids
    FROM public.creative_slots
   WHERE id = ANY(v_slot_ids) AND missing_shot_id IS NOT NULL;

  PERFORM public.recompute_creative_slots(v_slot_ids);
  PERFORM public.sync_creative_missing_shots(v_shot_ids);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_creative_review_states ON public.media_assets;
CREATE TRIGGER trg_sync_creative_review_states
AFTER UPDATE ON public.media_assets
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.sync_creative_review_states();

-- DAM approval is immutable for a promoted candidate. Reopening a linked
-- creative asset would otherwise leave an active resolution with stale review
-- semantics; create a replacement candidate instead.
CREATE OR REPLACE FUNCTION public.guard_creative_review_reopen()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.review_state IN ('approved', 'rejected')
     AND NEW.review_state = 'pending'
     AND EXISTS (SELECT 1 FROM public.ai_image_generation_outputs o WHERE o.media_asset_id = NEW.id) THEN
    RAISE EXCEPTION 'CREATIVE_REVIEW_REOPEN_FORBIDDEN: promote a replacement candidate instead';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_creative_review_reopen ON public.media_assets;
CREATE TRIGGER trg_guard_creative_review_reopen
BEFORE UPDATE OF review_state ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.guard_creative_review_reopen();
