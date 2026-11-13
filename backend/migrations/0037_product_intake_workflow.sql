-- 0037_product_intake_workflow.sql
--
-- Product onboarding is deliberately separate from the canonical product
-- catalog.  A contributor may describe an unknown product without creating a
-- fake SKU; a reviewer creates or confirms catalog identity atomically when
-- approving the intake.

CREATE TABLE IF NOT EXISTS public.product_intakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL,
  supplement_of_intake_id UUID NULL REFERENCES public.product_intakes(id) ON DELETE SET NULL,
  selected_product_id UUID NULL REFERENCES public.verity_products(id) ON DELETE SET NULL,
  final_product_id UUID NULL REFERENCES public.verity_products(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'needs_changes', 'approved', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  proposed_name TEXT NOT NULL DEFAULT '',
  proposed_brand TEXT NOT NULL DEFAULT '',
  proposed_model TEXT NULL,
  proposed_sku TEXT NULL,
  source_url TEXT NULL,
  notes TEXT NULL,
  reviewer_note TEXT NULL,
  final_sku TEXT NULL,
  reference_status TEXT NOT NULL DEFAULT 'none'
    CHECK (reference_status IN ('none', 'queued', 'ready', 'failed')),
  reference_error TEXT NULL,
  reference_updated_at TIMESTAMPTZ NULL,
  submitted_at TIMESTAMPTZ NULL,
  reviewed_by UUID NULL,
  reviewed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_intakes_owner_updated
  ON public.product_intakes (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_intakes_status_created
  ON public.product_intakes (status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_product_intakes_supplement_source
  ON public.product_intakes (supplement_of_intake_id)
  WHERE supplement_of_intake_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.product_intake_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id UUID NOT NULL REFERENCES public.product_intakes(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  proposed_reference BOOLEAN NOT NULL DEFAULT false,
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'rejected')),
  is_reference BOOLEAN NOT NULL DEFAULT false,
  reviewed_by UUID NULL,
  reviewed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intake_id, media_asset_id),
  UNIQUE (media_asset_id),
  CHECK (NOT is_reference OR decision = 'approved')
);

CREATE INDEX IF NOT EXISTS idx_product_intake_assets_intake
  ON public.product_intake_assets (intake_id, decision, is_reference);

CREATE TABLE IF NOT EXISTS public.product_intake_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id UUID NOT NULL REFERENCES public.product_intakes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'submitted', 'needs_changes', 'approved', 'rejected', 'reference_retry')),
  actor_id UUID NOT NULL,
  note TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_intake_decisions_intake_created
  ON public.product_intake_decisions (intake_id, created_at DESC);

-- An intake owns identity while it is open.  This stops the background
-- analyzer and legacy single-image approval paths from attaching a guessed SKU
-- or approving an image before the intake reviewer has made one coherent
-- product decision.  The intake approval transaction sets a local escape-hatch
-- GUC after it has locked the intake and verified its revision.
CREATE OR REPLACE FUNCTION public.guard_open_product_intake_asset()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF current_setting('verity.product_intake_approval', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF (OLD.sku IS DISTINCT FROM NEW.sku OR OLD.review_state IS DISTINCT FROM NEW.review_state)
     AND EXISTS (
       SELECT 1
       FROM public.product_intake_assets pia
       JOIN public.product_intakes pi ON pi.id = pia.intake_id
       WHERE pia.media_asset_id = NEW.id
         AND pi.status IN ('draft', 'submitted', 'needs_changes')
     ) THEN
    RAISE EXCEPTION 'PRODUCT_INTAKE_REVIEW_REQUIRED: asset % belongs to an open product intake', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_open_product_intake_asset ON public.media_assets;
CREATE TRIGGER trg_guard_open_product_intake_asset
BEFORE UPDATE OF sku, review_state ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION public.guard_open_product_intake_asset();

ALTER TABLE public.media_ingest_jobs
  DROP CONSTRAINT IF EXISTS media_ingest_jobs_job_kind_check;
ALTER TABLE public.media_ingest_jobs
  ADD CONSTRAINT media_ingest_jobs_job_kind_check
  CHECK (job_kind IN ('analyze_image', 'publish_wordpress', 'publish_canonical_media', 'prepare_reference'));
