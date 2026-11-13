# Verity production media pipeline

**Current runtime:** native PostgreSQL 16 + pgvector, Cloudflare R2, Better
Auth, Next.js and the Python durable worker.

For dated migration history, see [current-system-state.md](current-system-state.md).
This document is the operational pipeline contract; old Supabase/OpenCLIP notes
are historical.

## End-to-end flow

```text
R2 presigned upload
  -> durable analyze_image job
  -> pHash + local SigLIP2 image embedding + Vision metadata
  -> SKU/reference and duplicate gates
  -> review queue
  -> human decision and product links
  -> approved canonical asset
  -> canonical renditions / WordPress export / R2 CDN
```

The Google Drive curated lane performs the same provenance checks locally before
calling the production finalize gateway. It may leave an ambiguous SKU
unassigned; an image with several products must use product links rather than a
guessed single `media_assets.sku`.

## Canonical embedding contract

Production uses one active image embedding contract:

| Field | Value |
| --- | --- |
| Profile | `local_siglip2` |
| Provider | `local_siglip2` |
| Model | `siglip2-b32-256-webli` |
| Model identity | `timm/ViT-B-32-SigLIP2-256` |
| Revision | `cd1efb47643f2794413dd79ef24397c175032780` |
| Version | `v1` |
| Space | `verity-siglip2-b32-256-webli-v1` |
| Dimension | `768` |
| Image input | RGB, squash resize to 256×256, bicubic, mean/std 0.5/0.5 |
| Runtime | ONNX Runtime, CPU execution provider |

The identity and artifact hashes are controlled by
`backend/benchmarks/siglip2/artifact_manifest.json`. The vision graph and
external data are hash-verified; the text graph is structurally verified as
documented in `backend/app/siglip2_runtime.py`. A wrong model, dimension,
preprocessing contract or space is fail-closed and requires a new versioned
space, not an environment toggle.

The worker and curated importer have the model artifact available. The current
MCP VPS service does not mount the vision artifact, therefore fresh MCP
`image_base64` similarity queries are not production-ready; asset-ID queries
reuse stored vectors and remain the supported MCP visual-search path.

## Vision metadata

Vision runs independently of embedding. Its output may enrich title, caption,
description, keywords, visible text, category, space, safety flags and
confidence. Vision is evidence, not catalog identity: it cannot by itself
confirm a SKU or promote a reference.

The current Drive importer default is `cx/gpt-5.6-luna`; production runtime
configuration is read from the encrypted server-side Vision settings. No API
key belongs in the browser bundle, committed `.env` files or R2 object names.

## SKU matching and references

The canonical matcher reads `sku_references` joined to
`reference_embeddings` in the active SigLIP2 space. Candidate SKUs must have an
active, eligible primary anchor. Ranking uses the production reference score
combination; a high score with a small runner-up margin remains a review
proposal.

Reference policy:

- `HERO` and `ANGLE` studio images are the identity corpus.
- Confirmed `INSTALLATION/REAL` images should be used for real-world context
  matching, not blindly mixed into studio matching.
- `BANNER`, `MULTI_PRODUCT`, people-heavy or unclassified images are not
  automatic SKU references.
- A reference must have a verified SKU, active-space embedding, matching source
  hash and traceable source provenance.

`media_asset_products` is the canonical many-to-many relation. The legacy
`media_assets.sku` field remains a transitional primary-SKU/cache field and may
be empty for scenes, banners and multi-product images.

The read-only reconciliation command is:

```bash
cd backend
python -m scripts.audit_sku_reconciliation --all-assets --json-out report.json
```

It never updates production. Review its score, margin, title, brand, category
and catalog evidence before applying any identity correction.

## Taxonomy and review policy

The three top-level media categories are:

- `Ảnh thực tế` — installation, showroom and real-world scenes
- `Ảnh Studio` — controlled product/catalog photography
- `Ảnh Thiết kế` — banners, renders and mockups

The live taxonomy is stored in `verity_taxonomy_options`; the frontend fallback
is in `src/config/taxonomy.ts`. Legacy labels can remain in migration history
or old rows and must be mapped deliberately during backfill.

Reviewers may correct metadata, confirm/reject product links, select reference
assets and approve the final asset. Automatic gates fail closed on low
confidence, missing embeddings, provenance mismatch, duplicate conflict or
ambiguous product identity.

## Storage, publication and recovery

- Originals and canonical renditions are stored in Cloudflare R2.
- Public delivery uses `https://assets.verity.internal`.
- The web application and MCP canonical domain is `https://dam.verity.internal`.
- Approved publication/export paths verify R2 object existence and canonical
  metadata before exposing a URL.
- Soft delete keeps relational rows and R2 objects recoverable; active reads
  exclude deleted assets.
- R2 cleanup must be explicit and scoped to obsolete rendition keys. Never
  delete an old object before the replacement has passed HEAD/hash checks.

## Deployment order

1. Build and deploy a committed immutable release with
   your deployment script.
2. Run native migration dry-run and apply through
   `scripts.apply_native_migrations`; the current production head is `0037`.
3. Verify PostgreSQL/R2/worker/MCP health and the active embedding runtime.
4. Run a bounded image batch and inspect provenance, metadata, product links,
   references and R2 objects.
5. Only then widen the batch or enable a feature flag.

Do not use the old Supabase compose path or personal local-CLIP tooling for
production writes.
