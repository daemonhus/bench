import { test, expect } from '@playwright/test';

test.describe('Overview page', () => {
  test('renders via #/overview with all three columns', async ({ page }) => {
    await page.goto('/#/overview');

    // Column 1: repository context + git state + log graph + activity
    await expect(page.locator('.ovp-project-title')).toBeVisible();
    await expect(page.locator('.ovp-context-link[href="#/config"]')).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Git state' })).toBeVisible();
    await expect(page.locator('.ovp-stat-label', { hasText: 'Last pull (HEAD)' })).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Log' })).toBeVisible();
    await expect(page.locator('.ovp-git-tree .git-tree-row').first()).toBeVisible();
    await expect(page.locator('.ovp-branch-row').first()).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Activity' })).toBeVisible();
    await expect(page.locator('.ovp-act-plot .ovp-chart-bar').first()).toBeVisible();
    await expect(page.locator('.ovp-act-avatar').first()).toBeVisible();
    await expect(page.locator('.ovp-act-nav .icon-btn').first()).toBeVisible();

    // Column 2: findings stats + systemic issues + RRD + MTTR panels
    await expect(page.locator('.ovp-stat-label', { hasText: 'Open findings' })).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Systemic issues' })).toBeVisible();
    await expect(page.locator('.ovp-stat-label', { hasText: 'Mean time to resolve' })).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Findings raised per week' })).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Mean time to resolve per week' })).toBeVisible();

    // Column 3: features + map mockup
    await expect(page.locator('.ovp-panel-title', { hasText: 'Features by kind' })).toBeVisible();
    await expect(page.locator('.ovp-panel-title', { hasText: 'Feature map' })).toBeVisible();
    await expect(page.locator('.ovp-map')).toBeVisible();
    await expect(page.locator('.ovp-map-node-el').first()).toBeVisible();

    // Panel titles deep-link to their pages
    await expect(page.locator('.ovp-panel-title-link[href="#/findings"]').first()).toBeVisible();
    await expect(page.locator('.ovp-panel-title-link[href="#/features"]').first()).toBeVisible();

    // History rows carry commit/branch tooltips
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
