# ADR-0039: Asset issue reports and audit trail

## Status

Accepted — 2026-09-11

## Decision

Authorize additive migration `0039_asset_reports.sql` and the internal issue
reporting data model. Adds two independent tables:

1. `public.asset_reports`: holds individual report submissions from authenticated
   users across four correctness axes:
   - `wrong_sku`: Mismatched or incorrect product SKU code
   - `wrong_recognition`: AI Vision description, detected space, or tags incorrect
   - `wrong_url`: Dead image link or broken asset URL
   - `other`: Free-form quality issue requiring `report_note`

2. `public.asset_report_events`: immutable audit log recording lifecycle state
   transitions (`created`, `in_review`, `resolved`, `dismissed`).

Reports are grouped by `media_asset_id` on review triage surfaces. Resolving an
issue deep-links to the standard media editor flow (which feeds the AI training loop
via `review_correction_log`), keeping resolution DRY and audited.

## Rationale

The previous codebase carried a dead boolean key `ai_flags.is_broken`, but lacked
provenance on who reported an issue, when, why, and how many times. Storing reports
in dedicated tables mirrors the two-table precedent from `media_dedup_clusters` and
`media_dedup_cluster_events`.

## Consequences

- Additive migration that leaves historical media, catalog rows, and embedding spaces untouched.
- `POST /api/asset-reports` is open to all authenticated roles (`viewer+`).
- `GET` and `PATCH` are restricted to `reviewer+`.
- Enables Phase 05 search protection: open reports hard-exclude assets from MCP tools while flagging them with warning badges in the human library view.
- Raises `FROZEN_MAX_NATIVE_MIGRATION_ID` from 38 to 39.
