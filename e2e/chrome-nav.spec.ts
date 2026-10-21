import { test, expect, openView, activeArea, lastInput, isPhone } from './helpers/input';
import type { Page } from '@playwright/test';

// The top chrome (view tabs, quick-add buttons, theme toggle, shortcuts button)
// sits outside every nav area and Tab only cycles areas, so it needs its own
// way in:  F6  jumps to it,  Left/Right/Home/End  move within it,
// Escape (or F6 again) returns to where focus was,  Tab  continues into the page.

const LIST = '[data-nav-area="findings-list"]';
const inChrome = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && (!!a.closest('[data-chrome]') || a.classList.contains('shortcuts-fab'));
  });
const chromeDesc = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return '';
    // Position among the chrome's own controls makes those with identical labels distinct
    // (not the whole document's: cards loading their code snippets would shift it mid-test).
    const pos = Array.from(document.querySelectorAll('[data-chrome] button, [data-chrome] a[href], [data-chrome] select, .shortcuts-fab')).indexOf(a);
    return `${pos}:` + (a.getAttribute('title') || a.getAttribute('data-tooltip') || a.textContent || a.className).trim().slice(0, 24);
  });

test.describe('Chrome toolbar: keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await openView(page, '/#/findings', LIST);
    await page.locator(LIST).focus(); // arrange: a content area has focus
  });

  test('is a labelled toolbar landmark', async ({ page }) => {
    // Every toolbar group is a labelled toolbar (or labelled group / status banner).
    const bad = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-chrome]'))
        .filter((el) => !/^(toolbar|group|status)$/.test(el.getAttribute('role') ?? '') && !el.matches('button, a[href]') && !el.hasAttribute('role'))
        .map((el) => el.className.toString().split(' ')[0]));
    // Bare wrappers (the new-item pill) carry no role; every other group must.
    expect(bad.filter((c) => c !== 'feed-new-pill-wrap')).toEqual([]);
    const bar = page.locator('.tab-bar[data-chrome]');
    await expect(bar).toHaveAttribute('role', 'toolbar');
    expect(((await bar.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(0);
  });

  test('F6 moves focus to the active view tab', async ({ page }) => {
    await page.keyboard.press('F6');
    expect(await inChrome(page)).toBe(true);
    await expect(page.locator('.tab-bar-tab-active')).toBeFocused();
    expect(await lastInput(page)).toBe('keyboard');
  });

  test('ArrowRight / ArrowLeft walk every chrome control, Home/End jump to the ends', async ({ page }) => {
    await page.keyboard.press('F6'); // lands on the ACTIVE tab, not the first control
    await page.keyboard.press('Home');
    const seen = [await chromeDesc(page)];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('ArrowRight');
      const d = await chromeDesc(page);
      if (d === seen[seen.length - 1]) break;
      seen.push(d);
    }
    // 6 tabs + 3 quick-add + theme toggle + the view's panel controls + shortcuts button
    expect(seen.length).toBeGreaterThanOrEqual(11);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.some((d) => /Add comment/i.test(d))).toBe(true);
    // the shortcuts button is a keyboard aid and is hidden on phones
    if (!isPhone(page)) expect(seen.some((d) => /Keyboard shortcuts/i.test(d))).toBe(true);
    for (let i = seen.length - 2; i >= 0; i--) {
      await page.keyboard.press('ArrowLeft');
      expect(await chromeDesc(page)).toBe(seen[i]);
    }
    await page.keyboard.press('End');
    expect(await chromeDesc(page)).toBe(seen[seen.length - 1]);
    await page.keyboard.press('Home');
    expect(await chromeDesc(page)).toBe(seen[0]);
  });

  test('Enter on a tab switches view and lands in its primary area, same as a click', async ({ page }) => {
    await page.keyboard.press('F6');
    const features = page.locator('.tab-bar-tab', { hasText: 'Features' });
    for (let i = 0; i < 8 && !(await features.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('ArrowRight');
    }
    await expect(features).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(features).toHaveClass(/tab-bar-tab-active/);
    await expect.poll(() => activeArea(page)).toBe('features-tabs');

    // mouse reaches the same state
    await page.locator('.tab-bar-tab', { hasText: 'Findings' }).click();
    await expect.poll(() => activeArea(page)).toBe('findings-filter');
  });

  test('Escape and F6 return focus to where it was; Tab continues into the page', async ({ page }) => {
    await page.keyboard.press('F6');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    expect(await activeArea(page)).toBe('findings-list');

    await page.keyboard.press('F6');
    expect(await inChrome(page)).toBe(true);
    await page.keyboard.press('F6'); // toggles back
    expect(await activeArea(page)).toBe('findings-list');

    await page.keyboard.press('F6');
    await page.keyboard.press('Tab');
    expect(await inChrome(page)).toBe(false);
    expect(await activeArea(page)).not.toBeNull();
  });

  test('works from a text field: F6 out, Escape back into the field', async ({ page }) => {
    const search = page.locator('[data-nav-area="findings-filter"] input').first();
    await search.click();
    await page.keyboard.press('F6');
    expect(await inChrome(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(search).toBeFocused();
  });

  test('mouse then keyboard: after clicking a tab, F6 lands on that tab', async ({ page }) => {
    await page.locator('.tab-bar-tab', { hasText: 'Features' }).click();
    await expect.poll(() => activeArea(page)).toBe('features-tabs');
    await page.keyboard.press('F6');
    await expect(page.locator('.tab-bar-tab-active')).toBeFocused();
    await expect(page.locator('.tab-bar-tab-active')).toContainText('Features');
  });

  test('quick-add opened from the toolbar: focus goes into the form and Escape gives it back', async ({ page }) => {
    await page.keyboard.press('F6');
    const add = page.locator('.quick-add-comment');
    for (let i = 0; i < 12 && !(await add.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('ArrowRight');
    }
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.quick-add-popover textarea')).toBeFocused();
    await page.keyboard.press('Escape'); // empty draft: closes without asking
    await expect(page.locator('.quick-add-popover')).toBeHidden();
    await expect(add).toBeFocused();
  });

  test('the shortcuts button is reachable, opens the dialog, and Escape returns to it', async ({ page }) => {
    test.skip(isPhone(page), 'the shortcuts button is hidden on phones');
    await page.keyboard.press('F6');
    await page.keyboard.press('End');
    const fab = page.locator('.shortcuts-fab');
    await expect(fab).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(fab).toBeFocused();
  });

  test('F6 is listed in the shortcuts dialog', async ({ page }) => {
    test.skip(isPhone(page), 'the shortcuts button is hidden on phones');
    await page.locator('.shortcuts-fab').click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('F6');
  });
});
