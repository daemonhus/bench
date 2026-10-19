import {
  test, expect, openView, activeArea, navFocusedIds, focusedIndex,
  matchesFocusVisible, outlineStyle, lastInput, nextFrame, parkMouse, isPhone,
} from './helpers/input';

// Keyboard <-> mouse focus scenarios. Cases are numbered as in
// plan/keyboard-focus-tests.md (M = bench workbench). Input is always trusted
// (page.keyboard / page.mouse); `.focus()` only arranges a starting point.

const FINDING = '[data-finding-id]';
// Focus the list as Tab does (no scroll): a plain .focus() lets the browser scroll the tall list.
const focusList = (page: import('@playwright/test').Page) => page.locator(LIST).evaluate((e: HTMLElement) => e.focus({ preventScroll: true }));
const LIST = '[data-nav-area="findings-list"]';
const FILTER = '[data-nav-area="findings-filter"]';

/**
 * Click the filter row's heading: a non-focusable child, so the browser moves
 * focus to the row itself (the nearest focusable ancestor) and filters nothing.
 */
async function clickFilterRowBackground(page: import('@playwright/test').Page) {
  await page.locator(`${FILTER} h2`).click();
}

test.describe('M. Findings list: keyboard <-> mouse', () => {
  test.beforeEach(async ({ page }) => {
    await openView(page, '/#/findings', LIST);
    await expect(page.locator(FINDING).nth(5)).toBeVisible();
  });

  test('M1 click after arrow keys: ArrowDown continues from the clicked card', async ({ page }) => {
    await focusList(page); // arrange: focusing the container seeds the first card on screen (item 0 here)
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(2);

    await page.locator(FINDING).nth(4).click({ position: { x: 8, y: 8 } });
    expect(await lastInput(page)).toBe('pointer');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(4);

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(5);
  });

  test('M2 clicking a filter control drops the list anchor', async ({ page }) => {
    await focusList(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => navFocusedIds(page)).toHaveLength(1);

    await clickFilterRowBackground(page);
    await expect.poll(() => navFocusedIds(page)).toHaveLength(0);
  });

  test('M3 returning to the list by Tab resumes at the first card on screen, without scrolling', async ({ page }) => {
    // On a phone the filter row and the list are never on screen together, so coming back by Tab
    // has to bring the list into view; the no-jump case is a list already on screen.
    test.skip(isPhone(page), 'filter row and list are not on screen together on a phone');
    await focusList(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(3);

    await clickFilterRowBackground(page);
    await expect.poll(() => navFocusedIds(page)).toHaveLength(0);

    // From the filter row, Tab cycles to the list (App.tsx area cycle). It resumes at the first
    // card on screen, not the old anchor, and the list stays where it is (a long list used to
    // jump back to its first card).
    const listTop = () => page.locator(LIST).evaluate((e) => Math.round(e.getBoundingClientRect().top));
    // Let the arrow keys' smooth scroll finish before measuring.
    let before = await listTop();
    await expect.poll(async () => { const now = await listTop(); const still = now === before; before = now; return still; }, { intervals: [150] }).toBe(true);
    await page.keyboard.press('Tab');
    expect(await activeArea(page)).toBe('findings-list');
    await expect.poll(() => navFocusedIds(page)).toHaveLength(1);
    await page.waitForTimeout(400); // a smooth scroll, if one started, would be under way by now
    expect(await listTop()).toBe(before);
    const box = (await page.locator('[data-nav-focused="true"]').first().boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(0);
    expect(box.y).toBeLessThan(page.viewportSize()!.height);
  });

  test('M4 clicking blank space outside the cards drops the anchor', async ({ page }) => {
    test.skip(isPhone(page), 'the click point is inside the full-width list on a phone');
    await focusList(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => navFocusedIds(page)).toHaveLength(1);

    // Header area of the page: not focusable, outside the list.
    await page.mouse.click(5, 300);
    await expect.poll(() => navFocusedIds(page)).toHaveLength(0);
  });

  test('M9 area ring: keyboard shows it, mouse hides it, keyboard shows it again', async ({ page }) => {
    const filter = page.locator('[data-nav-area="findings-filter"]');
    const list = page.locator(LIST);

    await filter.focus(); // arrange
    await page.keyboard.press('Tab'); // keyboard -> list
    expect(await activeArea(page)).toBe('findings-list');
    expect(await lastInput(page)).toBe('keyboard');
    expect(await matchesFocusVisible(list)).toBe(true);
    expect(await outlineStyle(list)).not.toBe('none');

    // Mouse: click the filter row background (focusable container).
    await clickFilterRowBackground(page);
    expect(await lastInput(page)).toBe('pointer');
    await expect.poll(() => activeArea(page)).toBe('findings-filter');
    expect(await matchesFocusVisible(filter)).toBe(false);
    expect(await outlineStyle(filter)).toBe('none');

    await page.keyboard.press('Tab');
    expect(await activeArea(page)).toBe('findings-list');
    expect(await matchesFocusVisible(list)).toBe(true);
    await nextFrame(page);
    await parkMouse(page);
  });
});

test.describe('M. Browse: clicked area becomes the Tab origin', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(isPhone(page), 'three panes side by side: a desktop layout (phone drawers are covered in responsive.spec)');
    await openView(page, '/#/browse', '.tree-node');
    await page.locator('.tree-file').first().click();
    await page.waitForSelector('[data-line-id]', { timeout: 8000 });
  });

  test('M5 click the code area, then Tab -> sidebar, Shift+Tab x2 -> filetree', async ({ page }) => {
    await page.locator('[data-nav-area="codeview"] .diff-view').click();
    await expect.poll(() => activeArea(page)).toBe('codeview');

    await page.keyboard.press('Tab');
    expect(await activeArea(page)).toBe('sidebar');
    await page.keyboard.press('Shift+Tab');
    expect(await activeArea(page)).toBe('codeview');
    await page.keyboard.press('Shift+Tab');
    expect(await activeArea(page)).toBe('filetree');
  });

  test('M6 click a button inside the sidebar, then Tab -> next area, not next button', async ({ page }) => {
    // (The orphan badge is the first sidebar button and opens a dialog - use a plain filter button.)
    const btn = page.locator('[data-nav-area="sidebar"] .sidebar-sev-btn').first();
    if (await btn.count() === 0) test.skip(true, 'sidebar has no button in this fixture state');
    await btn.click();
    await page.keyboard.press('Tab');
    expect(await activeArea(page)).toBe('filetree');
  });
});
