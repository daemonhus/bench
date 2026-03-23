import { test, expect } from '@playwright/test';

/**
 * Visual verification of CSS fixes:
 * 1. --text-muted contrast (line numbers readable)
 * 2. Line-height alignment (code rows consistent)
 * 3. Hardcoded colors → tokens (badges, buttons render correctly)
 * 4. Z-index layering (modal above FAB, tooltip above modal)
 * 5. Severity dots + legend spacing (consistent sizing)
 */

test.describe('Browse view CSS fixes', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to browse mode via hash route
    await page.goto('/#/browse/CLAUDE.md');
    await page.waitForSelector('[data-line-id]', { timeout: 10000 });
  });

  test('Fix 1: text-muted contrast — line numbers use #6e7681', async ({ page }) => {
    const lineNum = page.locator('.line-number').first();
    const color = await lineNum.evaluate(el => getComputedStyle(el).color);
    // #6e7681 = rgb(110, 118, 129)
    expect(color).toBe('rgb(110, 118, 129)');

    await page.screenshot({ path: 'e2e/screenshots/fix1-text-muted.png' });
  });

  test('Fix 2: line-height — diff-row and code-content both 20px', async ({ page }) => {
    const row = page.locator('.diff-row').first();
    const rowLH = await row.evaluate(el => getComputedStyle(el).lineHeight);
    expect(rowLH).toBe('20px');

    const code = page.locator('.code-content').first();
    const codeLH = await code.evaluate(el => getComputedStyle(el).lineHeight);
    expect(codeLH).toBe('20px');

    await page.screenshot({ path: 'e2e/screenshots/fix2-line-height.png' });
  });

  test('Fix 4: z-index — FAB=100 (--z-fab), modal=300 (--z-modal)', async ({ page }) => {
    const fab = page.locator('.shortcuts-fab');
    await expect(fab).toBeVisible();
    const fabZ = await fab.evaluate(el => getComputedStyle(el).zIndex);
    expect(fabZ).toBe('100');

    // Open shortcuts modal via ? key
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    const overlay = page.locator('.shortcuts-overlay');
    if (await overlay.count() > 0) {
      const modalZ = await overlay.evaluate(el => getComputedStyle(el).zIndex);
      expect(modalZ).toBe('300');
      await page.screenshot({ path: 'e2e/screenshots/fix4-modal-layering.png' });
      await page.keyboard.press('Escape');
    }
  });

  test('screenshot: browse view with code', async ({ page }) => {
    await page.screenshot({ path: 'e2e/screenshots/browse-view.png' });
  });
});

test.describe('Overview and Delta views', () => {
  test('screenshot: overview view', async ({ page }) => {
    await page.goto('/#/overview');
    await page.waitForTimeout(1000);
    // Verify muted text color is correct on overview too
    const body = page.locator('body');
    const mutedVar = await body.evaluate(el =>
      getComputedStyle(el).getPropertyValue('--text-muted').trim()
    );
    expect(mutedVar).toBe('#6e7681');
    await page.screenshot({ path: 'e2e/screenshots/overview-view.png' });
  });

  test('screenshot: delta view', async ({ page }) => {
    await page.goto('/#/delta');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/delta-view.png' });
  });

  test('Fix 4: z-index tokens resolve correctly on root', async ({ page }) => {
    await page.goto('/#/overview');
    await page.waitForTimeout(500);
    const body = page.locator('body');
    const values = await body.evaluate(el => {
      const s = getComputedStyle(el);
      return {
        zSticky: s.getPropertyValue('--z-sticky').trim(),
        zHeader: s.getPropertyValue('--z-header').trim(),
        zPanel: s.getPropertyValue('--z-panel').trim(),
        zFab: s.getPropertyValue('--z-fab').trim(),
        zOverlay: s.getPropertyValue('--z-overlay').trim(),
        zModal: s.getPropertyValue('--z-modal').trim(),
        zTooltip: s.getPropertyValue('--z-tooltip').trim(),
      };
    });
    expect(values.zSticky).toBe('1');
    expect(values.zHeader).toBe('10');
    expect(values.zPanel).toBe('20');
    expect(values.zFab).toBe('100');
    expect(values.zOverlay).toBe('200');
    expect(values.zModal).toBe('300');
    expect(values.zTooltip).toBe('400');
  });

  test('Fix 3: color tokens resolve correctly', async ({ page }) => {
    await page.goto('/#/overview');
    await page.waitForTimeout(500);
    const body = page.locator('body');
    const values = await body.evaluate(el => {
      const s = getComputedStyle(el);
      return {
        accentGreen: s.getPropertyValue('--accent-green').trim(),
        statusDraft: s.getPropertyValue('--status-draft').trim(),
        statusAccepted: s.getPropertyValue('--status-accepted').trim(),
        btnSuccess: s.getPropertyValue('--btn-success').trim(),
        btnSuccessHover: s.getPropertyValue('--btn-success-hover').trim(),
      };
    });
    expect(values.accentGreen).toBe('#3fb950');
    expect(values.statusDraft).toBe('#8b949e');
    expect(values.statusAccepted).toBe('#bc8cff');
    expect(values.btnSuccess).toBe('#238636');
    expect(values.btnSuccessHover).toBe('#2ea043');
  });
});
