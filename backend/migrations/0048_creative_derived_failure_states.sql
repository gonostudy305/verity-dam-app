-- Keep creative status derivation authoritative after terminal generation
-- failures and after an approved asset is subsequently rejected.  The worker,
-- Studio, REST and MCP all read these same derived rows, so leaving the old
-- status in place would make a terminal failure appear to be in progress.

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
      WHEN EXISTS (
        SELECT 1
        FROM public.ai_image_generation_outputs o
        JOIN public.ai_image_generations g ON g.id = o.generation_id
        WHERE g.slot_id = s.id AND o.creative_state = 'candidate'
      ) THEN 'candidate_ready'
      WHEN EXISTS (
        SELECT 1 FROM public.ai_image_generations g
        WHERE g.slot_id = s.id AND g.provider_call_state IN ('queued', 'executing')
      ) THEN 'generating'
      -- No reviewable output, resolution or running attempt remains.  A prior
      -- generation means the slot has terminally failed (including ambiguous
      -- provider outcomes); otherwise it is simply unresolved/planning.
      WHEN EXISTS (SELECT 1 FROM public.ai_image_generations g WHERE g.slot_id = s.id) THEN 'failed'
      ELSE 'planning'
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
      WHEN EXISTS (SELECT 1 FROM public.creative_slots s WHERE s.request_id = r.id AND s.status = 'failed') THEN 'failed'
      ELSE 'planning'
    END,
    updated_at = now()
  WHERE r.id = ANY(p_request_ids);
END;
$$;
