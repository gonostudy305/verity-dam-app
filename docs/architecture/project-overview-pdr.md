# VerityDAM — Project Overview & PDR

**Document status:** current product brief, updated 2026-09-11

For live deployment facts, see [current-system-state.md](current-system-state.md).
This PDR describes product intent and current scope; it is not a substitute for
the production runbook or migration ledger.

## 1. Product purpose

VerityDAM is the internal DAM and media intelligence system for Verity Smart
Home. It gives marketing, sales, technical and content teams one governed place
to ingest images, enrich metadata, review safety and identity, find the right
asset, publish it and audit its use.

The system is designed for two related but separate outcomes:

1. Reliable human asset operations: a correct file, URL, metadata, product
   relation, permission and usage history.
2. Better agent/search retrieval: evidence-backed lexical and semantic search
   over a curated, provenance-safe image corpus.

## 2. Users and roles

| Role | Primary need | Native access |
| --- | --- | --- |
| Viewer | Find approved assets | Read approved, active library assets |
| Contributor | Upload and enrich assets | Upload, Vision proxy and own workflow actions |
| Reviewer | Correct and approve metadata/identity | Review queue, product links, duplicate/safety decisions |
| Admin | Govern the platform | Configuration, provisioning, migration and operational controls |
| AI agent | Retrieve and record use | MCP tools subject to native role/service authorization |

## 3. Scope

### In scope

- Batch image upload and curated Google Drive ingestion.
- Zalo/clipboard intake through the web upload flow.
- R2 object storage, canonical URLs and recoverable publication.
- Vision metadata enrichment and human correction.
- pHash/deduplication review signals and people-safety flags.
- Native PostgreSQL/pgvector search and SKU-reference matching.
- Three-level operational governance: permissions, review and audit.
- WordPress export payloads and MCP agent access.
- Usage tracking for website, CRM, social and other publication channels.

### Not a promise of this repository

- Google Images ranking or a guaranteed Top 1–3 position.
- Landing-page content, alt text, image sitemap or Search Console operations on
  the separate WordPress public site.
- Automatic truth from Vision alone.
- A single SKU for a banner, comparison graphic, multi-product image or
  ambiguous real-world scene.

## 4. Product identity and media taxonomy

The live system has three top-level media categories:

| Category | Typical branches | Meaning |
| --- | --- | --- |
| `Ảnh thực tế` | Công trình, Showroom, Hiện trường | Installed or real-world context |
| `Ảnh Studio` | Sản phẩm chính, Chi tiết, Bao bì | Controlled product/catalog photography |
| `Ảnh Thiết kế` | Banner, Render 3D, Mockup | Designed or synthetic marketing artwork |

Branches are contextual metadata. A multi-product image uses the canonical
`media_asset_products` many-to-many links; `media_assets.sku` is only a
transitional single-SKU/cache field and can remain empty.

## 5. Current architecture

- Next.js `15.5.25` App Router and TypeScript provide the web/API layer.
- Better Auth sessions and native server-side role checks protect requests.
- PostgreSQL 16 + pgvector is the production database.
- Cloudflare R2 stores originals and canonical renditions.
- A Python durable worker performs pHash, Vision, embedding, dedup and
  publication jobs.
- The MCP service exposes agent-facing media/search/publishing/audit tools.
- The product intake workflow is deployed with migration 0037 but its
  production feature flag is currently disabled.

## 6. Canonical AI contract

All production image and reference vectors use one pinned contract:

- profile/provider: `local_siglip2`
- model: `siglip2-b32-256-webli`
- model identity: `timm/ViT-B-32-SigLIP2-256`
- revision: `cd1efb47643f2794413dd79ef24397c175032780`
- version: `v1`
- space: `verity-siglip2-b32-256-webli-v1`
- dimension: `768`
- runtime: pinned ONNX artifacts, CPU execution provider

The Google Drive importer runs the same local model contract before finalizing a
bundle. Vision enriches descriptive fields and evidence; catalog identity must
come from explicit product context, eligible references and/or human review.

## 7. Functional requirements

### Ingest and storage

- Presign scoped R2 uploads and verify object existence/hash before finalization.
- Persist source provenance, content hash, dimensions, MIME type and canonical
  URL data.
- Make retries idempotent and keep old R2 objects recoverable until replacement
  verification succeeds.

### Enrichment and review

- Generate title, caption, technical description, keywords, visible text,
  category, space and safety flags.
- Show low-confidence fields and people flags to reviewers.
- Preserve reviewer corrections on retry; never overwrite non-empty human data
  with a fresh AI suggestion without an explicit policy.
- Fail closed on missing embedding, provenance mismatch, duplicate conflict or
  ambiguous SKU.

### Retrieval and references

- Combine lexical/entity search with semantic retrieval, fusion and MMR.
- Require an active eligible primary reference for SKU candidate matching.
- Keep reference corpus promotion traceable to verified SKU/product context.
- Measure quality with a holdout/golden set; counts and cosine score alone are
  not accuracy proof.

### Publication

- Expose only approved active assets to viewer/publication paths.
- Generate canonical ImageObject/export data from the persisted asset contract.
- Record usage and retain recoverable storage state.

## 8. Delivery status

| Area | Status |
| --- | --- |
| Native PostgreSQL/R2/Better Auth runtime | Production |
| Canonical SigLIP2 768-d embedding space | Production and provenance-gated |
| Semantic search, fusion and MMR | Enabled in production canary |
| Review, metadata and product-link workflows | Production path |
| Google Drive curated importer | Available; bounded batches and review gates required |
| Product intake workflow | Deployed, feature-flagged off |
| Reference-corpus quality benchmark | Ongoing curation/measurement |
| Public WordPress page SEO and image sitemap | Separate system; not guaranteed here |

## 9. Non-functional requirements

- No database, R2 or provider credential in browser code, git or public URLs.
- Parameterized SQL and server-side authorization for every mutation.
- Immutable committed releases for VPS deployment; no direct container patching.
- Reproducible embedding artifacts with model/dimension/space provenance.
- Idempotent jobs and recoverable soft deletion.
- Vietnamese text remains Unicode-safe in UI and embedded metadata.
- Test coverage for type contracts, provenance, search, image metadata and
  critical UI interaction.

## 10. Roadmap

1. Keep the current native runtime and migration ledger operationally aligned.
2. Improve SKU reconciliation and reference corpus diversity with reviewed
   batches and a genuine holdout benchmark.
3. Complete product-intake rollout only after its flag, permissions and audit
   gates are validated in production.
4. Coordinate WordPress landing-page authority, preferred-image, alt/caption,
   image sitemap and Search Console work in the public-site repository.
5. Finish `/studio` and `/shot` workflows when their product requirements are
   approved.
