import { test, expect, openView, isPhone, primaryPane } from './helpers/input';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// Automated structural scan (axe-core) of every view and every dialog. Colour
// contrast is excluded: it is a design-token decision, not an interaction bug.
// Everything else (nested interactive controls, missing names, invalid ARIA,
// focusable-but-hidden elements, duplicate ids...) must be clean.

const RULES_OFF = ['color-contrast', 'color-contrast-enhanced'];

async function scan(page: Page, context?: string) {
  let b = new AxeBuilder({ page }).disableRules(RULES_OFF);
  if (context) b = b.include(context);
  const results = await b.analyze();
  return results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
    count: v.nodes.length,
  }));
}

const VIEWS: { name: string; hash: string; ready: string; prep?: (p: Page) => Promise<void> }[] = [
  { name: 'Overview', hash: '/#/overview', ready: '.ovp-project-title' },
  { name: 'Browse (file open)', hash: '/#/browse/CLAUDE.md', ready: '[data-line-id]' },
  { name: 'Changes', hash: '/#/delta', ready: '[data-nav-area="delta-header"]' },
  { name: 'Findings', hash: '/#/findings', ready: '[data-nav-area="findings-list"]' },
  { name: 'Features', hash: '/#/features', ready: '[data-nav-area="features-list"]' },
  { name: 'Profile', hash: '/#/profile', ready: '.profile-title' },
];

for (const v of VIEWS) {
  test(`axe: ${v.name}`, async ({ page }) => {
    await openView(page, v.hash, v.ready);
    await v.prep?.(page);
    await page.waitForTimeout(500);
    expect(await scan(page)).toEqual([]);
  });
}

test('axe: feature detail', async ({ page }) => {
  await openView(page, '/#/features', '[data-nav-area="features-list"]');
  const id = await page.locator('[data-feature-id]').first().getAttribute('data-feature-id');
  await page.goto(`/#/feature/${id}`);
  await page.waitForSelector('.feature-detail');
  expect(await scan(page)).toEqual([]);
});

test('axe: finding detail', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  const id = await page.locator('[data-finding-id]').first().getAttribute('data-finding-id');
  await page.goto(`/#/finding/${id}`);
  await page.waitForSelector('.feature-detail .fd-title');
  expect(await scan(page)).toEqual([]);
});

test('axe: expanded finding card with its reply box', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  expect(await scan(page, '[data-finding-id]')).toEqual([]);
});

test('axe: the finding page with a field open for editing', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  const id = await page.locator('[data-finding-id]').first().getAttribute('data-finding-id');
  await page.goto(`/#/finding/${id}`);
  await page.getByRole('textbox', { name: 'Description' }).click();
  await expect(page.locator('textarea.editable-input')).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

const DIALOGS: { name: string; open: (p: Page) => Promise<void>; sel: string; route: string; ready: string; desktopOnly?: boolean }[] = [
  { name: 'shortcuts', open: async (p: Page) => { await p.locator('.shortcuts-fab').click(); }, sel: '.shortcuts-modal', route: '/#/findings', ready: '[data-nav-area="findings-list"]', desktopOnly: true },
  { name: 'set baseline', open: async (p: Page) => { await p.locator('.delta-edit-pencil[data-tooltip="Set new baseline"]').click(); }, sel: '.set-baseline-modal', route: '/#/delta', ready: '[data-nav-area="delta-header"]' },
  { name: 'manage links', open: async (p: Page) => { await p.locator('[data-finding-id] button[title="Manage links"]').first().click(); }, sel: '.link-manage-modal', route: '/#/findings', ready: '[data-nav-area="findings-list"]' },
  { name: 'manage web links', open: async (p: Page) => { await p.locator('[data-finding-id] button[title="Manage web links"]').first().click(); }, sel: '.ref-manage-modal', route: '/#/findings', ready: '[data-nav-area="findings-list"]' },
  { name: 'go to file', open: async (p: Page) => { await primaryPane(p).focus(); await p.keyboard.press('Control+g'); }, sel: '.file-search-modal', route: '/#/browse/CLAUDE.md', ready: '[data-line-id]' },
  { name: 'find in files', open: async (p: Page) => { await primaryPane(p).focus(); await p.keyboard.press('Control+Shift+f'); }, sel: '.content-search-modal', route: '/#/browse/CLAUDE.md', ready: '[data-line-id]' },
];
for (const d of DIALOGS) {
  test(`axe: dialog - ${d.name}`, async ({ page }) => {
    test.skip('desktopOnly' in d && isPhone(page), 'the shortcuts button is a keyboard aid, hidden on phones');
    await openView(page, d.route, d.ready);
    await d.open(page);
    await expect(page.locator(d.sel)).toBeVisible();
    expect(await scan(page, d.sel)).toEqual([]);
  });
}
