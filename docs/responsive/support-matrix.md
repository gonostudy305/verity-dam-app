# Responsive support matrix

Updated: 2026-09-08

This document records the viewport behavior covered by the responsive release. It is a browser-emulation gate, not a substitute for physical-device sign-off.

## Target classes

| Class | Viewports | Expected behavior |
|---|---|---|
| Phone | 320x568, 375x667, 390x844, 430x932 | Bottom navigation, sheet-based filters/downloads, single primary scroll owner, stacked forms/actions, 44px touch targets |
| Tablet portrait | 768x1024, 820x1180, 1024x768 | Compact rail, adaptive one-column or tabbed workflows, scrollable filter/navigation controls, no horizontal page overflow |
| Tablet landscape | 1180x820 | Content-fit split workspaces where both panes meet their minimum width; otherwise the compact presentation remains available |
| Desktop | 1280x800, 1440x900 | Existing expanded sidebar and split workflows remain intact |

## Automated browser coverage

The responsive suite runs the shared shell contract on Chromium, WebKit and Firefox. In addition to Library/Review/Upload, the suite covers Settings, Shot, Login, Studio and Spec, plus rotation/resize and a representative long-list performance fixture. The post-change run on 2026-09-08 recorded:

- 390 total test cases across 30 browser/viewport projects
- 325 passed
- 65 intentionally skipped for route/device combinations that do not apply (including the single Chromium performance owner)
- 0 failed
- axe checks included in every configured viewport project
- boundary projects included both 820x1180 portrait and 1180x820 landscape

Run locally with:

```powershell
npm run test:e2e -- --workers=1 --reporter=line
```

## Manual device sign-off still required

Before a broad rollout, verify with real devices and representative authenticated roles:

- iPhone Safari: safe-area insets, keyboard focus, bottom navigation, file picker and camera permissions.
- Android Chrome: keyboard resize, file picker, upload reconciliation after backgrounding, and back gesture.
- iPad Safari: portrait, landscape and Split View; verify crop controls, review tabs/split threshold and Settings navigation.
- Keyboard-only desktop: tab order, focus visibility, modal/sheet escape behavior and sticky-footer focus safety.
- Reduced motion and 400% zoom: no clipped primary action or unreachable content.

## Archive export boundary

Batch originals now use a server-prepared ZIP job with deterministic filenames, progress, cancellation, retry and a 24-hour signed-download expiry. The initial guardrail is 25 approved, non-deleted assets and 250MB of originals; production measurements may lower or raise this limit through a future reviewed change.
