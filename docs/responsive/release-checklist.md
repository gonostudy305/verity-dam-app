# Responsive release checklist

Use this checklist for a responsive release of `dam.verity.internal`.

## Pre-release gate

- [x] `npx tsc --noEmit` returns zero diagnostics.
- [x] `npm test` passes.
- [x] `npm run build` passes.
- [x] Playwright responsive matrix passes on Chromium, WebKit and Firefox.
- [x] `git diff --check` is clean for staged release files.
- [x] API contracts and role checks are unchanged by responsive presentation work.
- [ ] Physical iPhone Safari, Android Chrome and iPad Split View smoke checks signed off by an operator with access to those devices.
- [ ] Production representative LCP/CLS and long-list scroll measurements recorded (automated fixture baseline is in `docs/responsive-performance-baseline.md`; this checkbox requires production evidence).

## Manual workflow checks

### Library

- Search, filter sheet, sort and density controls are reachable at 320px.
- Select and open controls work independently without hover.
- Batch action bar remains above the safe area and does not cover focused content.
- Detail state returns to the previous query/filter/selection context.

### Review

- Image and Metadata tabs preserve edits, scroll and preview state.
- Wide tablet/desktop split appears only when content fits.
- Low-confidence nudge is visible without preventing a decision.
- Approve, reject and defer actions remain touch-safe and keyboard reachable.

### Upload

- File picker can be opened without drag-and-drop.
- Staged files remain in document flow on phones.
- Failed, blocked and unknown items expose recovery/recheck actions.
- Keyboard focus and context fields remain visible when the viewport resizes.

### Secondary surfaces

- Shot actions remain usable in stacked cards.
- Settings section deep links survive reload and browser Back.
- Login errors are announced and password controls remain usable with the keyboard.
- Destructive actions retain confirmation and server-side authorization.

## Deployment and rollback

1. Confirm the release commit is on `main` and the working tree only contains known generated artifacts.
2. Deploy with `your deployment script -Action Deploy -AllowDirty -HealthTimeoutSeconds 180` when generated artifacts remain; the script archives committed `HEAD` only.
3. Verify `/api/health` and the deployment script health gate before announcing availability.
4. If the health gate or smoke check fails, use the deployment script's rollback action with the previously recorded release SHA.
5. Record the release SHA, health response and any physical-device findings in the deployment log.

## Automated evidence and remaining operational gates

- [x] Server archive job has per-asset re-checks, a 25-item/250MB guardrail, progress, cancellation, retry and expiry.
- [x] CI runs TypeScript, unit tests, production build and the responsive E2E matrix.
- [x] Fixture performance baseline recorded in `docs/responsive-performance-baseline.md`.
- [ ] Physical iPhone Safari, Android Chrome and iPad Split View sign-off by an operator with device access.
- [ ] Production representative performance baseline and budget approval.
- [ ] Canary and rollback rehearsal evidence.

Latest automated release evidence: `1ea8e57` is active on the VPS; app, worker,
embedding and database containers are healthy, and public `/api/health` plus `/`
returned HTTP 200. This does not substitute for the three operational gates
above.
