import {
  test, expect, openView, activeArea, navFocusedIds, focusedIndex,
  matchesFocusVisible, lastInput, parkMouse,
} from './helpers/input';

// Cases M7, M8, M10-M15, M17, M18 from plan/keyboard-focus-tests.md.

const FINDING = '[data-finding-id]';
const LIST = '[data-nav-area="findings-list"]';
const AREA_BY_KEY: Record<string, string> = {
  '1': 'filetree', '2': 'delta-header', '3': 'findings-filter', '4': 'features-tabs',
};
const TAB_LABEL: Record<string, string> = {
  '1': 'Browse', '2': 'Changes', '3': 'Findings', '4': 'Features',
};

test.describe('M7. Pending tab-switch focus must not steal focus later', () => {
  // With slow APIs the target area is not mounted when the key is pressed, so
  // App waits for it (MutationObserver). If the user acts in the meantime the
  // request is stale and must be dropped.
  for (const key of ['2', '3', '4']) {
    test(`key ${key}: opening quick-add before the area mounts keeps focus in the popover`, async ({ page }) => {
      await openView(page, '/#/overview', '.tab-bar');
      await page.route('**/api/**', async (route) => {
        await new Promise(r => setTimeout(r, 1500));
        await route.continue();
      });

      await page.keyboard.press(key);
      await expect(page.locator(`[data-nav-area="${AREA_BY_KEY[key]}"]`)).toHaveCount(0);
      await page.locator('.quick-add-comment').click();
      await expect(page.locator('.quick-add-popover')).toBeVisible();

      // Let the slow view finish mounting.
      await expect(page.locator(`[data-nav-area="${AREA_BY_KEY[key]}"]`)).toBeAttached({ timeout: 8000 });
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => !!document.activeElement?.closest('.quick-add-popover'))).toBe(true);
    });
  }

  test('without interference the late-mounting area still receives focus', async ({ page }) => {
    await openView(page, '/#/overview', '.tab-bar');
    await page.route('**/api/**', async (route) => {
      await new Promise(r => setTimeout(r, 800));
      await route.continue();
    });
    await page.keyboard.press('3');
    await expect.poll(() => activeArea(page), { timeout: 8000 }).toBe('findings-filter');
  });
});

test.describe('M8. Number keys and tab clicks land on the same area', () => {
  for (const key of ['1', '2', '3', '4']) {
    test(`key ${key} and clicking ${TAB_LABEL[key]} focus ${AREA_BY_KEY[key]}`, async ({ page }) => {
      await openView(page, '/#/overview', '.tab-bar');

      await page.keyboard.press(key);
      await expect.poll(() => activeArea(page)).toBe(AREA_BY_KEY[key]);
      const viaKey = await matchesFocusVisible(page.locator(`[data-nav-area="${AREA_BY_KEY[key]}"]`));

      await page.keyboard.press('0'); // back to overview
      await expect(page.locator('.ovp-project-title')).toBeVisible();
      await page.locator('.tab-bar-tab', { hasText: TAB_LABEL[key] }).click();
      expect(await lastInput(page)).toBe('pointer');
      await expect.poll(() => activeArea(page)).toBe(AREA_BY_KEY[key]);

      // Keyboard-initiated focus shows the ring; the area is the same either way.
      expect(viaKey).toBe(true);
    });
  }
});

test.describe('M10-M12, M18. Findings list: hover, wheel, Escape', () => {
  test.beforeEach(async ({ page }) => {
    await openView(page, '/#/findings', LIST);
    await expect(page.locator(FINDING).nth(5)).toBeVisible();
  });

  test('M10 hovering a different card does not add a second nav-focused card', async ({ page }) => {
    await page.locator(LIST).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(1);

    await page.locator(FINDING).nth(4).hover();
    await expect.poll(() => navFocusedIds(page)).toHaveLength(1);
    expect(await focusedIndex(page, FINDING)).toBe(1);

    const [focusedShadow, hoveredShadow] = await Promise.all([
      page.locator(FINDING).nth(1).evaluate(el => getComputedStyle(el).boxShadow),
      page.locator(FINDING).nth(4).evaluate(el => getComputedStyle(el).boxShadow),
    ]);
    expect(focusedShadow).not.toBe('none');
    expect(hoveredShadow).toBe('none');
    await parkMouse(page);
  });

  test('M11 wheel scrolling keeps the keyboard anchor; ArrowDown still advances', async ({ page }) => {
    await page.locator(LIST).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(1);

    await page.locator(LIST).hover();
    await page.mouse.wheel(0, 400);
    await page.mouse.wheel(0, -400);
    expect(await focusedIndex(page, FINDING)).toBe(1);

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(2);
  });

  test('M12 Escape in the reply box returns to the list, anchor kept; a click then drops it', async ({ page }) => {
    await page.locator(LIST).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter'); // cards start expanded: Enter focuses the reply box
    const reply = page.locator('[data-nav-focused="true"] textarea').first();
    await expect(reply).toBeFocused();
    await page.keyboard.type('draft');

    await page.keyboard.press('Escape');
    expect(await activeArea(page)).toBe('findings-list');
    await expect.poll(() => navFocusedIds(page)).toHaveLength(1);

    await page.locator('[data-nav-area="findings-filter"] h2').click();
    await expect.poll(() => navFocusedIds(page)).toHaveLength(0);
  });

  test('M18 Escape clears the item but keeps the area; ArrowDown resumes at item 0', async ({ page }) => {
    await page.locator(LIST).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect.poll(() => navFocusedIds(page)).toHaveLength(0);
    expect(await activeArea(page)).toBe('findings-list');

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page, FINDING)).toBe(0);
  });
});

test.describe('M13. Typing in a search box', () => {
  test('number keys are text, not view switches; Tab leaves without area cycling', async ({ page }) => {
    await openView(page, '/#/findings', LIST);
    const input = page.locator('[data-nav-area="findings-filter"] input').first();
    await input.click(); // mouse into the field
    await page.keyboard.type('3');
    await expect(input).toHaveValue('3');
    expect(page.url()).toContain('#/findings');
    expect(await activeArea(page)).toBe('findings-filter');

    await page.keyboard.press('Tab');
    await expect(input).not.toBeFocused();
    expect(page.url()).toContain('#/findings');
  });
});

test.describe('M14. In-file search bar', () => {
  test('mouse-opened bar keeps Tab inside; Escape closes it and returns focus to the code', async ({ page }) => {
    await openView(page, '/#/browse', '.tree-node');
    await page.locator('.tree-file').first().click();
    await page.waitForSelector('[data-line-id]');
    await page.locator('[data-nav-area="codeview"] .diff-view').click();

    await page.keyboard.press('Control+f');
    const bar = page.locator('.in-file-search-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('input')).toBeFocused();

    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.in-file-search-bar'))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.in-file-search-bar'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden();
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });
});

test.describe('M15. Quick-add draft: Escape and outside click behave the same', () => {
  async function openDirtyDraft(page: import('@playwright/test').Page) {
    await openView(page, '/#/findings', LIST);
    await page.locator('.quick-add-comment').click();
    const field = page.locator('.quick-add-popover textarea').first();
    await expect(field).toBeFocused();
    await page.keyboard.type('unsaved draft');
  }

  test('Escape on a dirty draft asks before discarding', async ({ page }) => {
    await openDirtyDraft(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.quick-add-confirm-discard')).toBeVisible();
    await page.locator('.quick-add-confirm-discard button', { hasText: 'Discard' }).click();
    await expect(page.locator('.quick-add-popover')).toBeHidden();
    // Focus goes back to the control that opened it, not <body>.
    await expect(page.locator('.quick-add-comment')).toBeFocused();
  });

  test('clicking outside a dirty draft asks before discarding, same as Escape', async ({ page }) => {
    await openDirtyDraft(page);
    await page.mouse.click(5, 300);
    await expect(page.locator('.quick-add-confirm-discard')).toBeVisible();
    await page.locator('.quick-add-confirm-discard button', { hasText: 'Keep editing' }).click();
    await expect(page.locator('.quick-add-confirm-discard')).toBeHidden();
    await expect(page.locator('.quick-add-popover')).toBeVisible();
  });
});

test.describe('M17. File tree: click then arrows', () => {
  test('keyboard anchor follows a clicked folder', async ({ page }) => {
    await openView(page, '/#/browse', '.tree-node');
    await page.locator('[data-nav-area="filetree"]').focus();
    await page.keyboard.press('ArrowDown');

    const dirs = page.locator('.tree-dir');
    await dirs.nth(1).click();
    await expect(page.locator('.tree-focused')).toHaveCount(1);
    const clickedName = await dirs.nth(1).locator('.tree-name').textContent();
    expect(await page.locator('.tree-focused .tree-name').textContent()).toBe(clickedName);

    await page.keyboard.press('ArrowDown');
    const after = await page.locator('.tree-focused .tree-name').textContent();
    expect(after).not.toBe(clickedName);
  });
});

test.describe('M16. Resize handles are keyboard-accessible', () => {
  const width = (page: import('@playwright/test').Page, sel: string) =>
    page.locator(sel).evaluate(el => Math.round(el.getBoundingClientRect().width));

  test.beforeEach(async ({ page }) => {
    await openView(page, '/#/browse', '.tree-node');
    await page.locator('.tree-file').first().click();
    await page.waitForSelector('[data-line-id]');
  });

  test('handles are ARIA separators that report the pane width', async ({ page }) => {
    for (const [sel, label] of [['.left-panel-resize-handle', 'Resize file panel'], ['.sidebar-resize-handle', 'Resize sidebar']] as const) {
      const h = page.locator(sel);
      await expect(h).toHaveAttribute('role', 'separator');
      await expect(h).toHaveAttribute('aria-orientation', 'vertical');
      await expect(h).toHaveAttribute('aria-label', label);
      expect(Number(await h.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    }
    const w = await width(page, '.left-panel');
    expect(Number(await page.locator('.left-panel-resize-handle').getAttribute('aria-valuenow'))).toBe(w);
  });

  test('click a handle (mouse), then arrows / Home resize it (keyboard)', async ({ page }) => {
    const handle = page.locator('.left-panel-resize-handle');
    const before = await width(page, '.left-panel');
    await handle.click(); // press + release without moving: focuses, doesn't resize
    await expect(handle).toBeFocused();
    expect(await width(page, '.left-panel')).toBe(before);

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => width(page, '.left-panel')).toBe(before + 24);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => width(page, '.left-panel')).toBe(before);
    await page.keyboard.press('Home');
    await expect.poll(() => width(page, '.left-panel')).toBe(180);
    await page.keyboard.press('End');
    await expect.poll(() => width(page, '.left-panel')).toBe(500);
  });

  test('Alt+Shift+Arrow resizes the pane of the focused area, not history', async ({ page }) => {
    const hashBefore = await page.evaluate(() => location.hash);
    await page.locator('[data-nav-area="filetree"]').focus(); // arrange
    const before = await width(page, '.left-panel');
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => width(page, '.left-panel')).toBe(before + 24);
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await expect.poll(() => width(page, '.left-panel')).toBe(before);
    expect(await page.evaluate(() => location.hash)).toBe(hashBefore);
  });

  test('right sidebar grows with Alt+Shift+ArrowLeft', async ({ page }) => {
    const sidebar = page.locator('[data-nav-area="sidebar"]');
    if (!await sidebar.isVisible()) test.skip(true, 'sidebar not visible in this state');
    await sidebar.focus();
    const before = await width(page, '[data-nav-area="sidebar"]');
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await expect.poll(() => width(page, '[data-nav-area="sidebar"]')).toBe(before + 24);
  });
});
