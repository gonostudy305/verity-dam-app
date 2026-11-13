-- 0039_asset_reports.sql
--
-- Additive migration: adds asset_reports and asset_report_events tables
-- for reporting quality, SKU, metadata, and link correctness issues.
-- Authorized by docs/adr/0039-asset-reports.md.

CREATE TABLE IF NOT EXISTS public.asset_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id  UUID NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
  reported_by     UUID NOT NULL,
  report_reason   TEXT NOT NULL
    CHECK (report_reason IN ('wrong_sku', 'wrong_recognition', 'wrong_url', 'other')),
  report_note     TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
  resolved_by     UUID NULL,
  resolved_at     TIMESTAMPTZ NULL,
  resolution_note TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index for open/in_review reports (serves search and MCP protection)
CREATE INDEX IF NOT EXISTS idx_asset_reports_open_by_asset
  ON public.asset_reports (media_asset_id)
  WHERE status IN ('open', 'in_review');

-- Index for status-filtered triage queue listing
CREATE INDEX IF NOT EXISTS idx_asset_reports_status_created
  ON public.asset_reports (status, created_at ASC);

CREATE TABLE IF NOT EXISTS public.asset_report_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id  UUID NOT NULL REFERENCES public.asset_reports(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id   UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_report_events_report
  ON public.asset_report_events (report_id, created_at ASC);
