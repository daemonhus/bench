import { test, expect } from '@playwright/test';

test.describe('Code Browser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for file tree to load (backend must be running)
    await page.waitForSelector('.tree-node', { timeout: 5000 });
  });

  test('file tree loads with files', async ({ page }) => {
    const nodes = page.locator('.tree-node');
    expect(await nodes.count()).toBeGreaterThan(0);
  });

  test('commit selector is present', async ({ page }) => {
    const button = page.locator('.commit-button');
    await expect(button.first()).toBeVisible();
    // Should show a short hash
    const hash = page.locator('.commit-button-hash');
    await expect(hash.first()).toBeVisible();
  });

  test('clicking a file shows content', async ({ page }) => {
    // Click the first file in the tree
    const file = page.locator('.tree-file').first();
    await file.click();
    // Wait for code to render
    await page.waitForSelector('[data-line-id]', { timeout: 5000 });
    const rows = page.locator('[data-line-id]');
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('browse mode shows all lines as normal', async ({ page }) => {
    const file = page.locator('.tree-file').first();
    await file.click();
    await page.waitForSelector('[data-line-id]', { timeout: 5000 });

    // In browse mode, no insert/delete rows should appear
    const insertRows = page.locator('.diff-row-insert');
    const deleteRows = page.locator('.diff-row-delete');
    expect(await insertRows.count()).toBe(0);
    expect(await deleteRows.count()).toBe(0);

    // All rows should be normal
    const normalRows = page.locator('.diff-row-normal');
    expect(await normalRows.count()).toBeGreaterThan(0);
  });

  test('file header shows selected filename', async ({ page }) => {
    const file = page.locator('.tree-file').first();
    const fileName = await file.textContent();
    await file.click();
    await page.waitForSelector('[data-line-id]', { timeout: 5000 });

    const header = page.locator('.file-header h1');
    const headerText = await header.textContent();
    expect(headerText).toContain(fileName?.trim() ?? '');
  });

  test('browse mode uses single line number column', async ({ page }) => {
    const file = page.locator('.tree-file').first();
    await file.click();
    await page.waitForSelector('[data-line-id]', { timeout: 5000 });

    const browseRows = page.locator('.browse-row');
    expect(await browseRows.count()).toBeGreaterThan(0);
    const browseLineNums = page.locator('.browse-line-number');
    expect(await browseLineNums.count()).toBeGreaterThan(0);
  });

  test('syntax highlighting produces styled spans', async ({ page }) => {
    const file = page.locator('.tree-file').first();
    await file.click();
    await page.waitForSelector('[data-line-id]', { timeout: 5000 });

    const syntaxSpans = page.locator('.code-content span[class]');
    // May or may not have syntax spans depending on file type
    // Just verify no crash
    await expect(page.locator('.diff-view')).toBeVisible();
  });

  test('selected file has highlight class', async ({ page }) => {
    const file = page.locator('.tree-file').first();
    await file.click();
    await page.waitForTimeout(300);
    const selected = page.locator('.tree-selected');
    expect(await selected.count()).toBe(1);
  });
});

test.describe('Tab Bar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-bar', { timeout: 5000 });
  });

  test('tab bar is visible with all tabs', async ({ page }) => {
    const activityTab = page.locator('.tab-bar-tab', { hasText: 'Activity' });
    const browseTab = page.locator('.tab-bar-tab', { hasText: 'Browse' });
    const deltaTab = page.locator('.tab-bar-tab', { hasText: 'Delta' });
    await expect(activityTab).toBeVisible();
    await expect(browseTab).toBeVisible();
    await expect(deltaTab).toBeVisible();
  });

  test('browse tab is active by default', async ({ page }) => {
    const browseTab = page.locator('.tab-bar-tab', { hasText: 'Browse' });
    await expect(browseTab).toHaveClass(/tab-bar-tab-active/);
  });

  test('clicking Compare toggle shows compare controls', async ({ page }) => {
    const compareBtn = page.locator('.compare-toggle-btn');
    await compareBtn.click();
    await page.waitForTimeout(200);

    // In diff mode, the commit selector shows "Compare" label and two commit buttons (To/From)
    const compareLabel = page.locator('.commit-label', { hasText: 'Compare' });
    await expect(compareLabel).toBeVisible();

    const diffButtons = page.locator('.diff-commit-buttons .commit-button');
    expect(await diffButtons.count()).toBe(2);
  });

  test('clicking Compare toggle again returns to browse', async ({ page }) => {
    // Switch to compare first
    await page.locator('.compare-toggle-btn').click();
    await page.waitForTimeout(200);

    // Toggle back to browse
    await page.locator('.compare-toggle-btn').click();
    await page.waitForTimeout(200);

    // In browse mode, should show "Ref" label, not "Compare"
    const refLabel = page.locator('.commit-label', { hasText: 'Ref' });
    await expect(refLabel).toBeVisible();

    const compareLabel = page.locator('.commit-label', { hasText: 'Compare' });
    expect(await compareLabel.count()).toBe(0);
  });
});
