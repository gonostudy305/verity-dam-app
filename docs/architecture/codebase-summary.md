# VerityDAM — Codebase Summary

**Repository snapshot:** 2026-09-19. This map describes the checked-in native
runtime implementation and repository layout. Live release facts are called
out only where independently verified and otherwise defer to
[current-system-state.md](./current-system-state.md); this is not a claim that
every working-tree change or migration is deployed. Historical
Supabase/OpenCLIP references are kept in dated migration and RFC documents,
not as active architecture.

## Repository map

```text
verity-media/
├── src/
│   ├── app/                 # Next.js App Router pages and API handlers
│   ├── components/          # Library, review, upload, settings and intake UI
│   ├── config/              # Taxonomy and application defaults
│   ├── hooks/               # Client React hooks
│   ├── lib/
│   │   ├── server/           # Native PostgreSQL, R2, auth, search and jobs
│   │   ├── client/           # Browser-safe API wrappers
│   │   └── *.ts              # Slugs, image objects, taxonomy and domain logic
│   ├── styles/              # Design tokens and global styles
│   └── types/               # Shared media/domain types
├── backend/
│   ├── app/                 # Worker, native gateway, Vision and embedding runtime
│   ├── verity_media_mcp/      # Native MCP server and agent-facing tools
│   ├── importers/google_drive/ # Census, curated importer and local SigLIP2 lane
│   ├── migrations/          # Ordered native PostgreSQL migrations
│   ├── benchmarks/siglip2/  # Pinned ONNX artifact manifest and checks
│   ├── scripts/             # Migration, seed, audit and operational CLIs
│   └── tests/               # Python worker/MCP/database tests
├── docs/                    # Current contracts, runbooks, ADRs and history
├── e2e/                     # Playwright browser tests
├── scripts/                 # Node/VPS deployment and provisioning scripts
├── docker-compose*.yml      # Local and native VPS service definitions
└── package.json             # Next.js, TypeScript and test scripts
```

## Runtime stack

| Layer | Current implementation |
| --- | --- |
| Web | Next.js `15.5.25`, App Router, React `18.3.1`, TypeScript `5.6.3` |
| UI | Tailwind CSS, CSS custom-property design tokens, Lucide icons |
| Auth | Better Auth sessions with server-side role enforcement |
| Database | Native PostgreSQL 16 + pgvector on the VPS |
| Object storage | Cloudflare R2 with scoped presigned URLs |
| Worker | Python durable PostgreSQL job worker |
| MCP | `backend/verity_media_mcp`, Streamable HTTP/stdio surface |
| Vision | Configured server-side Vision provider; Drive importer default is Luna |
| Image embeddings | Pinned self-hosted SigLIP2 ONNX, 768 dimensions |

## Main pages

| Route | Purpose |
| --- | --- |
| `/library` | Approved DAM library, search, filters and asset drawer |
| `/review` | Human review queue for metadata, safety, duplicates and product links |
| `/upload` | Batch upload and enrichment entry point |
| `/settings` | Vision, search, taxonomy and integration settings |
| `/shot` | Missing-shot workspace; parts remain incomplete |
| `/studio` | AI Creative Studio: provider readiness, immutable brand/channel/template bootstrap, article-job creation, candidate inspection and review handoff |
| `/spec` | Design-system and interaction showcase |

## Representative API surface

| Area | Routes/modules | Responsibility |
| --- | --- | --- |
| Upload | `src/app/api/uploads/` | Presign R2 uploads and create durable jobs |
| Media | `src/app/api/media/` | List, detail, edit, crop, select, archive/restore/purge |
| Review | `src/app/api/review-queue/` | Queue, approve/reject, reopen and corrections |
| Search | `src/app/api/catalog/search/`, internal media search | Lexical/entity/semantic retrieval, fusion and MMR |
| Vision | `src/app/api/vision-proxy/` | Server-side provider proxy and rate limit |
| Settings | `src/app/api/settings/` | Server-side configuration and admin controls |
| Intake | `src/app/api/product-intakes/` | Product intake workflow, currently feature-flagged off in production |
| Export | WordPress/media publication modules | Canonical URL and ImageObject export payloads |
| AI Creative | `src/app/api/creative/`, `src/app/api/internal/creative/`, `src/app/api/settings/creative/`, `src/lib/server/creative.ts` | Versioned multi-brand generation, Settings-managed credentials, Library-first routing, DAM-backed resolutions and consumer acknowledgement |

Exact route behavior and MCP tool contracts are maintained in
[the MCP server guide](../mcp-server.md) and the
[production media pipeline](../ai-ml/production-media-pipeline.md).

## Data ownership

The native database stores `media_assets`, `asset_embeddings`, product/catalog
identity, `media_asset_products`, `sku_references`, `reference_embeddings`,
review queues, jobs, taxonomy, audit, usage and provider configuration.

`media_asset_products` is the canonical many-to-many product relation.
`media_assets.sku` is a transitional single-SKU/cache field. Images showing
multiple products, a banner or an ambiguous scene may have no single SKU.

Cloudflare R2 stores originals and canonical renditions. `file_url` and public
CDN URLs are derived from canonical R2 keys; database metadata and R2 object
existence must be checked together before publication.

## AI Creative Studio

The creative domain is intentionally separate from normal media enrichment:

```text
Generation candidate → DAM review → active slot resolution → publish acknowledgement
```

The implementation spans migrations `0044`–`0049`, `creative.ts`, the isolated
Python creative worker, and Settings-managed provider configuration. Brand,
channel and template values are immutable versions; requests snapshot those
versions, a canonical payload hash and a budget period. The deterministic
article planner creates one thumbnail and up to three section slots, tries an
explicitly eligible approved Library asset first, then queues only unresolved
slots for AI.

`creative_slot_resolutions` is the canonical answer to “which asset should be
used?”. It supports an active Library asset without a fake generation and an AI
output only after it has been promoted to a pending DAM asset and subsequently
approved. The placement manifest reads active, approved resolutions only, and
`creative_placement_usages` is written only after the internal consumer sends a
publish acknowledgement.

Provider keys are configured through **Settings → AI Creative**, encrypted at
rest in PostgreSQL, and returned to the browser only as redacted readiness
state. The worker reads the setting when it polls; Studio never receives a
provider secret. AI synthetic assets are database-blocked from SKU/identity/
cutout references and active metadata few-shot examples.

See the [AI Creative Studio operator runbook](../operations/ai-creative-studio-runbook.md) for the operational sequence and safety gates.

The Settings API is Admin-only. It stores provider keys AES-GCM encrypted in
PostgreSQL and returns redacted readiness state; the worker decrypts the saved
configuration server-side using `VERITY_VISION_CONFIG_MASTER_KEY` (32-byte
base64). A successful production deployment and database integration gate do
not prove that an actual provider key is configured or that a live image has
been generated. The first authenticated provider smoke remains an operator
action. See the [dated upgrade plan](../../plans/archive/2026-09-19-ai-creative-pipeline/plan.md)
and [completion report](../../plans/archive/2026-09-19-ai-creative-pipeline/completion-report.md).

## Enrichment and matching flow

1. A native upload route presigns a scoped R2 object.
2. Upload completion creates a durable PostgreSQL analysis job.
3. The worker computes pHash, the 768-d SigLIP2 embedding and Vision metadata.
4. Product/SKU candidates are matched against eligible primary references.
5. Review gates decide metadata, people-safety, duplicates, product links and
   reference promotion.
6. Approval publishes the canonical asset and optional WordPress export.

The Google Drive importer follows the same provenance contract locally. It must
use the same model identity, preprocessing, dimension and space as the VPS.
Folder context can provide a default SKU only under explicit folder policy;
mixed or low-confidence images fail closed.

## Embedding contract

| Field | Production value |
| --- | --- |
| Profile/provider | `local_siglip2` |
| Model | `siglip2-b32-256-webli` |
| Model identity | `timm/ViT-B-32-SigLIP2-256` |
| Revision | `cd1efb47643f2794413dd79ef24397c175032780` |
| Space | `verity-siglip2-b32-256-webli-v1` |
| Dimension | `768` |
| Input | RGB, 256×256 bicubic squash resize, mean/std 0.5/0.5 |

Artifact hashes and provenance rules are defined in
[`backend/benchmarks/siglip2/artifact_manifest.json`](../../backend/benchmarks/siglip2/artifact_manifest.json)
and [embedding profiles](../ai-ml/embedding-profiles.md). DataComp 512-d and personal
CLIP are not valid production writes.

## Taxonomy

Live top-level categories are `Ảnh thực tế`, `Ảnh Studio` and `Ảnh Thiết kế`.
Installation/showroom, controlled studio and design/banner sub-branches are
contextual metadata, not additional top-level categories.

## Tests and verification

From the repository root:

```bash
npm test
npx tsc --noEmit
npm run test:e2e
```

For backend checks:

```bash
cd backend
python -m pytest
python -m scripts.audit_sku_reconciliation --all-assets --json-out report.json
```

The reconciliation command is read-only. It proposes candidates and reference
gaps; it does not mutate production identity.

## Current operational gaps

- The prior 2026-09-11 operational snapshot recorded Product Intake migration
  `0037_product_intake_workflow.sql` as deployed and its production feature flag
  as unset/disabled; the flag was not rechecked in the 2026-09-19 refresh.
- Reference corpus quality still needs human-curated, model-specific holdout
  evaluation; counts do not prove recognition accuracy.
- Creative release `d1ba020` and migrations `0044`–`0049` are deployed; the
  PostgreSQL 16 creative integration gate and production health check passed on
  2026-09-19. A successful provider-generated image has not yet been verified;
  save a credential through Admin Settings and run the authenticated smoke in
  the [operator runbook](../operations/ai-creative-studio-runbook.md).
- The P0 capability-spike result and P6 benchmark of at least 60 outputs are
  not present in the deployment evidence. Do not mark production quality,
  routing thresholds, or cost/latency gates final until those reports exist.
- Image sitemap, landing-page alt/caption and page-level SEO belong primarily to
  the WordPress/public-site system, not this Studio repository.
