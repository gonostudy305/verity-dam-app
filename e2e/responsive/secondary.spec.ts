import { test, expect } from '@playwright/test';

import { expectNoDocumentOverflow, installIsolatedApiMocks } from './helpers';

test.describe('secondary responsive surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installIsolatedApiMocks(page);
  });

  test('Settings keeps the section picker and content inside the viewport', async ({ page }, testInfo) => {
    await page.goto('/settings');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expectNoDocumentOverflow(page);
    if (testInfo.project.name.includes('-phone-')) {
      await expect(page.locator('#settings-section-picker')).toBeVisible();
      await page.locator('#settings-section-picker').selectOption('taxonomy');
      await expect(page).toHaveURL(/section=taxonomy/);
    } else {
      await expect(page.getByText('Cài đặt hệ thống')).toBeVisible();
    }
    await expectNoDocumentOverflow(page);
  });

  test('Shot List keeps filters and action header usable', async ({ page }) => {
    await page.goto('/shot');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByRole('button', { name: /L.*m.*i Shot List/i })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('Studio and Spec remain readable at constrained widths', async ({ page }) => {
    await page.goto('/studio');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.goto('/spec');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.locator('main').first()).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('Login form keeps fields and password control reachable without app-shell assumptions', async ({ page }) => {
    await page.context().clearCookies({ name: 'better-auth.session_token' });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /Đăng nhập vào kho tài sản/i })).toBeVisible();
    await expect(page.getByText('LAN Dev')).toHaveCount(0);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /m.*t kh.*u/i })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test('phone viewport can resize/rotate without leaving a horizontal document', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await expectNoDocumentOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoDocumentOverflow(page);
  });
});
