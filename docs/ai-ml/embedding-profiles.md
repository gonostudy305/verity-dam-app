# Embedding profiles

Verity production has one canonical active image/text embedding space. Older
DataComp and external-API descriptions in historical plans must not be used as
current deployment instructions.

## Profiles and boundaries

| Profile | Runs on | Model/artifact | Production writes |
| --- | --- | --- | --- |
| `local_siglip2` | VPS worker, MCP image runtime, curated local importer | Pinned SigLIP2 ONNX, 768-d | Allowed in `verity-siglip2-b32-256-webli-v1` |
| `local_openclip` | Compatibility/legacy tooling only | OpenCLIP DataComp, 512-d | Not the current active production space |
| `local_clip` | Personal workstation experiments | `sentence-transformers`/CLIP tooling | Forbidden |

The production contract is:

- profile/provider: `local_siglip2`
- model: `siglip2-b32-256-webli`
- model identity: `timm/ViT-B-32-SigLIP2-256`
- revision: `cd1efb47643f2794413dd79ef24397c175032780`
- version: `v1`
- space: `verity-siglip2-b32-256-webli-v1`
- dimension: `768`
- preprocessing: RGB, squash resize to 256×256, bicubic, mean/std 0.5/0.5
- runtime: ONNX Runtime with the CPU execution provider

The single source of truth for runtime artifact identity and hashes is
`backend/benchmarks/siglip2/artifact_manifest.json`. The vision graph and
external data are byte-hash verified. The text graph is verified structurally;
the reason is disclosed in `backend/app/siglip2_runtime.py`.

## Where embeddings are used

- `backend/app/worker.py` computes the production asset embedding.
- `backend/verity_media_mcp/embedding.py` embeds fresh MCP image bytes using the
  configured runtime.
- `backend/importers/google_drive/local_embedder.py` provides the local curated
  lane and must stay byte/preprocess compatible with production.
- `asset_embeddings` stores asset vectors by `(asset_id, space_id, kind)`.
- `reference_embeddings` stores vectors for `sku_references`.

The current VPS compose mounts the pinned artifact for the worker and the
isolated embedding runtime, but not for the MCP container. Consequently MCP
fresh-image (`image_base64`) search fails closed until a reviewed artifact mount
and health gate are deployed; MCP asset-ID search uses the stored vector.

Production reads and writes must verify space, dimension, source hash and
finite non-zero vector values. A model or preprocessing change requires a new
versioned space and a complete re-embedding; do not change dimensions through
an environment toggle.

## SKU reference boundary

Vision can produce model hints, OCR/visible text and confidence, but Vision
output is not catalog identity. A SKU becomes confirmed through an approved
catalog/product-link or the controlled reference-matching path. The matcher
fails closed for missing embeddings, missing primary anchors, low confidence,
small runner-up margin or provenance mismatch.

`media_asset_products` is the canonical many-to-many relation. The
`media_assets.sku` field is retained as a transitional primary-SKU/cache field;
it may remain empty for scenes, banners and multi-product assets.

Reference corpus rules:

- `HERO`/`ANGLE` studio images are the main identity corpus.
- Installation references need verified SKU and should be scoped to real-world
  matching rather than blindly mixed with studio identity.
- Banner, multi-product, people-heavy and unclassified images are not automatic
  references.
- Every eligible reference needs traceable source provenance, matching active
  space and a human-verifiable SKU.

Run the read-only production reconciliation audit before any correction batch:

```bash
cd backend
python -m scripts.audit_sku_reconciliation --all-assets --json-out report.json
```

The report never mutates production. Do not promote its top result without
reviewing the image, catalog identity, brand evidence and score margin.

## Vision provider key

The Vision provider configuration is stored encrypted in native PostgreSQL and
read only by server-side routes/worker code. The browser receives metadata, not
the provider key or ciphertext. The current Drive importer default model is
`cx/gpt-5.6-luna`; the active runtime provider remains the configured server
setting and must be verified from production settings before a batch.

Do not put any Vision, embedding, database or R2 credential in git,
`NEXT_PUBLIC_*`, local reference exports or public object names.
