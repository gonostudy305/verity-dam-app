import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expectNoDocumentOverflow, installIsolatedApiMocks } from './helpers';

test.describe('adaptive application shell', () => {
  test.beforeEach(async ({ page }) => {
    // Accessibility assertions must inspect the settled visual state, not a
    // transient half-opacity keyframe (Firefox/WebKit can sample it sooner
    // than Chromium). This also mirrors users who prefer reduced motion.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installIsolatedApiMocks(page);
    await page.goto('/library');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('main-content')).toBeVisible();
  });

  test('presents the correct navigation for the viewport class', async ({ page }, testInfo) => {
    const projectName = testInfo.project.name;
    await expectNoDocumentOverflow(page);

    if (projectName.includes('-phone-')) {
      await expect(page.getByTestId('mobile-bottom-nav')).toBeVisible();
      await expect(page.getByTestId('navigation-rail')).toBeHidden();
      await expect(page.locator('aside').filter({ hasText: 'VerityDAM' })).toBeHidden();
    } else if (projectName.includes('-tablet-')) {
      await expect(page.getByTestId('mobile-bottom-nav')).toBeHidden();
      await expect(page.getByTestId('navigation-rail')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
      await expect(page.locator('aside').filter({ hasText: 'VerityDAM' })).toBeHidden();
    } else {
      await expect(page.getByTestId('mobile-bottom-nav')).toBeHidden();
      await expect(page.getByTestId('navigation-rail')).toBeHidden();
      await expect(page.locator('aside').filter({ hasText: 'VerityDAM' })).toBeVisible();
    }
  });

  test('keeps More sheet keyboard-dismissable on phone', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('-phone-'), 'More is intentionally a phone navigation affordance.');

    const moreButton = page.getByRole('button', { name: 'Mở thêm điều hướng' });
    await moreButton.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Thêm' })).toBeVisible();
    const openResults = await new AxeBuilder({ page }).analyze();
    expect(openResults.violations).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(moreButton).toBeFocused();

    await moreButton.click();
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(dialog).toBeHidden();
  });

  test('renders core routes without unmocked API calls', async ({ page }) => {
    const unhandledRequests: string[] = [];
    await installIsolatedApiMocks(page, {
      onUnhandledRequest: (method, pathname) => unhandledRequests.push(`${method} ${pathname}`),
    });

    for (const route of ['/library', '/review', '/upload']) {
      await page.goto(route);
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(page.getByTestId('main-content')).toBeVisible();
    }

    expect(unhandledRequests).toEqual([]);
  });

  test('keeps phone library filter and sort controls usable', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('-phone-'), 'The desktop/tablet toolbar uses persistent filter controls.');

    await expect(page.getByRole('combobox', { name: 'Sắp xếp thư viện' })).toBeVisible();
    await page.getByRole('button', { name: 'Mở bộ lọc thư viện' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Bộ lọc thư viện' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('keeps media open and select controls independent', async ({ page }) => {
    await installIsolatedApiMocks(page, {
      mediaData: [{
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Responsive fixture',
        file_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
        thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
        media_type: 'photo',
        sku: 'RESP-001',
        brand: 'Verity',
        category: 'Studio',
        space: 'Phòng khách',
        status: 'approved',
        permission: 'public',
        ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false },
        ai_confidence: { sku: 0, brand: 0, category: 0 },
        phash: '',
        dimensions: { width: 1200, height: 800, size_bytes: 100 },
        origin_info: { source: 'Upload' },
        usage_count: 0,
        created_at: '2026-09-08T00:00:00.000Z',
      }],
    });
    await page.goto('/library');
    const card = page.locator('article').first();
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Chọn ảnh' })).toBeVisible();
    await expect(card.getByRole('button', { name: /Mở chi tiết/ })).toBeVisible();
    await expect(card.getAttribute('role')).resolves.toBeNull();
    await card.getByRole('button', { name: /Mở chi tiết/ }).click();
    await expect(page.getByRole('button', { name: 'Đóng chi tiết asset' })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('keeps review image and metadata tasks switchable on constrained screens', async ({ page }, testInfo) => {
    const asset = {
      id: '00000000-0000-4000-8000-000000000002',
      title: 'Review fixture',
      file_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      media_type: 'photo', sku: 'REV-001', brand: 'Verity', category: 'Studio', space: 'Phòng khách',
      status: 'pending', permission: 'public',
      ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false },
      ai_confidence: { sku: 0.72, brand: 0.95, category: 0.9 }, phash: '',
      dimensions: { width: 1200, height: 800, size_bytes: 100 }, origin_info: { source: 'Upload' },
      usage_count: 0, created_at: '2026-09-08T00:00:00.000Z',
    };
    await installIsolatedApiMocks(page, {
      reviewData: [{ id: '00000000-0000-4000-8000-000000000003', asset, status: 'pending', is_duplicate: false, user_corrections: {}, suggested_caption: '', created_at: '2026-09-08T00:00:00.000Z' }],
    });
    await page.goto('/review');
    await page.getByRole('tab', { name: 'Tập trung' }).click();
    const frame = page.getByTestId('review-image-frame');
    await expect(frame).toBeVisible();
    const frameBox = await frame.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(frameBox!.height / frameBox!.width).toBeCloseTo(800 / 1200, 1);

    if (!testInfo.project.name.includes('-phone-') && !testInfo.project.name.includes('-tablet-')) {
      await expect(page.getByTestId('main-content')).toBeVisible();
      const mainBox = await page.getByTestId('main-content').boundingBox();
      const approveBox = await page.getByRole('button', { name: 'Duyệt & tiếp' }).boundingBox();
      const dimensions = await page.getByTestId('main-content').evaluate((node) => ({
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      }));
      expect(mainBox).not.toBeNull();
      expect(approveBox).not.toBeNull();
      expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight + 1);
      expect(approveBox!.y + approveBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height + 1);
      await expectNoDocumentOverflow(page);
      return;
    }
    if (testInfo.project.name.includes('tablet-1180x820')) {
      await expect(page.getByTestId('main-content').getByText('Sản phẩm chính', { exact: true })).toBeVisible();
      await expectNoDocumentOverflow(page);
      return;
    }
    await expect(page.getByRole('tab', { name: 'Metadata' })).toBeVisible();
    await page.getByRole('tab', { name: 'Metadata' }).click();
    await expect(page.getByTestId('main-content').getByText('Sản phẩm chính', { exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('keeps the review approval CTA visible while its decision is submitting', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('-desktop-'), 'The sticky review footer is asserted at its desktop layout.');

    const asset = {
      id: '00000000-0000-4000-8000-000000000010',
      title: 'Submitting review fixture',
      file_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      thumbnail_url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      media_type: 'photo', sku: 'REV-SUBMIT-001', brand: 'Verity', category: 'Studio', space: 'Phòng khách',
      status: 'pending', permission: 'public',
      ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false },
      ai_confidence: { sku: 0.72, brand: 0.95, category: 0.9 }, phash: '',
      dimensions: { width: 1200, height: 800, size_bytes: 100 }, origin_info: { source: 'Upload' },
      usage_count: 0, created_at: '2026-09-09T00:00:00.000Z',
    };
    let releaseSubmission: (() => void) | undefined;
    const submissionGate = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });

    await installIsolatedApiMocks(page, {
      reviewData: [{ id: '00000000-0000-4000-8000-000000000011', asset, status: 'pending', is_duplicate: false, user_corrections: {}, suggested_caption: '', created_at: '2026-09-09T00:00:00.000Z' }],
    });
    await page.route('**/api/review-queue/*/decision', async (route) => {
      await submissionGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
    });

    await page.goto('/review');
    await page.getByRole('tab', { name: 'Tập trung' }).click();
    await page.getByRole('button', { name: 'Duyệt & tiếp' }).click();

    const submittingButton = page.getByRole('button', { name: 'Đang duyệt…' });
    await expect(submittingButton).toBeVisible();
    await expect(submittingButton).toBeDisabled();
    await expect(submittingButton).toHaveAttribute('aria-busy', 'true');
    const backgroundColor = await submittingButton.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(backgroundColor).not.toBe('rgba(0, 0, 0, 0)');

    releaseSubmission?.();
    await expect(page.getByText('Hết hàng chờ.', { exact: false })).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
