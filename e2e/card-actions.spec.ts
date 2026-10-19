import { test, expect, openView, activeArea, navFocusedIds, isPhone } from './helpers/input';
import type { Page } from '@playwright/test';

// A focused list item (card) has controls: status, links, delete, code
// toggles, reply box. Tab only cycles areas, so these must be reachable from the
// item itself:  ->  enters the card's controls,  <- / ->  moves between them,
// Escape (or <- past the first) returns to the item.

const LISTS = [
  { name: 'Findings', route: '/#/findings', area: 'findings-list', card: '[data-finding-id]', links: 'button[title="Manage links"]' },
  { name: 'Features', route: '/#/features', area: 'features-list', card: '[data-feature-id]', links: 'button[title="Manage links"]' },
];

const focusedCard = (page: Page) => page.locator('[data-nav-focused="true"]').first();
const activeInCard = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    const card = document.querySelector('[data-nav-focused="true"]');
    return !!(a && card && card !== a && card.contains(a));
  });
const activeDesc = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    // Position among the card's controls makes siblings with the same class distinct.
    const card = document.querySelector('[data-nav-focused="true"]');
    const all = card ? Array.from(card.querySelectorAll('button, a[href], select, input, textarea')) : [];
    return a ? `${all.indexOf(a)}|${a.tagName.toLowerCase()}|${a.getAttribute('title') ?? a.className.toString().split(' ')[0]}` : '';
  });

for (const l of LISTS) {
  test.describe(`Card actions: ${l.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await openView(page, l.route, `[data-nav-area="${l.area}"]`);
      await expect(page.locator(l.card).first()).toBeVisible();
      await page.locator(`[data-nav-area="${l.area}"]`).focus(); // arrange: seeds item 0
      await expect.poll(() => navFocusedIds(page)).toHaveLength(1);
    });

    test('ArrowRight enters the focused card; the item stays the anchor', async ({ page }) => {
      expect(await activeInCard(page)).toBe(false);
      await page.keyboard.press('ArrowRight');
      expect(await activeInCard(page)).toBe(true);
      expect(await navFocusedIds(page)).toHaveLength(1);
      expect(await activeArea(page)).toBe(l.area);
    });

    test('ArrowRight / ArrowLeft move between the card controls, in order, without wrapping', async ({ page }) => {
      await page.keyboard.press('ArrowRight');
      const seen = [await activeDesc(page)];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('ArrowRight');
        const d = await activeDesc(page);
        if (d === seen[seen.length - 1]) break; // end of the controls: stays put
        seen.push(d);
      }
      expect(seen.length).toBeGreaterThan(3);
      expect(new Set(seen).size).toBe(seen.length); // every stop is a different control
      for (let i = seen.length - 2; i >= 0; i--) {
        await page.keyboard.press('ArrowLeft');
        expect(await activeDesc(page)).toBe(seen[i]);
      }
    });

    test('ArrowLeft past the first control and Escape both return to the item, anchor kept', async ({ page }) => {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowLeft');
      expect(await activeInCard(page)).toBe(false);
      expect(await navFocusedIds(page)).toHaveLength(1);

      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Escape');
      expect(await activeInCard(page)).toBe(false);
      expect(await navFocusedIds(page)).toHaveLength(1);
      expect(await activeArea(page)).toBe(l.area);
      // and ArrowDown still advances from there
      await page.keyboard.press('ArrowDown');
      expect(await navFocusedIds(page)).toHaveLength(1);
    });

    test('a card action runs from the keyboard: Manage links opens, Escape returns to the button', async ({ page }) => {
      const links = focusedCard(page).locator(l.links).first();
      await page.keyboard.press('ArrowRight');
      for (let i = 0; i < 12 && !(await links.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press('ArrowRight');
      }
      await expect(links).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Manage links' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(links).toBeFocused();
    });

    test('cards have no edit control: editing lives on the detail page', async ({ page }) => {
      // (Comments inside a card keep their own Edit.)
      const cardEdits = await page.locator(`${l.card} button[title="Edit"]`).evaluateAll((els) => els.filter((e) => !e.closest('.finding-comment')).length);
      expect(cardEdits).toBe(0);
      await expect(page.locator('.finding-edit-form, .finding-card-editing')).toHaveCount(0);
    });

    test('mouse: clicking a control inside a card, then ArrowLeft/Right, continues from that control', async ({ page }) => {
      const links = focusedCard(page).locator(l.links).first();
      await links.click();
      await page.keyboard.press('Escape'); // closes the dialog it opened
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(links).toBeFocused();
      const before = await activeDesc(page);
      await page.keyboard.press('ArrowRight');
      expect(await activeDesc(page)).not.toBe(before);
      await page.keyboard.press('ArrowLeft');
      expect(await activeDesc(page)).toBe(before);
    });
  });
}

test.describe('Card actions: Browse sidebar', () => {
  test('ArrowRight enters a sidebar card, Left/Right step, Escape returns to the card', async ({ page }) => {
    test.skip(isPhone(page), 'the sidebar is a drawer on phones');
    await openView(page, '/#/browse', '.tree-node');
    await page.locator('.tree-file').first().click();
    await page.waitForSelector('[data-line-id]');
    const sidebar = page.locator('[data-nav-area="sidebar"]');
    await expect(sidebar.locator('[data-nav-id]').first()).toBeVisible();
    await sidebar.focus(); // arrange: seeds the first card
    await expect.poll(() => navFocusedIds(page)).toHaveLength(1);

    await page.keyboard.press('ArrowRight');
    expect(await activeInCard(page)).toBe(true);
    const first = await activeDesc(page);
    await page.keyboard.press('ArrowRight');
    expect(await activeDesc(page)).not.toBe(first);
    await page.keyboard.press('Escape');
    expect(await activeInCard(page)).toBe(false);
    expect(await navFocusedIds(page)).toHaveLength(1);
    expect(await activeArea(page)).toBe('sidebar');
  });
});
