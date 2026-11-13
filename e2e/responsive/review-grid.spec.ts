import { expect, test } from '@playwright/test';
import { installIsolatedApiMocks } from './helpers';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

function reviewItem(id: string, title: string, sku: string, duplicate = false) {
  return {
    id,
    status: 'pending',
    is_duplicate: duplicate,
    user_corrections: {},
    suggested_caption: '',
    created_at: '2026-09-14T01:00:00.000Z',
    asset: {
      id: id.replace('00000000-0000-4000-8000-', '10000000-0000-4000-8000-'),
      title,
      file_url: PIXEL,
      thumbnail_url: PIXEL,
      media_type: 'photo',
      sku,
      brand: 'Verity',
      category: 'Studio',
      space: 'Phòng khách',
      status: 'pending',
      permission: 'public',
      ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false },
      ai_confidence: { sku: 0.72, brand: 0.95, category: 0.9 },
      phash: '',
      dimensions: { width: 1200, height: 800, size_bytes: 100 },
      origin_info: { source: 'Upload', import_batch_id: 'grid-e2e-batch', batch_context: 'Lô E2E' },
      usage_count: 0,
      created_at: '2026-09-14T01:00:00.000Z',
    },
  };
}

test.describe('Review Grid → Focus batch safety', () => {
  test('selects a visual batch, changes Reference, and confirms before writing', async ({ page }) => {
    const first = reviewItem('00000000-0000-4000-8000-000000000101', 'Ảnh E2E 1', 'GRID-01');
    const second = reviewItem('00000000-0000-4000-8000-000000000102', 'Ảnh E2E 2', 'GRID-02', true);
    let batchPosts = 0;

    await installIsolatedApiMocks(page, { reviewData: [first, second] });
    await page.route('**/api/review-queue/batch-decision', async (route) => {
      batchPosts += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { processed_count: 2 } }) });
    });

    await page.goto('/review');
    await page.getByRole('tab', { name: 'Tổng quan' }).click();
    await expect(page.getByRole('grid', { name: 'Ảnh đang chờ duyệt' })).toBeVisible();
    await page.getByRole('button', { name: 'Chọn Ảnh E2E 1', exact: true }).click();
    await page.getByRole('button', { name: 'Chọn Ảnh E2E 2', exact: true }).click();
    await expect(page.getByRole('toolbar', { name: 'Thao tác ảnh đã chọn' })).toContainText('Đã chọn 2 ảnh');

    const reference = page.getByRole('button', { name: 'Đặt Ảnh E2E 2 làm ảnh Reference' });
    await reference.click();
    await expect(page.getByRole('button', { name: 'Ảnh Reference của Lô: Lô E2E' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: /Kiểm tra & duyệt/ }).click();
    await expect(page.getByText('Duyệt hàng loạt (2 ảnh)')).toBeVisible();
    await page.getByRole('button', { name: 'Duyệt 2 ảnh' }).click();
    await expect(page.getByRole('dialog')).toContainText('Xác nhận duyệt hàng loạt');
    await expect(page.getByRole('dialog')).toContainText('ảnh nghi trùng lặp — vẫn giữ cả hai bản');
    await page.getByRole('button', { name: 'Quay lại' }).click();
    await expect(page.getByText('Duyệt hàng loạt (2 ảnh)')).toBeVisible();
    expect(batchPosts).toBe(0);

    await page.getByRole('button', { name: 'Duyệt 2 ảnh' }).click();
    await page.getByRole('button', { name: 'Xác nhận duyệt' }).click();
    await expect.poll(() => batchPosts).toBe(1);
  });
});
