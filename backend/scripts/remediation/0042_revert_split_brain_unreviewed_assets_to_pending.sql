-- Migration 0042: Revert split-brain unreviewed assets without SKU to pending state
--
-- Context:
-- During Google Drive batch ingest (e.g. gdrive-lyra-v22-202609100500),
-- non-duplicate assets were inserted with `review_state = 'approved'` into `media_assets`
-- even when AI SKU confidence was low/ambiguous, while their corresponding `review_queue`
-- entry was correctly marked `status = 'pending'`.
--
-- This caused 110 unconfirmed assets with `sku IS NULL` to bypass review gating and
-- appear prematurely in `/library` with "Chưa gắn SKU".
--
-- This script safely moves these unreviewed assets back to `review_state = 'pending'`
-- so reviewers can properly review and assign SKUs via `/review`.

BEGIN;

-- 1. Create temporary table of target asset IDs for auditing & verification
CREATE TEMP TABLE tmp_split_brain_assets ON COMMIT DROP AS
SELECT ma.id, ma.brand, ma.category, ma.title
FROM public.media_assets ma
JOIN public.review_queue rq ON rq.media_asset_id = ma.id
WHERE ma.review_state = 'approved'
  AND (ma.sku IS NULL OR trim(ma.sku) = '')
  AND ma.deleted_at IS NULL
  AND rq.status = 'pending'
  AND rq.reviewed_by IS NULL;

-- 2. Audit check: log the number of targeted assets
DO $$
DECLARE
    target_count INTEGER;
BEGIN
    SELECT count(*) INTO target_count FROM tmp_split_brain_assets;
    RAISE NOTICE 'Found % split-brain assets to synchronize back to pending.', target_count;
END $$;

-- 3. Synchronize media_assets state back to pending
UPDATE public.media_assets ma
SET review_state = 'pending',
    updated_at = now()
FROM tmp_split_brain_assets t
WHERE ma.id = t.id;

-- 4. Post-verification: Ensure no split-brain records remain
DO $$
DECLARE
    remaining_count INTEGER;
BEGIN
    SELECT count(*) INTO remaining_count
    FROM public.media_assets ma
    JOIN public.review_queue rq ON rq.media_asset_id = ma.id
    WHERE ma.review_state = 'approved'
      AND (ma.sku IS NULL OR trim(ma.sku) = '')
      AND ma.deleted_at IS NULL
      AND rq.status = 'pending'
      AND rq.reviewed_by IS NULL;

    IF remaining_count > 0 THEN
        RAISE EXCEPTION 'Verification failed: % split-brain assets still remain!', remaining_count;
    END IF;

    RAISE NOTICE 'Verification passed: All targeted assets successfully moved to pending.';
END $$;

COMMIT;
