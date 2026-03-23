import { test, expect } from '@playwright/test';

test.describe('Keyboard Shortcuts Button & Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/browse');
    // Wait for the app layout to render
    await page.waitForSelector('.app-layout', { timeout: 5000 });
  });

  test('keyboard shortcuts button is visible at bottom-right of viewport', async ({ page }) => {
    const btn = page.locator('.shortcuts-fab');
    await expect(btn).toBeVisible({ timeout: 3000 });

    const btnBox = await btn.boundingBox();
    const viewport = page.viewportSize()!;

    expect(btnBox).not.toBeNull();
    // Button should be within 40px of the bottom edge
    expect(btnBox!.y + btnBox!.height).toBeGreaterThan(viewport.height - 40);
    // Button should be within 40px of the right edge
    expect(btnBox!.x + btnBox!.width).toBeGreaterThan(viewport.width - 40);
  });

  test('clicking keyboard button opens shortcuts modal', async ({ page }) => {
    const btn = page.locator('.shortcuts-fab');
    await btn.click();
    await page.waitForTimeout(200);

    const modal = page.locator('.shortcuts-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.shortcuts-title')).toHaveText('Keyboard Shortcuts');

    // Verify shortcut groups are rendered
    const groups = modal.locator('.shortcuts-group');
    expect(await groups.count()).toBeGreaterThanOrEqual(3);

    // Verify kbd elements exist
    const kbds = modal.locator('.shortcuts-kbd');
    expect(await kbds.count()).toBeGreaterThanOrEqual(5);
  });

  test('escape closes the shortcuts modal', async ({ page }) => {
    const btn = page.locator('.shortcuts-fab');
    await btn.click();
    await page.waitForTimeout(200);

    const modal = page.locator('.shortcuts-modal');
    await expect(modal).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    await expect(modal).not.toBeVisible();
  });

  test('clicking overlay closes the shortcuts modal', async ({ page }) => {
    const btn = page.locator('.shortcuts-fab');
    await btn.click();
    await page.waitForTimeout(200);

    const overlay = page.locator('.shortcuts-overlay');
    await expect(overlay).toBeVisible();

    // Click the overlay (not the modal itself)
    await overlay.click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(200);

    await expect(overlay).not.toBeVisible();
  });
});
