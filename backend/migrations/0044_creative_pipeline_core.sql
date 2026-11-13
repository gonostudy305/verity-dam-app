-- 0044_creative_pipeline_core.sql
--
-- Durable, additive backbone for the multi-brand AI Creative Pipeline.
-- Creative work deliberately has its own job queue: media_ingest_jobs requires
-- a media_asset_id and must never be used for pre-asset generation attempts.

CREATE TABLE IF NOT EXISTS public.creative_content_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 TEXT NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.creative_brand_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.creative_brand_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id UUID NOT NULL REFERENCES public.creative_brand_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'retired')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE (brand_profile_id, version)
);

CREATE TABLE IF NOT EXISTS public.creative_brand_version_assets (
  brand_version_id UUID NOT NULL REFERENCES public.creative_brand_versions(id) ON DELETE CASCADE,
  content_asset_id UUID NOT NULL REFERENCES public.creative_content_assets(id) ON DELETE RESTRICT,
  asset_role TEXT NOT NULL CHECK (asset_role IN ('logo_primary', 'logo_inverse', 'font', 'style_reference')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_version_id, content_asset_id, asset_role)
);

CREATE TABLE IF NOT EXISTS public.creative_channel_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.creative_channel_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_profile_id UUID NOT NULL REFERENCES public.creative_channel_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'retired')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE (channel_profile_id, version)
);

CREATE TABLE IF NOT EXISTS public.creative_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.creative_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES public.creative_templates(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'retired')),
  template_family TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_hash TEXT NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS public.creative_template_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id UUID NOT NULL REFERENCES public.creative_template_versions(id) ON DELETE CASCADE,
  brand_version_id UUID NULL REFERENCES public.creative_brand_versions(id) ON DELETE CASCADE,
  channel_version_id UUID NULL REFERENCES public.creative_channel_versions(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (brand_version_id IS NOT NULL OR channel_version_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (template_version_id, brand_version_id, channel_version_id)
);

CREATE TABLE IF NOT EXISTS public.creative_product_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.verity_products(id) ON DELETE RESTRICT,
  media_asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  reference_role TEXT NOT NULL CHECK (reference_role IN ('identity', 'cutout', 'style')),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'retired')),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ NULL,
  UNIQUE (product_id, media_asset_id, reference_role)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_product_reference_active_identity
  ON public.creative_product_references(product_id)
  WHERE reference_role = 'identity' AND status = 'approved';

CREATE TABLE IF NOT EXISTS public.creative_budget_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_profile_id UUID NOT NULL REFERENCES public.creative_brand_profiles(id) ON DELETE RESTRICT,
  period_start DATE NOT NULL,
  hard_cap_minor BIGINT NOT NULL CHECK (hard_cap_minor >= 0),
  soft_alert_percent SMALLINT NOT NULL DEFAULT 70 CHECK (soft_alert_percent BETWEEN 1 AND 99),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand_profile_id, period_start)
);

CREATE TABLE IF NOT EXISTS public.creative_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_version_id UUID NOT NULL REFERENCES public.creative_brand_versions(id) ON DELETE RESTRICT,
  channel_version_id UUID NOT NULL REFERENCES public.creative_channel_versions(id) ON DELETE RESTRICT,
  budget_period_id UUID NULL REFERENCES public.creative_budget_periods(id) ON DELETE RESTRICT,
  external_source TEXT NOT NULL,
  external_article_id TEXT NULL,
  external_revision TEXT NULL,
  supersedes_revision TEXT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_hash_version TEXT NOT NULL DEFAULT 'jcs-sha256-v1',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'generating', 'candidate_ready', 'awaiting_review', 'resolved', 'failed', 'superseded_for_placement', 'cancelled')),
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_source, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_request_article_revision
  ON public.creative_requests(external_source, external_article_id, external_revision)
  WHERE external_article_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.creative_article_heads (
  external_source TEXT NOT NULL,
  external_article_id TEXT NOT NULL,
  current_revision TEXT NOT NULL,
  current_request_id UUID NOT NULL REFERENCES public.creative_requests(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (external_source, external_article_id)
);

CREATE TABLE IF NOT EXISTS public.creative_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.creative_requests(id) ON DELETE CASCADE,
  slot_key TEXT NOT NULL,
  slot_kind TEXT NOT NULL CHECK (slot_kind IN ('thumbnail', 'section')),
  template_version_id UUID NOT NULL REFERENCES public.creative_template_versions(id) ON DELETE RESTRICT,
  template_selection_reason JSONB NOT NULL DEFAULT '{}'::jsonb,
  selection_seed TEXT NOT NULL,
  target_product_id UUID NULL REFERENCES public.verity_products(id) ON DELETE RESTRICT,
  missing_shot_id UUID NULL REFERENCES public.missing_shots(id) ON DELETE RESTRICT,
  source_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  fidelity_mode TEXT NOT NULL DEFAULT 'reference_generate' CHECK (fidelity_mode IN ('preserve_pixels', 'reference_generate')),
  content_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'generating', 'candidate_ready', 'awaiting_review', 'resolved', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, slot_key)
);
CREATE INDEX IF NOT EXISTS idx_creative_slots_request ON public.creative_slots(request_id, slot_key);
CREATE INDEX IF NOT EXISTS idx_creative_slots_missing_shot ON public.creative_slots(missing_shot_id) WHERE missing_shot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ai_image_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES public.creative_slots(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_hash TEXT NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  reference_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_call_state TEXT NOT NULL DEFAULT 'queued' CHECK (provider_call_state IN ('queued', 'executing', 'succeeded', 'failed', 'uncertain', 'cancelled')),
  retry_class TEXT NULL CHECK (retry_class IN ('safe_retry', 'do_not_retry', 'ambiguous')),
  provider_request_id TEXT NULL,
  error_code TEXT NULL,
  error_detail TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (slot_id, attempt_no)
);

CREATE TABLE IF NOT EXISTS public.ai_image_generation_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES public.ai_image_generations(id) ON DELETE CASCADE,
  candidate_index INTEGER NOT NULL CHECK (candidate_index >= 0),
  creative_state TEXT NOT NULL DEFAULT 'candidate' CHECK (creative_state IN ('candidate', 'promoted', 'expired')),
  review_state TEXT NOT NULL DEFAULT 'not_submitted' CHECK (review_state IN ('not_submitted', 'pending', 'approved', 'rejected')),
  temp_storage_key TEXT NOT NULL,
  temp_sha256 TEXT NOT NULL CHECK (temp_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_storage_key TEXT NULL,
  canonical_sha256 TEXT NULL CHECK (canonical_sha256 IS NULL OR canonical_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days',
  media_asset_id UUID NULL REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (generation_id, candidate_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_generation_output_media_asset
  ON public.ai_image_generation_outputs(media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_generation_outputs_expiry
  ON public.ai_image_generation_outputs(expires_at) WHERE creative_state = 'candidate';

CREATE TABLE IF NOT EXISTS public.creative_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL UNIQUE REFERENCES public.ai_image_generations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'blocked', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ NULL,
  locked_by TEXT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_generation_jobs_claim
  ON public.creative_generation_jobs(status, run_after, created_at) WHERE status IN ('queued', 'processing');

CREATE TABLE IF NOT EXISTS public.creative_slot_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL REFERENCES public.creative_slots(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('library', 'ai')),
  media_asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  generation_output_id UUID NULL REFERENCES public.ai_image_generation_outputs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'superseded', 'dismissed')),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'library' AND generation_output_id IS NULL) OR (source_kind = 'ai' AND generation_output_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_resolution_output
  ON public.creative_slot_resolutions(generation_output_id) WHERE generation_output_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_resolution_proposed_slot
  ON public.creative_slot_resolutions(slot_id) WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_creative_resolution_active_slot
  ON public.creative_slot_resolutions(slot_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.creative_budget_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_period_id UUID NOT NULL REFERENCES public.creative_budget_periods(id) ON DELETE RESTRICT,
  generation_id UUID NOT NULL UNIQUE REFERENCES public.ai_image_generations(id) ON DELETE RESTRICT,
  reserved_minor BIGINT NOT NULL CHECK (reserved_minor >= 0),
  actual_minor BIGINT NULL CHECK (actual_minor >= 0),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released', 'held_unknown', 'resolved_spent', 'resolved_not_spent')),
  resolution_reason TEXT NULL,
  resolved_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_budget_reservation_period
  ON public.creative_budget_reservations(budget_period_id, status);

CREATE TABLE IF NOT EXISTS public.creative_storage_sagas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  output_id UUID NOT NULL UNIQUE REFERENCES public.ai_image_generation_outputs(id) ON DELETE CASCADE,
  temp_storage_key TEXT NOT NULL,
  canonical_storage_key TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending_copy' CHECK (state IN ('pending_copy', 'copied', 'verified', 'db_finalized', 'cleanup_pending', 'complete', 'failed')),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS public.creative_placement_usages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE RESTRICT,
  channel_version_id UUID NOT NULL REFERENCES public.creative_channel_versions(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL REFERENCES public.creative_requests(id) ON DELETE RESTRICT,
  slot_id UUID NOT NULL REFERENCES public.creative_slots(id) ON DELETE RESTRICT,
  external_article_id TEXT NULL,
  external_revision TEXT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  confirmed_by_consumer_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, slot_id)
);
CREATE INDEX IF NOT EXISTS idx_creative_placement_rotation
  ON public.creative_placement_usages(media_asset_id, channel_version_id, published_at DESC);

CREATE TABLE IF NOT EXISTS public.creative_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NULL REFERENCES public.creative_requests(id) ON DELETE CASCADE,
  generation_id UUID NULL REFERENCES public.ai_image_generations(id) ON DELETE CASCADE,
  output_id UUID NULL REFERENCES public.ai_image_generation_outputs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id UUID NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_audit_request_created ON public.creative_audit_events(request_id, created_at DESC);

ALTER TABLE public.missing_shots
  ADD COLUMN IF NOT EXISTS completed_by_resolution_id UUID NULL REFERENCES public.creative_slot_resolutions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

