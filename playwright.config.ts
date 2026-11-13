import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT || '3101';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

const viewportMatrix = [
  { id: 'phone-320x568', width: 320, height: 568, kind: 'phone' as const },
  { id: 'phone-375x667', width: 375, height: 667, kind: 'phone' as const },
  { id: 'phone-390x844', width: 390, height: 844, kind: 'phone' as const },
  { id: 'phone-430x932', width: 430, height: 932, kind: 'phone' as const },
  { id: 'tablet-768x1024', width: 768, height: 1024, kind: 'tablet' as const },
  { id: 'tablet-820x1180', width: 820, height: 1180, kind: 'tablet' as const },
  { id: 'tablet-1024x768', width: 1024, height: 768, kind: 'tablet' as const },
  { id: 'tablet-1180x820', width: 1180, height: 820, kind: 'tablet' as const },
  { id: 'desktop-1280x800', width: 1280, height: 800, kind: 'desktop' as const },
  { id: 'desktop-1440x900', width: 1440, height: 900, kind: 'desktop' as const },
];

const projects = (['chromium', 'webkit', 'firefox'] as const).flatMap((browserName) =>
  viewportMatrix.map((viewport) => ({
    name: `${browserName}-${viewport.id}`,
    browserName,
    use: {
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.kind === 'phone',
      hasTouch: viewport.kind !== 'desktop',
    },
  }))
);

export default defineConfig({
  testDir: './e2e/responsive',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // The matrix intentionally spans 30 browser/viewport projects. Keep the
  // local Next dev fixture serial so parallel project bootstraps cannot race
  // page compilation and produce false 404/breakpoint failures.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    colorScheme: 'light',
  },
  projects,
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'node scripts/dev-test.mjs',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
