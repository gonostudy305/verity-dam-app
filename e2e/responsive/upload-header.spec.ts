import { test, expect } from '@playwright/test';
import { expectNoDocumentOverflow, installIsolatedApiMocks } from './helpers';
import path from 'path';

test.describe('upload header layout', () => {
  test('presents upload mode tabs in header and hides bulky title', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installIsolatedApiMocks(page);
    await page.route('**/api/features', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ product_intakes: true }),
      });
    });
    await page.goto('/upload');

    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('main-content')).toBeVisible();

    // Check tabs in header
    const standardTab = page.getByRole('tab', { name: /Upload thông thường/ });
    const productIntakeTab = page.getByRole('tab', { name: /Hồ sơ sản phẩm mới/ });

    await expect(standardTab).toBeVisible();
    await expect(productIntakeTab).toBeVisible();
    await expect(standardTab).toHaveAttribute('aria-selected', 'true');

    // Ensure subtitle is removed from view
    await expect(page.getByText('Kéo thả hoặc dán ảnh trực tiếp từ Zalo')).toBeHidden();

    // The bulky section with 2 big cards in the body should no longer exist
    await expect(page.locator('section[aria-label="Loại upload"]')).toHaveCount(0);

    // Dropzone should be immediately visible
    await expect(page.getByText(/Kéo thả 1–100 ảnh hoặc video vào đây/)).toBeVisible();

    // Switch to product-intake
    await productIntakeTab.click();
    await expect(productIntakeTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Hồ sơ sản phẩm mới' })).toBeVisible();

    // Verify BatchContextSelector is hidden in product intake mode
    await expect(page.getByText('Ngữ cảnh chung cho cả lô')).toBeHidden();

    // Verify collapsible details for optional fields exists
    await expect(page.getByText('Thông tin bổ sung & nguồn tham khảo')).toBeVisible();

    // Save screenshot in product intake mode for artifact inspection
    const artifactDir = 'C:/Users/ADMIN/.gemini/antigravity/brain/7952959e-1c3f-4b34-903e-b46bf0fc0dfc';
    if (testInfo.project.name.includes('-desktop-1440x900')) {
      await page.screenshot({ path: path.join(artifactDir, 'product_intake_streamlined_desktop.png') });
    }

    // Switch back to standard
    await standardTab.click();
    await expect(standardTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Ngữ cảnh chung cho cả lô')).toBeVisible();

    await expectNoDocumentOverflow(page);

    if (testInfo.project.name.includes('-desktop-')) {
      await page.screenshot({ path: path.join(artifactDir, 'upload_desktop.png') });
    } else if (testInfo.project.name.includes('-phone-')) {
      await page.screenshot({ path: path.join(artifactDir, 'upload_phone.png') });
    }
  });
});
