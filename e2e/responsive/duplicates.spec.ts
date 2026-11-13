import { test, expect } from '@playwright/test';

import { expectNoDocumentOverflow, installIsolatedApiMocks } from './helpers';

const asset = (id: string, title: string, sizeBytes: number, overrides: Record<string, unknown> = {}) => ({
  id,
  title,
  file_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  media_type: 'photo',
  sku: `DEDUP-${id.slice(-3)}`,
  brand: 'Verity',
  category: 'Studio',
  space: 'Phòng khách',
  status: 'approved',
  permission: 'internal',
  ai_flags: { is_ai: false, is_internal: true, has_people: false, tag_failed: false },
  ai_confidence: { sku: 0, brand: 0, category: 0 },
  phash: '',
  dimensions: { width: 1920, height: 1080, size_bytes: sizeBytes },
  origin_info: { source: 'Upload' },
  usage_count: 0,
  created_at: '2026-09-08T00:00:00.000Z',
  ...overrides,
});

function clusterFixture(tier: 'exact' | 'near' | 'similar' = 'exact', protectedDuplicate = false) {
  const canonical = asset('00000000-0000-4000-8000-000000000011', 'Ảnh chuẩn', 1000);
  const duplicate = asset(
    '00000000-0000-4000-8000-000000000012',
    protectedDuplicate ? 'Ảnh đang sử dụng' : 'Ảnh trùng',
    200,
    protectedDuplicate ? { usage_count: 2, publish_status: 'published', published_at: '2026-09-08T00:00:00.000Z' } : {},
  );
  return {
    id: '00000000-0000-4000-8000-000000000010',
    canonical_media_asset_id: canonical.id,
    tier,
    status: 'open',
    resolution: null,
    method_summary: tier === 'similar' ? { scene_embedding: 1 } : { content_hash: 1 },
    member_count: 2,
    estimated_reclaim_bytes: 200,
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    members: [
      { media_asset_id: canonical.id, asset: canonical, variant: 'canonical', similarity: null, decision: 'undecided' },
      { media_asset_id: duplicate.id, asset: duplicate, variant: tier === 'similar' ? 'scene_similar' : 'exact_bytes', similarity: tier === 'similar' ? 0.88 : null, decision: 'undecided' },
    ],
  };
}

function workbenchData(cluster: ReturnType<typeof clusterFixture>) {
  return {
    clusters: [cluster],
    total: 1,
    counts_by_tier: { exact: cluster.tier === 'exact' ? 1 : 0, near: cluster.tier === 'near' ? 1 : 0, similar: cluster.tier === 'similar' ? 1 : 0 },
    attention_count: 1,
    total_estimated_reclaim_bytes: 200,
    last_built_at: '2026-09-08T00:00:00.000Z',
  };
}

test.describe('duplicate workbench guided review', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('separates the queue from detail and lets the reviewer choose a canonical asset', async ({ page }) => {
    const cluster = clusterFixture();
    await installIsolatedApiMocks(page, { dedupData: workbenchData(cluster) });

    await page.goto('/duplicates');
    // The fixture intentionally contains a duplicate asset titled “Ảnh trùng”.
    // Assert the AppShell page title, not every incidental card heading.
    await expect(page.getByRole('heading', { name: 'Ảnh trùng', exact: true, level: 1 })).toHaveCount(1);
    await expect(page.getByRole('tablist', { name: 'Loại ảnh cần xem' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Xem nhóm' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dọn nhanh 1-Click' })).toBeVisible();
    await page.getByRole('button', { name: 'Xem nhóm' }).click();
    await expect(page.getByRole('dialog', { name: 'Xem và xử lý nhóm ảnh trùng' })).toBeVisible();

    await page.getByRole('button', { name: 'Chọn giữ ảnh này' }).click();
    await expect(page.getByText('Đang chọn giữ ảnh này')).toHaveCount(1);
    await expect(page.getByText('Sẽ đưa vào thùng rác')).toHaveCount(1);
    await expectNoDocumentOverflow(page);
  });

  test('runs an explicit rebuild when the reviewer clicks Quét lại', async ({ page }) => {
    const cluster = clusterFixture();
    let rebuildCalls = 0;
    await installIsolatedApiMocks(page, {
      dedupData: workbenchData(cluster),
      onDedupMutation: (method, pathname) => {
        if (pathname.endsWith('/rebuild')) {
          expect(method).toBe('POST');
          rebuildCalls += 1;
          return { body: { success: true, data: { clustersOpen: 1, clustersCreated: 0, clustersRemoved: 0, suppressedSkipped: 0 } } };
        }
        return { body: { success: true, data: {} } };
      },
    });

    await page.goto('/duplicates');
    await page.getByRole('button', { name: 'Quét lại', exact: true }).click();
    await expect.poll(() => rebuildCalls).toBe(1);
    await expect(page.getByText('Đã quét lại. Không có thay đổi mới; còn 1 nhóm cần xử lý.')).toBeVisible();
  });

  test('shows the protected-asset escalation before resolving', async ({ page }) => {
    const cluster = clusterFixture('exact', true);
    let resolveAttempts = 0;
    let resolved = false;
    await installIsolatedApiMocks(page, {
      dedupData: () => resolved ? { ...workbenchData(cluster), clusters: [], total: 0, attention_count: 0 } : workbenchData(cluster),
      onDedupMutation: (_method, pathname) => {
        if (pathname.endsWith('/resolve')) {
          resolveAttempts += 1;
          if (resolveAttempts === 1) return { status: 409, body: { error: { code: 'PROTECTED_ASSETS', message: 'Asset đang được sử dụng hoặc đã xuất bản.', details: [{ id: cluster.members[1].media_asset_id, title: 'Ảnh đang sử dụng', reasons: ['in_use', 'published'] }] } } };
          resolved = true;
          return { body: { success: true, data: { undo_available: true } } };
        }
        return { body: { success: true, data: {} } };
      },
    });

    await page.goto('/duplicates');
    await page.getByRole('button', { name: 'Xem nhóm' }).click();
    await page.getByRole('checkbox', { name: 'Xóa' }).check();
    await page.getByRole('button', { name: 'Xóa 1 ảnh trùng' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByPlaceholder('DUYỆT')).toBeVisible();
    await page.getByPlaceholder('DUYỆT').fill('DUYỆT');
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Đã xử lý nhóm ảnh.')).toBeVisible();
  });

  test('keeps all assets as a secondary action without deleting them', async ({ page }) => {
    const cluster = clusterFixture();
    let resolved = false;
    await installIsolatedApiMocks(page, {
      dedupData: () => resolved ? { ...workbenchData(cluster), clusters: [], total: 0, attention_count: 0 } : workbenchData(cluster),
      onDedupMutation: (_method, pathname, body) => {
        if (pathname.endsWith('/resolve')) {
          expect((body as { resolution: string }).resolution).toBe('keep_all');
          resolved = true;
        }
        return { body: { success: true, data: { undo_available: true } } };
      },
    });

    await page.goto('/duplicates');
    await page.getByRole('button', { name: 'Xem nhóm' }).click();
    await page.getByRole('button', { name: 'Giữ cả nhóm' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Không có nhóm nào trong bộ lọc này')).toBeVisible();
  });

  test('dismisses a group as not duplicate', async ({ page }) => {
    const cluster = clusterFixture('near');
    let resolved = false;
    await installIsolatedApiMocks(page, {
      dedupData: () => resolved ? { ...workbenchData(cluster), clusters: [], total: 0, attention_count: 0 } : workbenchData(cluster),
      onDedupMutation: (_method, pathname, body) => {
        if (pathname.endsWith('/resolve')) {
          expect((body as { resolution: string }).resolution).toBe('not_duplicate');
          resolved = true;
        }
        return { body: { success: true, data: { undo_available: true } } };
      },
    });

    await page.goto('/duplicates');
    await page.getByRole('button', { name: 'Xem nhóm' }).click();
    await page.getByRole('button', { name: 'Không phải ảnh trùng' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByText('Không có nhóm nào trong bộ lọc này')).toBeVisible();
  });

  test('offers undo after a keep-one resolution', async ({ page }) => {
    const cluster = clusterFixture();
    let resolved = false;
    await installIsolatedApiMocks(page, {
      dedupData: () => resolved ? { ...workbenchData(cluster), clusters: [], total: 0, attention_count: 0 } : workbenchData(cluster),
      onDedupMutation: (_method, pathname) => {
        if (pathname.endsWith('/resolve')) resolved = true;
        if (pathname.endsWith('/undo')) resolved = false;
        return { body: { success: true, data: { undo_available: true } } };
      },
    });

    await page.goto('/duplicates');
    await page.getByRole('button', { name: 'Xem nhóm' }).click();
    await page.getByRole('checkbox', { name: 'Xóa' }).check();
    await page.getByRole('button', { name: 'Xóa 1 ảnh trùng' }).click();
    await page.getByRole('button', { name: 'Xác nhận' }).click();
    await expect(page.getByRole('button', { name: 'Hoàn tác' })).toBeVisible();
    await page.getByRole('button', { name: 'Hoàn tác' }).click();
    await expect(page.getByRole('button', { name: 'Xem nhóm' })).toBeVisible();
  });

  test('does not show any delete action for similar groups', async ({ page }) => {
    const cluster = clusterFixture('similar');
    await installIsolatedApiMocks(page, {
      dedupData: (url: URL) => url.searchParams.get('scope') === 'similar'
        ? workbenchData(cluster)
        : { ...workbenchData(cluster), clusters: [], total: 0, attention_count: 0 },
    });

    await page.goto('/duplicates');
    await expect(page.getByRole('button', { name: 'So sánh' })).toHaveCount(0);
    await page.getByRole('tab', { name: /Ảnh tương tự 1/ }).click();
    await expect(page.getByRole('button', { name: 'So sánh' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Chọn cluster' })).toHaveCount(0);
    await page.getByRole('button', { name: 'So sánh' }).click();
    await expect(page.getByRole('button', { name: /Đưa .* ảnh đã chọn vào thùng rác/ })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /đưa .* vào thùng rác/i })).toHaveCount(0);
  });
});
