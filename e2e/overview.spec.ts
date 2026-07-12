import { test, expect } from '@playwright/test';

test.describe('Overview page', () => {
  test('renders via #/overview with all three columns', async ({ page }) => {
    await page.goto('/#/overview');

    // Header band: project context + KPIs
    await expect(page.locator('.ovp-project-title')).toBeVisible();
    await expect(page.locator('.ovp-header-owner[href="#/config"]')).toBeVisible();
    await expect(page.locator('.ovp-kpi')).toHaveCount(3);

    // Column 1: findings (status strip + systemic + weekly chart)
    await expect(page.locator('.ovp-panel-title', { hasText: 'Findings' })).toBeVisible();
    await expect(page.locator('.fmetrics-res-strip-cell')).toHaveCount(4);
    await expect(page.locator('.ovp-subtitle', { hasText: 'Systemic issues' })).toBeVisible();
    await expect(page.locator('.ovp-subtitle', { hasText: 'Raised per week' })).toBeVisible();

    // Column 2: repository (baseline callout, head, log, activity)
    await expect(page.locator('.ovp-panel-title', { hasText: 'Repository' })).toBeVisible();
    await expect(page.locator('.ovp-baseline-callout')).toBeVisible();
    await expect(page.locator('.ovp-head-hash')).toBeVisible();
    await expect(page.locator('.ovp-git-tree .git-tree-row').first()).toBeVisible();
    await expect(page.locator('.ovp-subtitle', { hasText: 'Activity' })).toBeVisible();
    await expect(page.locator('.ovp-act-plot .ovp-chart-bar').first()).toBeVisible();
    await expect(page.locator('.ovp-act-avatar').first()).toBeVisible();
    await expect(page.locator('.ovp-act-nav .icon-btn').first()).toBeVisible();

    // Column 3: attack surface (kind waffle + map)
    await expect(page.locator('.ovp-panel-title', { hasText: 'Attack surface' })).toBeVisible();
    await expect(page.locator('.ovp-subtitle', { hasText: 'Feature map' })).toBeVisible();
    await expect(page.locator('.ovp-map')).toBeVisible();
    await expect(page.locator('.ovp-map-node-el').first()).toBeVisible();

    // Panel titles deep-link to their pages
    await expect(page.locator('.ovp-panel-title-link[href="#/findings"]').first()).toBeVisible();
    await expect(page.locator('.ovp-panel-title-link[href="#/features"]').first()).toBeVisible();

    // Log rows carry commit/branch tooltips
    const rowTip = await page.locator('.ovp-git-tree .git-tree-row').first().getAttribute('data-tooltip');
    expect(rowTip).toBeTruthy();

    // Overview is the first tab and marked active
    const firstTab = page.locator('.tab-bar-tab').first();
    await expect(firstTab).toContainText('Overview');
    await expect(firstTab).toHaveClass(/tab-bar-tab-active/);
  });

  test('keyboard shortcut 0 switches to overview', async ({ page }) => {
    await page.goto('/#/findings');
    await page.waitForSelector('.tab-bar');
    await page.keyboard.press('0');
    await expect(page.locator('.ovp-columns')).toBeVisible();
  });
});
