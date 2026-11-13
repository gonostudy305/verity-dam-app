# Responsive performance baseline

Captured: 2026-09-08

This is an automated Chromium fixture baseline, not a physical-device or production claim. It uses the responsive Playwright harness with 40 mocked media cards and 1x1 R2-proxy image responses, so it is intended to catch regressions in the shell, card layout and long-list interaction rather than measure network performance of `dam.verity.internal`.

## Representative run

Command:

```powershell
npm run test:e2e -- e2e/responsive/performance.spec.ts --project=chromium-phone-390x844 --reporter=line
```

Observed on 2026-09-08:

| Metric | Observed | Fixture gate |
|---|---:|---:|
| DOMContentLoaded | 141 ms | < 3,000 ms |
| LCP | 168 ms | fixture-only |
| CLS | 0.0054 | < 0.25 |
| Image resources | 40 | informational |
| Image transfer bytes | 13,040 bytes | informational; 1x1 fixture responses |
| Long-list scroll | 45 ms | < 1,000 ms |

Production LCP/CLS, representative image bytes and physical long-list scroll remain release gates because they require real authenticated data, network conditions and the target device fleet. The E2E test intentionally does not convert fixture numbers into a production SLO.
