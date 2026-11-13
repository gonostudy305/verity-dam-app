import { expect, type Page } from '@playwright/test';

interface IsolatedApiMockOptions {
  onUnhandledRequest?: (method: string, pathname: string) => void;
  mediaData?: unknown[];
  reviewData?: unknown[];
  dedupData?: unknown | ((url: URL) => unknown);
  onDedupMutation?: (method: string, pathname: string, body: unknown) => { status?: number; body: unknown } | void;
}

const EMPTY_TAXONOMY = {
  category: [],
  space: [],
  status: [],
  brand: [],
  permission: [],
  safety: [],
  updatedAt: null,
};

export async function installIsolatedApiMocks(page: Page, options: IsolatedApiMockOptions = {}): Promise<void> {
  // The app middleware protects /library, /review and /duplicates before the
  // client can call /api/auth/session. Mirror the mocked authenticated session
  // with a test-only cookie so fixture pages reach the mocked API boundary.
  if (!process.env.PLAYWRIGHT_BASE_URL) {
    await page.context().addCookies([{ name: 'better-auth.session_token', value: 'e2e-fixture-session', domain: '127.0.0.1', path: '/' }]);
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;

    if (pathname === '/api/r2-proxy') {
      await route.fulfill({
        status: 200,
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'),
      });
      return;
    }

    if (pathname === '/api/auth/session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, user: { email: 'responsive@example.test', role: 'admin' } }),
      });
      return;
    }

    if (pathname === '/api/review-queue') {
      const isSkipped = new URL(route.request().url()).searchParams.get('status') === 'skipped';
      const data = isSkipped ? [] : options.reviewData ?? [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data, total: data.length }),
      });
      return;
    }

    if (pathname === '/api/taxonomy') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: EMPTY_TAXONOMY }),
      });
      return;
    }

    if (pathname === '/api/features') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ product_intakes: false }),
      });
      return;
    }

    if (pathname === '/api/asset-reports') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], total: 0 }),
      });
      return;
    }

    if (pathname === '/api/settings/upload-context') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { quickPresets: [], tagGroups: [], updatedAt: null } }),
      });
      return;
    }

    if (pathname === '/api/settings/vision') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            baseUrl: 'https://vision.example.test/v1',
            model: 'fixture/vision',
            detail: 'high',
            maxTokens: 1000,
            systemPrompt: 'fixture',
            configured: false,
            updatedAt: null,
          },
        }),
      });
      return;
    }

    if (pathname === '/api/product-intakes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
      return;
    }

    if (pathname.startsWith('/api/media/') && route.request().method() === 'GET') {
      const assetId = pathname.split('/')[3] || '';
      const asset = (options.mediaData ?? []).find((item) => item && typeof item === 'object' && (item as { id?: unknown }).id === assetId) ?? null;
      await route.fulfill({
        status: asset ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(asset ? { data: asset } : { error: { code: 'NOT_FOUND', message: 'Not found' } }),
      });
      return;
    }

    if (pathname === '/api/media') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: options.mediaData ?? [], total: options.mediaData?.length ?? 0, search_meta: { used: false } }),
      });
      return;
    }

    if (pathname === '/api/dedup/clusters') {
      const dedupData = typeof options.dedupData === 'function' ? options.dedupData(url) : options.dedupData;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: dedupData ?? { clusters: [], total: 0, counts_by_tier: { exact: 0, near: 0, similar: 0 }, attention_count: 0, total_estimated_reclaim_bytes: 0, last_built_at: null } }),
      });
      return;
    }

    if (pathname.startsWith('/api/dedup/clusters/') && route.request().method() !== 'GET') {
      let body: unknown = null;
      try { body = route.request().postDataJSON(); } catch { body = null; }
      const mutation = options.onDedupMutation?.(route.request().method(), pathname, body);
      if (mutation) {
        await route.fulfill({ status: mutation.status ?? 200, contentType: 'application/json', body: JSON.stringify(mutation.body) });
        return;
      }
    }

    options.onUnhandledRequest?.(route.request().method(), pathname);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
}
