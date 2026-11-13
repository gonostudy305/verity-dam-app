# AI-assisted review acceleration

This tool is a controlled operator-assist workflow for reviewing obvious pending still images. It is not an autonomous SKU classifier and it never treats a non-empty result or model confidence alone as proof of identity.

## Safety contract

- Role must be exactly `reviewer`. Admin sessions are rejected by default.
- Dry-run is the default and never clicks an approval action.
- The runner inspects the actual image endpoint, decodes it with Sharp, records dimensions/hash/content type, and captures the review screen with Playwright.
- Machine policy fails closed on missing image, non-ready ingestion, duplicate signals, people, AI/broken/tag flags, non-catalog assets, post-production flags, ambiguous SKU evidence, unresolved catalog identity, low similarity, or low margin.
- A decision manifest must explicitly contain `operator_confirmed: true`, `visual_verdict: "exact"`, and the exact current asset SKU. The model/operator must inspect the screenshot evidence before setting those values.
- Approvals are one at a time. The Playwright route guard rejects unexpected metadata changes, corrections, product links, reference promotion, duplicate replacement, or other side effects.
- Every successful approval is checked at API, database and R2/image levels. The database connection must be supplied as a read-only URL and is used inside `BEGIN READ ONLY` transactions.
- The first failed postcondition stops the run. There is no automatic rollback because the current review API only reopens `skipped` items, not approved items.

## Environment

```powershell
$env:REVIEW_ASSIST_BASE_URL = 'https://dam.verity.internal'
$env:REVIEW_ASSIST_EMAIL = 'reviewer-bot@veritydam.example'
$env:REVIEW_ASSIST_PASSWORD = '<secret from your secret manager>'
$env:REVIEW_ASSIST_READONLY_DATABASE_URL = 'postgresql://<read-only-user>:<password>@<host>/<db>?sslmode=require'
$env:REVIEW_ASSIST_EXPECTED_DATABASE = '<exact database name>'
$env:REVIEW_ASSIST_REVIEWER_USER_ID = '<exact Better Auth user id for reviewer-bot>'
```

The password is never accepted as a CLI argument and is never written to reports. The database URL must resolve to the expected database, run inside a read-only transaction, and use a role without superuser, role-creation, database-creation, or `BYPASSRLS` privileges.

## Dry-run: inspect 10 images

```powershell
node scripts/review-assist.mjs --dry-run --limit 10 --headful
```

The command writes `report.json`, `decisions.template.json` and screenshots under `test-results/review-assist/<run-id>/`. A human or Codex must inspect each screenshot and set only obvious exact matches to:

For a read-only inventory of the complete pending queue, use `--all`. This follows the server cursor across pages and is still dry-run-only; it does not relax the 20-item execute cap:

```powershell
node scripts/review-assist.mjs --dry-run --all --headful
```

```json
{
  "run_id": "dry-run-...",
  "decisions": [
    {
      "queue_id": "...",
      "asset_id": "...",
      "visual_verdict": "exact",
      "confirmed_sku": "IPC-A32P-PRO",
      "operator_confirmed": true
    }
  ]
}
```

Use `visual_verdict: "skip"` for anything uncertain. Do not edit `report.json`; copy or edit the decision template. Keep the generated `preflight_fingerprint` and `preflight_image_sha256` unchanged for every exact decision.

## Execute 3–5 obvious images

```powershell
node scripts/review-assist.mjs `
  --execute `
  --report test-results/review-assist/<run-id>/report.json `
  --decisions test-results/review-assist/<run-id>/decisions.json `
  --limit 10 `
  --max-approvals 5 `
  --confirm-production `
  --headful
```

The runner refuses to execute without `--confirm-production`, the exact dedicated reviewer user ID, the read-only DB URL, the source dry-run report and explicit decisions. The decision manifest `run_id`, asset IDs, image hashes and evidence fingerprints must match that report. Each item is revalidated immediately before the click. It stops immediately on a non-2xx approval response, unsafe UI payload, DB/API/R2 mismatch or unexpected learning/reference side effect.

## Scaling to 20

Only after the first 3–5 approvals pass their postconditions should a later run use `--limit 20 --max-approvals 20`. Keep execution sequential and review `execute-report.json` after every run.
