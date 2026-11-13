# VerityDAM backend

The native backend worker leases durable PostgreSQL jobs, reads private source
objects from Cloudflare R2, computes pHash and the canonical SigLIP2 embedding,
runs Vision metadata, and publishes approved renditions. It uses native
PostgreSQL/R2 boundaries and Better Auth/server-side authorization. Supabase
and PostgREST code is compatibility or historical material, not the active
production path.

## Production embedding profile

- Profile/provider: `local_siglip2`
- Model: `siglip2-b32-256-webli`, version `v1`
- Space: `verity-siglip2-b32-256-webli-v1`
- Dimension: `768`
- Runtime: pinned SigLIP2 ONNX vision/text artifacts, CPU execution provider
- Identity/provenance: `backend/benchmarks/siglip2/artifact_manifest.json`

The runtime verifies model identity, dimensions, finite/non-zero output and
artifact provenance. Do not mix DataComp 512-d, personal CLIP or any external
embedding output into the active production space. A model, dimension or
preprocessing change requires a new versioned space and a full re-embedding.

## Services and data boundaries

| Service | Responsibility |
| --- | --- |
| `verity_native_media_app` | Next.js App Router, native APIs, Better Auth, R2 access |
| `verity_native_media_worker` | Durable analysis, Vision, pHash, embedding, publication jobs |
| `verity_native_media_creative_worker` | Isolated AI image generation, budget reservation, R2 candidate storage and TTL cleanup |
| `verity_native_media_mcp` | MCP HTTP/stdio tools and agent access through native gateway |
| `verity_native_media_embedding` | Isolated synchronous SigLIP2 vision/text runtime |
| `verity_native_media_db` | PostgreSQL 16 + pgvector, catalog, review, audit and usage data |

The public CDN is `https://assets.verity.internal`; the web/MCP canonical domain is
`https://dam.verity.internal`. Original bytes and renditions live in R2; metadata
and vectors live in PostgreSQL.

## Development and deployment

Install production dependencies:

```bash
cd backend
python -m pip install -r requirements.txt
```

Apply the ordered native migrations against the intended database:

```bash
python -m scripts.apply_native_migrations --dry-run
python -m scripts.apply_native_migrations
```

The last recorded production migration head is `0037_product_intake_workflow.sql`.
The creative pipeline is additive and staged in migrations `0044`–`0047`; the
next deploy applies them through the same checksum-protected migration gate.
Deploy only a committed immutable release using the reviewed VPS script:

```powershell
powershell -File your deployment script
```

Never commit `.env` files or expose database, R2, Vision or embedding
credentials to `NEXT_PUBLIC_*`. Shared Vision and Creative provider keys are
stored encrypted and used server-side.

## SKU matching and references

`sku_references` plus `reference_embeddings` is the canonical reference corpus.
Every candidate SKU must have an active eligible primary anchor. The matcher
uses the active SigLIP2 space and fails closed on low confidence, a small
runner-up margin, missing provenance or missing embeddings.

`media_asset_products` is the canonical many-to-many product relation;
`media_assets.sku` remains a transitional primary-SKU/cache field. Scenes,
banners and multi-product images may legitimately have no single SKU.

Run the read-only production audit before reconciliation:

```bash
python -m scripts.audit_sku_reconciliation --all-assets --json-out report.json
```

The audit reports possible corrections and reference gaps but never mutates
production. Human/catalog evidence is required before changing identity or
promoting a reference.

## Local-only tools

`requirements-local.txt`, `app/embed.py` and legacy local reference seeders are
for isolated experiments only. They must not run the production worker or write
to the company PostgreSQL/R2 data plane.
