import { test, expect, openView, activeArea } from './helpers/input';
import type { Page } from '@playwright/test';

// Every visible control must have a keyboard path. In views with nav-area
// cycling Tab only visits areas, so a control is reachable only if it is:
//   - in a toolbar group (`[data-chrome]`, walked with F6 + arrows), or
//   - in a card (`[data-nav-id]`, entered with Right from the item), or
//   - inside a dialog, or
//   - in an area that rove arrows over its own controls (checked below), or
//   - in a view without area cycling (Overview, Profile, feature detail), where
//     native Tab applies.
// This test lists every control that is none of those.

const AREAS_WITH_ROVING = ['findings-filter', 'features-tabs', 'features-filter', 'delta-header', 'delta-filters'];

const VIEWS: { name: string; hash: string; ready: string; prep?: (p: Page) => Promise<void> }[] = [
  { name: 'Browse', hash: '/#/browse/CLAUDE.md', ready: '[data-line-id]' },
  { name: 'Changes', hash: '/#/delta', ready: '[data-nav-area="delta-header"]' },
  { name: 'Findings', hash: '/#/findings', ready: '[data-nav-area="findings-list"]' },
  { name: 'Features', hash: '/#/features', ready: '[data-nav-area="features-list"]' },
];

async function unreachable(page: Page): Promise<string[]> {
  return page.evaluate((roving) => {
    const sel = 'button, a[href], select, input:not([type=hidden]), textarea, [role=button], summary, [tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.getClientRects().length === 0) continue;
      if (el.closest('[data-chrome]') || el.classList.contains('shortcuts-fab')) continue;
      if (el.closest('[data-nav-id]')) continue;
      if (el.closest('[role=dialog]')) continue;
      const area = el.closest('[data-nav-area]')?.getAttribute('data-nav-area') ?? '';
      if (roving.includes(area)) continue;
      // The tree rows, code panes and list containers are the areas themselves.
      if (el.hasAttribute('data-nav-area') || el.classList.contains('file-tree') || el.tagName === 'MAIN' || el.tagName === 'ASIDE') continue;
      if (el.closest('.file-tree, .diff-view, .code-view')) continue;
      out.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} "${(el.getAttribute('title') || el.getAttribute('data-tooltip') || el.textContent || '').trim().slice(0, 24)}" [area=${area || '-'}]`);
    }
    return out;
  }, AREAS_WITH_ROVING);
}

for (const v of VIEWS) {
  test(`${v.name}: every visible control has a keyboard path`, async ({ page }) => {
    await openView(page, v.hash, v.ready);
    await v.prep?.(page);
    await page.waitForTimeout(500);
    expect(await unreachable(page)).toEqual([]);
  });
}

// The areas excluded above must really rove: Right/Left walk their controls.
const ROVING = [
  { route: '/#/findings', area: 'findings-filter', ready: '[data-nav-area="findings-list"]' },
  { route: '/#/features', area: 'features-filter', ready: '[data-nav-area="features-list"]' },
  { route: '/#/delta', area: 'delta-header', ready: '[data-nav-area="delta-header"]' },
  { route: '/#/delta', area: 'delta-filters', ready: '[data-nav-area="delta-header"]' },
];
for (const r of ROVING) {
  test(`area ${r.area}: Right/Left move between its controls`, async ({ page }) => {
    await openView(page, r.route, r.ready);
    const area = page.locator(`[data-nav-area="${r.area}"]`);
    await area.focus();
    const controls = await area.locator('button:not([disabled]), select:not([disabled]), a[href]').count();
    test.skip(controls < 2, 'fewer than two controls');
    const seen: string[] = [];
    const here = () => page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName}|${a.getAttribute('title') ?? ''}|${a.textContent?.trim().slice(0, 12)}|${a.className.toString().split(' ')[0]}` : '';
    });
    seen.push(await here());
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowRight');
      seen.push(await here());
    }
    expect(new Set(seen).size).toBeGreaterThan(1);
    expect(await activeArea(page)).toBe(r.area);
  });
}

// features-tabs is the exception: Left/Right switch the kind tab (the active tab
// is the one control), so it is covered by a behaviour check, not the walk above.
test('area features-tabs: Right/Left switch the kind tab', async ({ page }) => {
  await openView(page, '/#/features', '[data-nav-area="features-list"]');
  await page.locator('[data-nav-area="features-tabs"]').focus();
  const active = () => page.locator('[data-nav-area="features-tabs"] .activity-kind-toggle-active, [data-nav-area="features-tabs"] [aria-pressed="true"], [data-nav-area="features-tabs"] .active').first().textContent();
  const before = await active();
  await page.keyboard.press('ArrowRight');
  expect(await active()).not.toBe(before);
  await page.keyboard.press('ArrowLeft');
  expect(await active()).toBe(before);
});
