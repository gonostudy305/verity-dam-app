-- Explicit Library eligibility is intentionally separate from DAM review.
-- An approved DAM asset is not automatically suitable for every brand/channel.

CREATE TABLE IF NOT EXISTS public.creative_library_asset_eligibilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  brand_version_id UUID NOT NULL REFERENCES public.creative_brand_versions(id) ON DELETE RESTRICT,
  channel_version_id UUID NULL REFERENCES public.creative_channel_versions(id) ON DELETE RESTRICT,
  product_id UUID NULL REFERENCES public.verity_products(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  score_bias INTEGER NOT NULL DEFAULT 0 CHECK (score_bias BETWEEN -1000 AND 1000),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE NULLS NOT DISTINCT (media_asset_id, brand_version_id, channel_version_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_creative_library_asset_eligibility_lookup
  ON public.creative_library_asset_eligibilities(brand_version_id, channel_version_id, product_id, score_bias DESC)
  WHERE status = 'active';

-- Records exact-key cleanup only; never use an object-store prefix scan for a
-- failed promotion saga because that could remove a concurrent retry's object.
CREATE TABLE IF NOT EXISTS public.creative_storage_cleanup_events (
  saga_id UUID NOT NULL REFERENCES public.creative_storage_sagas(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  cleanup_kind TEXT NOT NULL CHECK (cleanup_kind IN ('expired_temp', 'orphan_canonical')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (saga_id, object_key)
);

CREATE OR REPLACE FUNCTION public.guard_creative_library_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.media_assets a
    WHERE a.id = NEW.media_asset_id
      AND a.deleted_at IS NULL
      AND a.review_state = 'approved'
  ) THEN
    RAISE EXCEPTION 'CREATIVE_LIBRARY_ELIGIBILITY_REQUIRES_APPROVED_ASSET';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_creative_library_eligibility ON public.creative_library_asset_eligibilities;
CREATE TRIGGER trg_guard_creative_library_eligibility
BEFORE INSERT OR UPDATE OF media_asset_id, status ON public.creative_library_asset_eligibilities
FOR EACH ROW EXECUTE FUNCTION public.guard_creative_library_eligibility();
