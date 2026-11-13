# ADR-0037: Product-intake workflow and reference preparation

## Status

Accepted — 2026-09-10

## Decision

Authorize additive migration `0037_product_intake_workflow.sql` and the
server-side product-intake workflow. A proposed product identity, its assets,
each reviewer decision, and reference-preparation history are stored outside
the canonical catalog until a reviewer approves the dossier.

The lifecycle is `draft`, `submitted`, `needs_changes`, `approved`, and
`rejected`. Only an approved dossier can create or select an active
`verity_products` row. A second draft may be created from an approved dossier to
supplement that product with more photos; it records `supplement_of_intake_id`
for traceability and never updates catalog metadata.

`prepare_reference` is a durable worker job. It activates a reference only
when the reviewer selected the asset, its immutable source hash equals the
active-space embedding hash, and that embedding space is currently `ACTIVE`.
Reference failure keeps the product and its approved library assets usable.

## Enrichment (migration 0043)

To give the reference-embedding corpus the context it needs, migration
`0043_product_intake_enrichment.sql` adds nullable, additive columns:

- `product_intakes.proposed_category`, `proposed_space` — product-level context
  (category and space/room) sourced from the shared taxonomy facets. On
  approval, `proposed_category` seeds `verity_products.category` for a new product.
- `product_intake_assets.proposed_role`, `proposed_image_category`,
  `proposed_angle` — the uploader's per-image proposal.
- `product_intake_assets.confirmed_role`, `confirmed_image_category` — the
  reviewer's confirmation, defaulted from the proposal on approval.

The uploader proposes labels; the reviewer confirms them at approval. When a
reference is promoted, `native_gateway._complete_product_intake_reference` reads
the confirmed labels directly from `product_intake_assets` and writes them into
`public.sku_references` (`reference_role`, `image_category`) instead of the
previous hardcoded `STUDIO`/`HERO` heuristic; unlabelled legacy rows fall back
to that heuristic so they still promote correctly. `image_category` reuses the
closed `REAL`/`STUDIO`/`DESIGN` vocabulary (CHECK constraint, matching
migration 0040); `reference_role` stays app-validated to `HERO`/`ANGLE`, mirroring
`sku_references.reference_role`, which carries no DB CHECK.

## Image import from a URL

A contributor may seed a declaration with images taken from a product page URL.
No schema change was needed: `media_assets` already carries the provenance
columns from migration `0026`, and `origin_info` is `jsonb`. Two routes were
added — `/api/uploads/from-url/extract` (read the page, return candidate image
URLs) and `/api/uploads/from-url/fetch` (download the picked ones to R2) — and
the fetched descriptors then flow through the existing
`POST /api/uploads/complete`, so there is exactly one path that creates a
`media_assets` row.

Constraints that shaped it: the uploader may paste any URL, so a domain
allowlist is impossible and `src/lib/server/url-fetch-guard.ts` (extracted from
the model-probe route, hardened with manual redirect validation, byte caps and
DNS-free rejection of literal private IPs) is the only barrier. Extraction is
regex-based to avoid a runtime HTML-parsing dependency, and no headless browser
is used, so JavaScript-rendered galleries are expected to fail — the picker
falls back to a directly pasted image URL. A human always selects the images;
nothing is imported automatically. Both routes are gated by
`VERITY_PRODUCT_INTAKES_ENABLED`, keeping the capability inside the declaration
flow; the old-product and bulk paths are deliberately out of scope.

The copyright question is handled by disclosure rather than by code: imported
assets keep their source URL and are badged with it in the review panel, so the
reviewer decides per image whether it may be used or published.

## Rationale

The ordinary review queue decides one asset at a time and previously allowed
AI-generated SKU suggestions to become catalog identity. A new product needs
one atomic human decision across its identity and all uploaded assets, while
reference availability must remain separate from whether that product can be
used in the library.

## Consequences

- Open intake assets cannot have `sku` or `review_state` changed by analysis or
  legacy web/MCP review paths; the controlled approval transaction is the only
  exception.
- The migration is additive and leaves historical media, catalog rows,
  embedding spaces, and the frozen benchmark corpus unchanged.
- The feature stays disabled until migration `0037` and worker support are
  deployed, then `VERITY_PRODUCT_INTAKES_ENABLED=true` is set deliberately.
- Rollout requires the integration scenarios in
  `docs/product-intake-runbook.md`, including duplicate SKU contention and
  reference provenance checks.
