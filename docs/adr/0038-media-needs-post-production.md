# ADR-0038: Media asset needs-post-production flag

## Status

Accepted — 2026-09-11

## Decision

Authorize additive migration `0038_media_needs_post_production.sql`. Adds a
persistent boolean column `needs_post_production BOOLEAN NOT NULL DEFAULT false`
to `public.media_assets` along with a partial index
`idx_media_assets_needs_post_production` on `needs_post_production WHERE needs_post_production`.

The flag is an internal operational marker ("Cần Hậu kỳ") accessible across the
DAM library interface. It introduces no new queue, no approval state machine,
and no resolver workflow.

Toggling is gated at `requireNativeReviewer()` via `PATCH /api/media/[id]`,
matching existing title and crop update authorizations in the Detail Drawer.
The flag does not write to `review_correction_log` and does not affect
few-shot AI vision examples.

## Rationale

Internal staff and marketing operators need to flag raw or suboptimal photos
that require retouching or post-production editing before being utilized in
external marketing materials. Storing this state as a first-class boolean on
`media_assets` mirrors the precedent set by `is_duplicate` and avoids burying
actionable workflow markers in untyped `ai_flags` jsonb.

## Consequences

- Additive migration that leaves historical media assets, catalog rows,
  embedding spaces, and frozen benchmark references untouched.
- `GET /api/media` supports filtering via `only_needs_post_production=true`.
- The field is exposed in `MediaAsset` types and mapped explicitly in
  `src/lib/server/media-mapper.ts` and `src/lib/server/native-media.ts`.
- Raises `FROZEN_MAX_NATIVE_MIGRATION_ID` from 37 to 38.
