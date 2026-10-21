import { test, expect } from './helpers/input';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// Structural scan (axe-core) of every platform page, dialog and the embedded
// workbench. Colour contrast is excluded (design tokens, not interaction).

async function violations(page: Page, include?: string) {
  let b = new AxeBuilder({ page }).disableRules(['color-contrast', 'color-contrast-enhanced']);
  if (include) b = b.include(include);
  const r = await b.analyze();
  return r.violations.map((v) => ({ rule: v.id, impact: v.impact, count: v.nodes.length, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
}
async function flowId(page: Page, name: string) {
  const items = (await (await page.request.get('/api/flows?limit=50')).json()).items as { id: string; name: string }[];
  return items.find((f) => f.name === name)!.id;
}

test('axe: projects', async ({ page }) => {
  await page.goto('/projects');
  await page.waitForSelector('.project-card');
  expect(await violations(page)).toEqual([]);
});

test('axe: add / edit project dialogs', async ({ page }) => {
  await page.goto('/projects');
  await page.waitForSelector('.project-card');
  await page.locator('.add-project-trigger').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page, '[role="dialog"]')).toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('.project-card-edit-btn').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page, '[role="dialog"]')).toEqual([]);
});

test('axe: flows list (gallery, the default)', async ({ page }) => {
  await page.goto('/flows');
  await page.waitForSelector('.flow-card');
  expect(await violations(page)).toEqual([]);
});

test('axe: flows list (table)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('flows-layout', 'table'));
  await page.goto('/flows');
  await page.waitForSelector('.flows-table-row');
  expect(await violations(page)).toEqual([]);
});

test('axe: flow detail and map', async ({ page }) => {
  const id = await flowId(page, 'Login path');
  await page.goto(`/flows/${id}`);
  await page.waitForSelector('button.flow-step-title-link');
  expect(await violations(page)).toEqual([]);
  await page.locator('.flow-detail-tab-bar').getByRole('button', { name: 'Map', exact: true }).click();
  await page.waitForSelector('.flow-graph-node');
  expect(await violations(page)).toEqual([]);
});

test('axe: service map, with a selection open', async ({ page }) => {
  await page.goto('/map');
  await page.waitForSelector('.smap-card');
  expect(await violations(page)).toEqual([]);
  await page.locator('.smap-feature').first().click();
  await expect(page.locator('.smap-panel')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('axe: settings', async ({ page }) => {
  test.skip(true, 'Settings is hidden for now (SETTINGS_ENABLED in PlatformShell)');
  await page.goto('/settings');
  await page.waitForTimeout(800);
  expect(await violations(page)).toEqual([]);
});

test('axe: embedded workbench (findings)', async ({ page }) => {
  await page.goto('/p/alpha#/findings');
  await page.waitForSelector('[data-nav-area="findings-list"]');
  await page.waitForTimeout(500);
  expect(await violations(page)).toEqual([]);
});
