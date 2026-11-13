# VerityDAM — Code Standards & Design Guidelines

**Current runtime note (2026-09-11):** The active data path is native
PostgreSQL 16/pgvector + Cloudflare R2 + Better Auth. Supabase/PostgREST/RLS
examples that remain in historical documents are not patterns for new code.

## 1. Design Tokens & CSS Architecture

VerityDAM enforces strict tokenized styling through CSS Custom Properties defined in [`src/styles/globals.css`](../src/styles/globals.css). Hardcoded hex codes in component files are strictly forbidden.

### 1.1 Color Tokens
| Variable | Light Theme | Dark Theme | Purpose / Rules |
|---|---|---|---|
| `--verity` | `#104C87` | `#4B8FE2` | Primary brand blue. Used for active tabs, primary CTAs, selected borders. |
| `--surface` | `#FFFFFF` | `#1E2530` | Card and panel backgrounds. |
| `--app` | `#F4F6F8` | `#141820` | App shell backdrop. |
| `--border` | `#E2E6EC` | `#2D3748` | Default element boundaries. |
| `--ok` | `#1A7F4B` | `#34D399` | Success, approved status, high confidence (≥85%). |
| `--warn` | `#C2701A` | `#FBBF24` | Attention flags, low confidence (<85%), people safety flags. |
| `--bad` | `#C53030` | `#F87171` | Error states, rejected status, broken media. |
| `--ai` | `#7C3AED` | `#A78BFA` | AI generated or AI-tagged assets. |
| `--teal` | `#0D9488` | `#2DD4BF` | Web stock / external source indicators. |
| `--learn` | `#C2701A` | `#F59E0B` | Human override learning loop glow ring. |
| `--gold` | `#FFD60D` | `#FACC15` | **Badge & graphic background ONLY.** Never use as text color. |

### 1.2 Spacing & Typography Rules
* **4px Spacing Grid:** Use `--s1` (4px), `--s2` (8px), `--s3` (12px), `--s4` (16px), `--s5` (20px), `--s6` (24px), `--s8` (32px).
* **Font Stacks:**
  * Body / UI: `Be Vietnam Pro`, sans-serif (weights 400, 500, 600, 700).
  * Monospace: `JetBrains Mono`, monospace — **Mandatory for all numbers, SKUs, timestamps, percentages, and prices.**
* **Vietnamese Diacritics Rule:** **Never apply `uppercase` / `text-transform: uppercase` to Vietnamese text containing diacritics.** Use sentence case with letter-spacing for eyebrow labels.

### 1.3 Motion Tokens & Transition Standards (`transitions-dev` & `ck:web-design-guidelines`)
* **Motion Tokens Scale:** All transitions must reference the canonical token scale from `src/styles/globals.css`:
  * Durations: `--duration-instant` (100ms), `--duration-fast` (150ms), `--duration-normal` (200ms), `--duration-moderate` (300ms), `--duration-slow` (400ms), `--duration-deliberate` (600ms).
  * Easings: `--ease-standard`, `--ease-decelerate`, `--ease-accelerate`, `--ease-spring-snappy`, `--ease-spring-gentle`.
* **Two-Way Orchestration:** Never unmount overlays (drawers, modals, toasts) immediately from state upon close. Always introduce an `isClosing` state to allow the exit animation to complete before unmounting.
* **Compositor-Only Animations:** Only animate `transform`, `opacity`, and `filter`. Do not animate layout properties (`width`, `height`, `top`, `left`, `margin`).
* **No `transition: all`:** Always enumerate transition properties explicitly.
* **Strict A11y Guard:** Every custom animation must be zeroed under `@media (prefers-reduced-motion: reduce)`.
* **Touch Targets:** Minimum `44x44px` on mobile (`< 768px`) and `32x32px` on desktop. All icon-only buttons must provide an explicit `aria-label`.

---

## 2. Component Guidelines & Patterns

### 2.1 Server vs. Client Components
* **Client Components (`'use client'`):**
  * All interactive components under `src/components/` (forms, drawers, buttons, grids, settings).
  * Always provide SSR guards when accessing browser-only APIs:
    ```typescript
    if (typeof window === 'undefined') return defaultValue;
    ```
* **Server-Only Logic (`src/lib/server/`):**
  * Native PostgreSQL queries, R2 clients, Better Auth helpers and other
    server-only integrations.
  * API route handlers under `src/app/api/`.

### 2.2 Microinteraction Standards
1. **AI Learning Ring (`.learning-ring`):**
   * Triggered when a reviewer edits an AI-suggested field.
   * Animation: 1000ms expanding amber glow (`--learn-glow`), paired with a fade-in `"đã ghi nhận"` indicator.
2. **Keyboard Interaction Safety:**
   * Preserve native keyboard behavior for `input`, `textarea`, `[contenteditable]`, and browser-native combinations.

---

## 3. TypeScript & Data Integrity

### 3.1 Strict Domain Types
All core entities are defined in [`src/types/media.ts`](../src/types/media.ts):
```typescript
export type MediaType = 'photo' | 'video' | 'render' | 'screenshot';
export type MediaPermission = 'public' | 'internal';
export type MediaStatus = 'Mới' | 'Đã bàn giao' | 'Đang lắp' | 'Lỗi/Bảo hành';
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

export interface AIFlags {
  is_ai: boolean;
  is_internal: boolean;
  has_people: boolean;
  tag_failed: boolean;
  is_broken?: boolean;
}
```

### 3.2 Input Sanitization & File Validation
* **Storage Filename Normalization:**
  * Diacritics must be decomposed and stripped (`normalize('NFD')`).
  * Non-alphanumeric characters replaced with `-`.
  * Truncated to a max length of 80 characters + extension.
* **MIME & Size Constraints:**
  * Images (JPEG, PNG, WebP, AVIF, GIF): `<= 50MB`.
  * Videos (MP4, WebM, QuickTime): `<= 200MB`.

---

## 4. API & Security Standards

1. **Role Enforcement:**
   * API endpoints must enforce role checks through the Better Auth session and
     native authorization helpers (for example `requireVerityMediaMember()`):
     - `viewer`: Read approved library assets.
     - `contributor`: Ingest uploads and call AI proxy.
     - `reviewer` / `admin`: Full review queue and metadata mutation rights.
2. **Injection Defense:**
   * User-controlled values must be passed as PostgreSQL parameters. Do not
     concatenate SQL, identifiers or R2 keys from untrusted input.
3. **AI Vision Proxy Rate Limiting:**
   * Direct browser calls to external AI endpoints are prevented from leaking keys.
   * Requests routed through `/api/vision-proxy` enforce atomic PostgreSQL rate limits per user.

---

## 5. Git & Commit Conventions

Follow the **Conventional Commits** specification:
* `feat(scope): ...` — New feature or major capability.
* `fix(scope): ...` — Bug fix or UI correction.
* `docs(scope): ...` — Documentation updates.
* `refactor(scope): ...` — Code refactoring without behavioral changes.
* `test(scope): ...` — Adding or updating test cases.

---

## 6. Quick Developer Onboarding

### Key Entry Points for Different Tasks

**Implementing a New Review Queue Feature**
1. Start in `src/components/review/ReviewView.tsx` (main orchestrator)
2. Define types in `src/types/media.ts`
3. Update API handler in `src/app/api/review-queue/[id]/decision.ts`
4. Add design tokens if new colors needed in `src/styles/globals.css`

**Adding a New Search/Filter**
1. Add type definition to `src/types/media.ts` (FilterState)
2. Update `FilterSidebar.tsx` component for UI
3. Update `/api/media` handler with new query parameter
4. Add validation in `src/lib/media-api.ts` (parseMediaListParams)

**Adding a New Settings Tab**
1. Create component in `src/components/settings/YourFeature.tsx`
2. Add it to the 4-tab grid in `src/components/settings/SettingsView.tsx`
3. Use `localStorage` for client-side config (see `useLocalStorage` pattern in existing settings components)
4. Test with the mock data in `src/lib/mock-data.ts`

**Adding New API Endpoint**
1. Create handler in `src/app/api/your-route.ts` with `'use server'` or route handler pattern
2. Add role guard at top: `await requireVerityMediaMember()`
3. Call the native PostgreSQL repository/server helper; keep the query
   parameterized and the mutation inside the existing authorization boundary
4. Add endpoint to `docs/codebase-summary.md` Section 3.2
5. Write validation/test in `src/lib/media-api.ts`

### Common Utilities & Patterns
* **Safe client API calls:** Use `src/lib/client/api.ts` `apiRequest<T>` wrapper — it handles auth headers and errors
* **Dark mode awareness:** Always use CSS tokens (e.g., `bg-[var(--surface)]`), never hardcoded colors
* **Vietnamese UI text:** Never uppercase diacritics (e.g., use "Duyệt ảnh" not "DUYỆT ẢNH"); prefer letter-spacing 0.07em for labels
* **Database queries:** Keep all native PostgreSQL access server-side and use
  parameterized queries/transactions through the repository or server helper.
  Browser code must call an authorized route, never the database directly.
* **Rate limiting:** Vision calls are enforced by the native rate-limit
  implementation used by the Vision proxy; preserve atomic accounting when
  changing that path.

---

## 7. Critical Architectural Pitfalls & Anti-Patterns

### 7.1 PostgreSQL: Empty String `'' IS NOT NULL` is TRUE
* **The Pitfall:** In PostgreSQL, an empty string `''` is **NOT** null. The expression `'' IS NOT NULL` evaluates to `TRUE`.
* **The Rule:**
  - In SQL: **Never** write `case when %s is not null` on string inputs without wrapping in `nullif(trim(%s), '')`.
  - In Python: Use `_nullable_text(val)` (which converts `""` and whitespace to `None`) instead of `_text(val)` when passing parameters to SQL `IS NOT NULL` checks.
  - Failure to do this causes successful uploads (where `error = None` becomes `""`) to be falsely marked as `ingest_status = 'failed'`.

### 7.2 Browser CORS Cache Poisoning on CDN Images
* **The Pitfall:** When an `<img>` tag without `crossOrigin="anonymous"` loads an image from Cloudflare R2 / CDN (`assets.verity.internal`), the browser makes a `no-cors` request without an `Origin` header. The browser and CDN cache this response without `Access-Control-Allow-Origin`. Subsequent JavaScript `fetch(url, { mode: 'cors' })` or canvas export (`img.crossOrigin = 'anonymous'`) for the same URL will be blocked by the browser because the cached entry lacks CORS headers.
* **The Rule:**
  - All `<img>` tags displaying CDN media assets MUST include `crossOrigin="anonymous"`.
  - All export / canvas utilities fetching CDN URLs MUST append a cache-busting query parameter (e.g., `?cors=1`) or route through same-origin proxy `/api/r2-proxy`.

### 7.3 Feature Flag Probing: Never Probe with 404 Endpoints
* **The Pitfall:** Probing whether a server feature is enabled by calling an endpoint that returns HTTP 404 when disabled pollutes the browser DevTools console with red network errors.
* **The Rule:**
  - Feature checks must query a dedicated flags endpoint (such as `GET /api/features`) that always returns HTTP 200 with `{ feature_name: boolean }`.
  - Frontend components (`UploadView`, `ReviewView`) must never fire exploratory requests to endpoints that return 404 when inactive.
