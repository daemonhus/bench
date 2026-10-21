import { test, expect } from '@playwright/test';
import { appUrl } from './helpers/input';

test.describe('Overview page', () => {
  test('renders via #/overview with all three columns', async ({ page }) => {
    await page.goto(appUrl('/#/overview'));

    // Header band: project context + KPIs
    await expect(page.locator('.ovp-project-title')).toBeVisible();
    await expect(page.locator('.ovp-header-owner[href="#/profile"]')).toBeVisible();
    await expect(page.locator('.ovp-kpi')).toHaveCount(3);

    // Column 1: findings (status strip + systemic + findings timeline)
    await expect(page.locator('.ovp-panel-title', { hasText: 'Findings' })).toBeVisible();
    await expect(page.locator('.fmetrics-res-strip-cell')).toHaveCount(4);
    await expect(page.locator('.ovp-subtitle', { hasText: 'Systemic issues' })).toBeVisible();
    await expect(page.locator('.ovp-subtitle', { hasText: 'Findings over time' })).toBeVisible();
    await expect(page.locator('.ovp-ft-plot')).toBeVisible();

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

    // No Overview tab: the project name, top left, is the link to it, marked current here.
    await expect(page.locator('.tab-bar-tab', { hasText: 'Overview' })).toHaveCount(0);
    await expect(page.locator('.tab-bar-project-name')).toHaveAttribute('aria-current', 'page');
  });

  test('the project name, top left, opens the Overview', async ({ page }) => {
    await page.goto(appUrl('/#/findings'));
    await page.waitForSelector('.tab-bar');
    const name = page.locator('.tab-bar-project-name');
    await expect(name).not.toHaveAttribute('aria-current', 'page');
    await name.click();
    await expect(page).toHaveURL(/#\/overview$/);
    await expect(page.locator('.ovp-project-title')).toBeVisible();
  });

  test('the recent log shows whole commit messages, scrolling sideways when they are long', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(appUrl('/#/overview'));
    const log = page.locator('.ovp-git-tree');
    await expect(log.locator('.git-tree-row').first()).toBeVisible();
    // No message is clipped inside its row.
    const clipped = await log.locator('.git-tree-subject').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(clipped).toBe(0);
    // A log wider than its panel scrolls on its own; the page doesn't.
    const { sw, cw } = await log.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    if (sw > cw) {
      await log.evaluate((e) => { e.scrollLeft = 100; });
      expect(await log.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('keyboard shortcut 0 switches to overview', async ({ page }) => {
    await page.goto(appUrl('/#/findings'));
    await page.waitForSelector('.tab-bar');
    await page.keyboard.press('0');
    await expect(page.locator('.ovp-columns')).toBeVisible();
  });
});
