import { test, expect } from '@playwright/test';

import { installIsolatedApiMocks } from './helpers';

function fixtureAssets() {
  return Array.from({ length: 40 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`,
    title: `Performance fixture ${index + 1}`,
    file_url: `/api/r2-proxy?key=fixtures/${index}.jpg`,
    thumbnail_url: `/api/r2-proxy?key=fixtures/${index}.jpg`,
    media_type: 'photo', sku: `PERF-${index + 1}`, brand: 'Verity', category: 'Studio', space: 'Phòng khách',
    status: 'approved', permission: 'public',
    ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false },
    ai_confidence: { sku: 0, brand: 0, category: 0 }, phash: '',
    dimensions: { width: 1200, height: 800, size_bytes: 100 }, origin_info: { source: 'Fixture' },
    usage_count: 0, created_at: '2026-09-08T00:00:00.000Z',
  }));
}

test('records a repeatable responsive performance baseline on the representative phone fixture', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-phone-390x844', 'One representative Chromium project owns the baseline evidence.');
  await page.addInitScript(() => {
    const state = { lcp: null as number | null, cls: 0 };
    (window as Window & { __verityPerformance?: typeof state }).__verityPerformance = state;
    try {
      new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1);
        if (last) state.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
          if (!entry.hadRecentInput) state.cls += Number(entry.value || 0);
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });
  await installIsolatedApiMocks(page, { mediaData: fixtureAssets() });
  await page.goto('/library');
  await expect(page.locator('article')).toHaveCount(40);

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const observers = (window as Window & { __verityPerformance?: { lcp: number | null; cls: number } }).__verityPerformance;
    const resources = performance.getEntriesByType('resource') as Array<PerformanceResourceTiming & { transferSize?: number }>;
    const imageResources = resources.filter((entry) => entry.initiatorType === 'img');
    return {
      navigation_ms: navigation ? Math.round(navigation.domContentLoadedEventEnd - navigation.startTime) : null,
      lcp_ms: observers?.lcp == null ? null : Math.round(observers.lcp),
      cls: Number((observers?.cls || 0).toFixed(4)),
      image_count: imageResources.length,
      image_bytes: imageResources.reduce((sum, entry) => sum + Number(entry.transferSize || 0), 0),
    };
  });

  const scrollStart = Date.now();
  await page.locator('[data-testid="main-content"] > div').first().evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const long_list_scroll_ms = Date.now() - scrollStart;
  const evidence = { captured_at: new Date().toISOString(), project: testInfo.project.name, ...metrics, long_list_scroll_ms };
  console.log(`[responsive-performance] ${JSON.stringify(evidence)}`);

  // These are fixture smoke budgets, not a claim about production hardware.
  // They catch regressions in the responsive shell while physical/production
  // evidence is collected separately.
  expect(evidence.navigation_ms ?? 0).toBeLessThan(3000);
  expect(evidence.cls).toBeLessThan(0.25);
  expect(evidence.long_list_scroll_ms).toBeLessThan(1000);
});
