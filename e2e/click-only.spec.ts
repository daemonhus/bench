import { test, expect, openView, activeArea, isPhone } from './helpers/input';
import type { Locator, Page } from '@playwright/test';

// Controls that used to be mouse-only (a <span>/<div> with onClick): each must
// be a real button (role, name, tab stop), reachable from the keyboard, and do
// the same thing on Enter/Space as on a click.

const focusedCard = (page: Page) => page.locator('[data-nav-focused="true"]').first();

/** From the focused list item, press Right until `target` has focus (bounded). */
async function stepInto(page: Page, target: Locator) {
  await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 25 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(target).toBeFocused();
}

/** F6, then walk the toolbar until `target` has focus (bounded). */
async function viaToolbar(page: Page, target: Locator) {
  await page.keyboard.press('F6');
  await page.keyboard.press('Home');
  for (let i = 0; i < 80 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('ArrowRight');
  }
  await expect(target).toBeFocused();
}

const isButton = (l: Locator) => l.evaluate((el) =>
  el.tagName === 'BUTTON' || (el.getAttribute('role') === 'button' && el.tabIndex >= 0));

test.describe('Card controls that were mouse-only', () => {
  test('finding ID badge copies the ID from the keyboard, as a labelled button', async ({ page }) => {
    await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
    await page.locator('[data-nav-area="findings-list"]').focus();
    const badge = focusedCard(page).locator('.finding-id-badge');
    expect(await isButton(badge)).toBe(true);
    expect(((await badge.getAttribute('aria-label')) ?? '').toLowerCase()).toContain('copy');
    await stepInto(page, badge);
    await page.keyboard.press('Enter');
    await expect(badge).toHaveClass(/finding-id-copied/);
    await expect(badge).toContainText('Copied');
  });

  test('comment file link in a finding card goes to the code on Enter, same as a click', async ({ page }) => {
    const hashAfterClick = await (async () => {
      await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
      await page.locator('[data-finding-id] .overview-comment-file').first().click();
      await page.waitForTimeout(500);
      return page.evaluate(() => location.hash);
    })();
    expect(hashAfterClick).not.toBe('#/findings');

    await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
    await page.locator('[data-nav-area="findings-list"]').focus();
    // the seeded finding that has a comment is not necessarily the first card
    const card = page.locator('[data-finding-id]', { has: page.locator('.overview-comment-file') }).first();
    await card.locator('.overview-comment-file').first().scrollIntoViewIfNeeded();
    const link = card.locator('.overview-comment-file').first();
    expect(await isButton(link)).toBe(true);
    await card.click({ position: { x: 4, y: 4 } }); // mouse: anchor the card
    await page.locator('[data-nav-area="findings-list"]').focus();
    await link.focus(); // arrange: card controls are reached by arrows (covered in card-actions.spec)
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => location.hash)).toBe(hashAfterClick);
  });

  test('feature commit link activates from the keyboard, same as a click', async ({ page }) => {
    await openView(page, '/#/features', '[data-nav-area="features-list"]');
    const link = page.locator('[data-feature-id] .overview-commit-link').first();
    await link.waitFor();
    expect(await isButton(link)).toBe(true);
    const before = await page.evaluate(() => location.hash);
    await link.click();
    await page.waitForTimeout(500);
    const afterClick = await page.evaluate(() => location.hash);

    await openView(page, '/#/features', '[data-nav-area="features-list"]');
    await page.locator('[data-feature-id] .overview-commit-link').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => location.hash)).toBe(afterClick);
    expect(afterClick === before).toBe(false);
  });
});

test.describe('File header controls', () => {
  const openNested = async (page: Page) => {
    await openView(page, '/#/browse/src/auth/login.go', '.tree-node');
    await page.waitForSelector('[data-line-id]');
  };

  test('breadcrumb segments are buttons; Enter opens the folder, same as a click', async ({ page }) => {
    await openNested(page);
    const seg = page.locator('.file-header .path-segment', { hasText: 'auth' });
    expect(await isButton(seg)).toBe(true);
    await seg.click();
    await page.waitForTimeout(400);
    const afterClick = await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('.file-header')?.textContent }));

    await openNested(page);
    await viaToolbar(page, page.locator('.file-header .path-segment', { hasText: 'auth' }));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const afterKey = await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('.file-header')?.textContent }));
    expect(afterKey).toEqual(afterClick);
  });

  test('"Go to file…" hint is a button that opens the file search', async ({ page }) => {
    await openView(page, '/#/browse', '.tree-node');
    const hint = page.locator('.no-file-hint');
    await expect(hint).toBeVisible();
    expect(await isButton(hint)).toBe(true);
    await viaToolbar(page, hint);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Go to file' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hint).toBeFocused();
  });
});

test.describe('Sidebar controls', () => {
  test.beforeEach(({ page }) => { test.skip(isPhone(page), 'the sidebar and file panel are drawers on phones (covered in responsive.spec)'); });
  const openBrowse = async (page: Page) => {
    await openView(page, '/#/browse', '.tree-node');
    await page.locator('.tree-file').first().click();
    await page.waitForSelector('[data-line-id]');
    await page.waitForTimeout(400);
  };

  test('reconcile status is a button; Enter opens its details, Escape closes them and keeps focus', async ({ page }) => {
    await openBrowse(page);
    const status = page.locator('.reconcile-status');
    await expect(status).toBeVisible();
    expect(await isButton(status)).toBe(true);
    await expect(status).toHaveAttribute('aria-haspopup', /.+/);
    await viaToolbar(page, status);
    await page.keyboard.press('Enter');
    await expect(status).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.reconcile-tooltip-title').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.reconcile-tooltip-title')).toHaveCount(0);
    await expect(status).toBeFocused();
  });

  test('collapsed sidebar: the expand control is a button reachable by keyboard', async ({ page }) => {
    await openBrowse(page);
    await viaToolbar(page, page.locator('.panel-drawer-btn[data-tooltip="Collapse sidebar"]'));
    await page.keyboard.press('Enter');
    const open = page.locator('.sidebar-collapsed'); // the bar IS the button
    await expect(open).toBeVisible();
    expect(await isButton(open)).toBe(true);
    // Collapsing unmounted the focused toggle: focus must land on a counterpart toggle, not <body>.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-panel-toggle'))).toBe('sidebar');
    await page.keyboard.press('Enter');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.panel-drawer-btn[data-tooltip="Collapse sidebar"]')).toBeFocused();
  });

  test('file panel: hiding it by keyboard hands focus to "Show file panel", and back', async ({ page }) => {
    await openBrowse(page);
    const hide = page.locator('.panel-drawer-btn[data-tooltip="Hide file panel"]').first();
    await viaToolbar(page, hide);
    await page.keyboard.press('Enter');
    const show = page.locator('.panel-drawer-btn[data-tooltip="Show file panel"]');
    await expect(show).toBeVisible();
    await expect(show).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-nav-area="filetree"]')).toBeVisible();
    await expect(page.locator('.panel-drawer-btn[data-tooltip="Hide file panel"]').first()).toBeFocused();
  });

  test('a mouse user who clicked elsewhere is not pulled back to the toggle', async ({ page }) => {
    await openBrowse(page);
    await page.locator('.panel-drawer-btn[data-tooltip="Collapse sidebar"]').click();
    await expect(page.locator('.sidebar-collapsed')).toBeVisible();
    // (a mouse click focuses the button, which unmounts: the handoff applies - same as keyboard)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-panel-toggle'))).toBe('sidebar');
    await page.locator('[data-nav-area="filetree"]').click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(300);
    expect(await activeArea(page)).toBe('filetree');
  });
});

test.describe('Inline finding card', () => {
  test('header is a button with aria-expanded that toggles on Enter and Space', async ({ page }) => {
    // Inline cards replace the sidebar in the narrow (mobile) layout.
    await page.setViewportSize({ width: 560, height: 900 });
    // The file tree is a drawer on narrow screens; open the file by URL instead.
    await page.goto('/#/browse/CLAUDE.md');
    await page.waitForSelector('[data-line-id]', { timeout: 10_000 });
    const header = page.locator('.inline-finding-header').first();
    await expect(header).toBeVisible();
    expect(await isButton(header)).toBe(true);
    const was = await header.getAttribute('aria-expanded');
    expect(was === 'true' || was === 'false').toBe(true);
    await header.focus();
    await page.keyboard.press('Enter');
    expect(await header.getAttribute('aria-expanded')).not.toBe(was);
    await page.keyboard.press('Space');
    expect(await header.getAttribute('aria-expanded')).toBe(was);
  });
});

test.describe('Hover-only reveals are also shown on keyboard focus', () => {
  test('the copy-ID icon appears when the ID badge has keyboard focus, not just on hover', async ({ page }) => {
    await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
    const badge = page.locator('[data-finding-id] .finding-id-badge').first();
    await page.mouse.move(0, 1);
    const icon = badge.locator('.finding-id-copy');
    const hiddenBefore = await icon.evaluate((el) => getComputedStyle(el).display === 'none' || Number(getComputedStyle(el).opacity) === 0);
    expect(hiddenBefore).toBe(true);
    await badge.focus();
    // The reveal is a CSS transition: poll until it has taken effect.
    await expect.poll(() => icon.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
  });
});

test.describe('File tree: a click does what Enter does', () => {
  test('clicking a file selects it in the tree, opens it, and puts focus in the code view', async ({ page }) => {
    test.skip(isPhone(page), 'the file tree is a drawer on phones (covered in responsive.spec)');
    await openView(page, '/#/browse', '[data-nav-area="filetree"]');
    const file = page.locator('.tree-file').nth(1);
    const path = await file.getAttribute('data-tree-path');
    await file.click();
    await expect(page).toHaveURL(new RegExp(`#/browse/${path!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(file).toHaveClass(/tree-selected/);
    await expect(file).toHaveClass(/tree-focused/); // the tree's keyboard cursor moved with the click
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });

  test('keyboard Enter on a file lands in the same place', async ({ page }) => {
    test.skip(isPhone(page), 'the file tree is a drawer on phones');
    await openView(page, '/#/browse', '[data-nav-area="filetree"]');
    await page.locator('[data-nav-area="filetree"]').focus(); // arrange
    for (let i = 0; i < 40 && !(await page.locator('.tree-file.tree-focused').count()); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });
});

test.describe('Find in file: an expanding search in the file header', () => {
  test('click to open, it grows, finds and highlights; leaving it empty collapses it', async ({ page }) => {
    await openView(page, '/#/browse/CLAUDE.md', '.tree-node');
    await page.waitForSelector('[data-line-id]');
    const rest = page.locator('.file-header .in-file-find--rest');
    await expect(rest).toBeVisible();
    const restWidth = (await rest.boundingBox())!.width;
    await rest.click();
    const bar = page.locator('.file-header .in-file-search-bar--inline');
    const input = bar.getByRole('textbox', { name: 'Find in file' });
    await expect(input).toBeFocused();
    if (!isPhone(page)) await expect.poll(async () => (await bar.boundingBox())!.width).toBeGreaterThan(restWidth + 40);
    await page.keyboard.type('the');
    await expect(bar.locator('.in-file-search-counter')).toHaveText(/^1 of \d+$/);
    await expect(page.locator('.search-match-current')).toHaveCount(1);
    // With a query it stays open while you read; empty, leaving it collapses it.
    await page.locator('[data-nav-area="codeview"]').focus();
    await expect(bar).toBeVisible();
    await input.fill('');
    await page.locator('[data-nav-area="codeview"]').focus();
    await expect(bar).toBeHidden();
    await expect(rest).toBeVisible();
  });

  test('Ctrl+F opens the same bar in the header; Escape returns to the code', async ({ page }) => {
    await openView(page, '/#/browse/CLAUDE.md', '.tree-node');
    await page.waitForSelector('[data-line-id]');
    await page.locator('[data-nav-area="codeview"]').focus();
    await page.keyboard.press('ControlOrMeta+f');
    const input = page.locator('.file-header .in-file-search-bar--inline input');
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.file-header .in-file-find--rest')).toBeVisible();
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });

  test('not shown on a folder listing', async ({ page }) => {
    await openView(page, '/#/browse', '.tree-node');
    await expect(page.locator('.file-header')).toBeVisible();
    await expect(page.locator('.file-header .in-file-find')).toHaveCount(0);
  });
});
