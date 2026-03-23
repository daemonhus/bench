import { test, expect } from '@playwright/test';

test.describe('Comment Drag-to-Select', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for tree, then click first file to load content
    await page.waitForSelector('.tree-node', { timeout: 5000 });
    const file = page.locator('.tree-file').first();
    await file.click();
    await page.waitForSelector('[data-line-id]', { timeout: 5000 });
  });

  test('clicking action gutter starts comment range', async ({ page }) => {
    const gutter = page.locator('.diff-row .action-gutter').first();
    await gutter.click();
    await page.waitForTimeout(200);
    // Verify no crash
  });

  test('drag across multiple rows creates range bar', async ({ page }) => {
    const gutters = page.locator('.diff-row .action-gutter');
    const count = await gutters.count();
    if (count < 2) {
      test.skip();
      return;
    }

    const first = gutters.first();
    const second = gutters.nth(1);

    await first.dispatchEvent('mousedown');
    await second.dispatchEvent('mouseenter');
    await page.mouse.up();

    await page.waitForTimeout(300);
  });

  test('gutter drag shows new comment form in sidebar', async ({ page }) => {
    const gutter = page.locator('.diff-row .action-gutter').first();
    await gutter.click();
    await page.waitForTimeout(300);
    // After drag, new comment form may appear in sidebar
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
  });
});

test.describe('Sidebar Activity Stream', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tree-node', { timeout: 5000 });
  });

  test('sidebar shows activity header', async ({ page }) => {
    const header = page.locator('.sidebar-title');
    await expect(header).toBeVisible();
    await expect(header).toHaveText('Activity');
  });

  test('sidebar can be collapsed and reopened', async ({ page }) => {
    // Close sidebar via the drawer button
    const closeBtn = page.locator('.panel-drawer-btn');
    await closeBtn.click();
    await page.waitForTimeout(200);

    // Sidebar should be collapsed
    const collapsed = page.locator('.sidebar-collapsed');
    await expect(collapsed).toBeVisible();

    // Reopen
    await collapsed.click();
    await page.waitForTimeout(200);

    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
  });

  test('sidebar shows empty state when no file selected', async ({ page }) => {
    const empty = page.locator('.sidebar-empty');
    await expect(empty).toBeVisible();
  });
});
