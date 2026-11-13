import { expect, test } from '@playwright/test';
import { installIsolatedApiMocks } from './helpers';

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const STORAGE_KEY = 'verity-media:review-inspector-width';

function reviewItem(id: string, title: string, sku: string) {
  return {
    id,
    status: 'pending',
    is_duplicate: false,
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
      origin_info: { source: 'Upload' },
      usage_count: 0,
      created_at: '2026-09-14T01:00:00.000Z',
    },
  };
}

test.describe('Review Focus View — resizable Inspector column', () => {
  test('drag-resizes, persists across reload, and folds away below the compact breakpoint', async ({ page }) => {
    const item = reviewItem('00000000-0000-4000-8000-000000000201', 'Ảnh E2E Resize', 'RESIZE-01');
    await installIsolatedApiMocks(page, { reviewData: [item] });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/review');

    const separator = page.getByRole('separator', { name: 'Đổi kích thước khung metadata' });
    await expect(separator).toBeVisible();
    await expect(separator).toHaveAttribute('aria-valuenow', '420');

    // Drag the handle 80px to the left -> Inspector should grow to 500px
    // (handle sits to the left of the Inspector; moving left grows it).
    const box = await separator.boundingBox();
    if (!box) throw new Error('separator has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 80, startY, { steps: 8 });
    await page.mouse.up();

    await expect(separator).toHaveAttribute('aria-valuenow', '500');
    await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBe('500');

    // Reload -- the dragged width should come back, not reset to the 420px default.
    await page.reload();
    await expect(page.getByRole('separator', { name: 'Đổi kích thước khung metadata' })).toHaveAttribute('aria-valuenow', '500');

    // Double-click resets to the 420px default.
    await page.getByRole('separator', { name: 'Đổi kích thước khung metadata' }).dblclick();
    await expect(separator).toHaveAttribute('aria-valuenow', '420');

    // Below the 1119px compact breakpoint there is no 2-pane split -- the
    // handle must not be present at all (not just visually hidden).
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.getByRole('separator', { name: 'Đổi kích thước khung metadata' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Ảnh' })).toBeVisible();

    // Widening back above the breakpoint restores the split with the handle.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('separator', { name: 'Đổi kích thước khung metadata' })).toBeVisible();
  });

  test('keyboard ArrowLeft/ArrowRight resize the Inspector column', async ({ page }) => {
    const item = reviewItem('00000000-0000-4000-8000-000000000202', 'Ảnh E2E Resize Keyboard', 'RESIZE-02');
    await installIsolatedApiMocks(page, { reviewData: [item] });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/review');

    const separator = page.getByRole('separator', { name: 'Đổi kích thước khung metadata' });
    await separator.focus();
    await expect(separator).toHaveAttribute('aria-valuenow', '420');

    await page.keyboard.press('ArrowLeft');
    await expect(separator).toHaveAttribute('aria-valuenow', '436');

    await page.keyboard.press('Shift+ArrowRight');
    await expect(separator).toHaveAttribute('aria-valuenow', '388');

    await page.keyboard.press('End');
    await expect(separator).toHaveAttribute('aria-valuenow', '640');

    await page.keyboard.press('Home');
    await expect(separator).toHaveAttribute('aria-valuenow', '340');
  });
});
