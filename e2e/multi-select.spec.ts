import { test, expect, openView } from './helpers/input';
import type { Locator, Page } from '@playwright/test';

// MultiSelectDropdown (Severity / Actor filters): a menu-button whose focus stays
// on the trigger while Up/Down move a highlighted option (aria-activedescendant).
//   Enter / Space / Down  open        Up / Down / Home / End  move
//   Space / Enter         toggle      o                       "only this one"
//   Escape                close       click outside           close

const ROUTES = [
  { name: 'Findings', route: '/#/findings', ready: '[data-nav-area="findings-list"]' },
  { name: 'Changes', route: '/#/delta', ready: '[data-nav-area="delta-header"]' },
];

for (const r of ROUTES) {
  test.describe(`Multi-select (${r.name} severity filter)`, () => {
    let trigger: Locator;
    const options = (page: Page) => page.locator('.multi-select-dropdown .multi-select-option');
    const toggle = (page: Page, i: number) => options(page).nth(i).locator('.multi-select-option-toggle');
    const highlighted = (page: Page) => page.locator('.multi-select-dropdown .multi-select-option-focused');

    test.beforeEach(async ({ page }) => {
      await openView(page, r.route, r.ready);
      trigger = page.locator('.multi-select-trigger', { hasText: 'Severity' });
      await trigger.focus(); // arrange
    });

    test('trigger exposes menu-button state', async ({ page }) => {
      await expect(trigger).toHaveAttribute('aria-haspopup', /listbox|menu/);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.multi-select-dropdown')).toHaveAttribute('role', 'listbox');
      await expect(page.locator('.multi-select-dropdown')).toHaveAttribute('aria-multiselectable', 'true');
      await expect(toggle(page, 0)).toHaveAttribute('role', 'option');
      // the highlighted option is announced through aria-activedescendant
      const active = await trigger.getAttribute('aria-activedescendant');
      expect(active).toBeTruthy();
      expect(await page.locator(`[id="${active}"]`).count()).toBe(1);
    });

    test('Enter opens on the first option; Up/Down/Home/End move the highlight', async ({ page }) => {
      await page.keyboard.press('Enter');
      await expect(options(page).first()).toHaveClass(/multi-select-option-focused/);
      await page.keyboard.press('ArrowDown');
      await expect(options(page).nth(1)).toHaveClass(/multi-select-option-focused/);
      await page.keyboard.press('End');
      await expect(options(page).last()).toHaveClass(/multi-select-option-focused/);
      await page.keyboard.press('Home');
      await expect(options(page).first()).toHaveClass(/multi-select-option-focused/);
      await page.keyboard.press('ArrowUp'); // clamps
      await expect(options(page).first()).toHaveClass(/multi-select-option-focused/);
      await expect(trigger).toBeFocused();
    });

    test('Space toggles the highlighted option and keeps the menu open', async ({ page }) => {
      await page.keyboard.press('Enter');
      const before = await trigger.textContent();
      await page.keyboard.press('Space');
      await expect(trigger).not.toHaveText(before!);
      await expect(page.locator('.multi-select-dropdown')).toBeVisible();
      await expect(toggle(page, 0)).toHaveAttribute('aria-selected', 'false');
      await page.keyboard.press('Space');
      await expect(toggle(page, 0)).toHaveAttribute('aria-selected', 'true');
    });

    test('"o" selects only the highlighted option; the only button is visible while it is highlighted', async ({ page }) => {
      await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowDown');
      const only = highlighted(page).locator('.multi-select-only');
      await expect.poll(() => only.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
      await page.keyboard.press('o');
      await expect(trigger).toContainText('(1)');
      await expect(toggle(page, 1)).toHaveAttribute('aria-selected', 'true');
      await expect(toggle(page, 0)).toHaveAttribute('aria-selected', 'false');
    });

    test('Escape closes, keeps focus on the trigger, and updates aria-expanded', async ({ page }) => {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      await expect(page.locator('.multi-select-dropdown')).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    test('mouse: hovering moves the highlight and keyboard continues from there; click toggles; outside click closes', async ({ page }) => {
      await page.keyboard.press('Enter');
      await options(page).nth(3).hover();
      await expect(options(page).nth(3)).toHaveClass(/multi-select-option-focused/);
      await page.keyboard.press('ArrowDown');
      await expect(options(page).nth(4)).toHaveClass(/multi-select-option-focused/);
      const before = await trigger.textContent();
      await options(page).nth(2).locator('.multi-select-option-toggle').click();
      await expect(trigger).not.toHaveText(before!);
      await page.mouse.click(5, 400);
      await expect(page.locator('.multi-select-dropdown')).toBeHidden();
    });

    test('Tab away closes the menu (focus is not left behind a stale popup)', async ({ page }) => {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await expect(page.locator('.multi-select-dropdown')).toBeHidden();
    });
  });
}
