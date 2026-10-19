import { test, expect, openView, activeArea, isPhone, primaryPane, openBrowseFile } from './helpers/input';
import type { Page } from '@playwright/test';

// End-to-end keyboard chains for the interactions not covered elsewhere:
// search results, go-to-line, commit history, create forms, tag input, profile.

const openFile = async (page: Page) => {
  await page.locator('.tree-file').first().click();
  await page.waitForSelector('[data-line-id]');
};

test.describe('Go to file (Ctrl+G)', () => {
  test.beforeEach(async ({ page }) => {
    await openBrowseFile(page); // deep link: the file tree is a drawer on phones
  });

  test('type, Arrow to a result, Enter opens it and focus lands in the code', async ({ page }) => {
    await primaryPane(page).focus();
    await page.keyboard.press('Control+g');
    const dialog = page.getByRole('dialog', { name: 'Go to file' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('login');
    const results = dialog.locator('.file-search-item');
    await expect(results.first()).toBeVisible();
    expect(await results.count()).toBeGreaterThan(0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.file-header')).toContainText('login');
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });

  test('clicking a result opens the same file and lands in the code too', async ({ page }) => {
    await primaryPane(page).focus();
    await page.keyboard.press('Control+g');
    await page.keyboard.type('session');
    await page.locator('.file-search-modal .file-search-item').first().click();
    await expect(page.locator('.file-header')).toContainText('session');
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });
});

test.describe('Find in files (Ctrl+Shift+F)', () => {
  test('type, Enter on the first match opens the file at the line; focus lands in the code', async ({ page }) => {
    await openBrowseFile(page);
    await primaryPane(page).focus();
    await page.keyboard.press('Control+Shift+f');
    const dialog = page.getByRole('dialog', { name: 'Find in files' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('login line 7');
    await expect(dialog.locator('.content-search-item').first()).toBeVisible({ timeout: 8000 });
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.file-header')).toContainText('login');
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });
});

test.describe('Go to line (:)', () => {
  const setup = async (page: Page) => {
    await openView(page, '/#/browse/CLAUDE.md', '.tree-node');
    await page.waitForSelector('[data-line-id]');
    await page.locator('[data-nav-area="codeview"]').focus();
  };

  test('":" opens the bar, a line number + Enter focuses that line, focus stays in the code', async ({ page }) => {
    await setup(page);
    await page.keyboard.press(':');
    const input = page.locator('.in-file-search-bar .in-file-search-input').first();
    await expect(input).toBeFocused();
    await page.keyboard.type('50');
    await page.keyboard.press('Enter');
    await expect(input).toBeHidden();
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });

  test('Escape closes the bar and returns focus to the code', async ({ page }) => {
    await setup(page);
    await page.keyboard.press(':');
    await expect(page.locator('.in-file-search-bar .in-file-search-input').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.in-file-search-bar .in-file-search-input').first()).toBeHidden();
    await expect.poll(() => activeArea(page)).toBe('codeview');
  });
});

test.describe('Commit history panel', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(isPhone(page), 'the history panel lives in the file-panel drawer on phones');
    await openView(page, '/#/browse', '.tree-node');
    await openFile(page);
  });

  test('opens from the commit button with focus inside, rows are keyboard-operable, Escape returns focus', async ({ page }) => {
    const opener = page.locator('.commit-button');
    await opener.focus(); // arrange
    await page.keyboard.press('Enter');
    const panel = page.locator('.git-tree-panel-open');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('role', 'region');
    expect((await panel.getAttribute('aria-label')) ?? '').not.toBe('');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.git-tree-panel-open'))).toBe(true);

    const rows = panel.locator('.git-tree-row');
    expect(await rows.count()).toBeGreaterThan(2);
    await expect(rows.first()).toHaveAttribute('role', 'button');
    // Down/Up move focus between rows (roving)
    const idxOf = () => page.evaluate(() => Array.from(document.querySelectorAll('.git-tree-panel-open .git-tree-row')).indexOf(document.activeElement as Element));
    const start = await idxOf();
    expect(start).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('ArrowDown');
    expect(await idxOf()).toBe(Math.min(start + 1, (await rows.count()) - 1));
    await page.keyboard.press('ArrowUp');
    expect(await idxOf()).toBe(start);

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Enter on another commit selects it (same as a click)', async ({ page }) => {
    const opener = page.locator('.commit-button');
    const before = await opener.textContent();
    await opener.focus();
    await page.keyboard.press('Enter');
    const panel = page.locator('.git-tree-panel-open');
    await expect(panel).toBeVisible();
    // focus a non-current row by keyboard
    const rows = panel.locator('.git-tree-row');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('.git-tree-row'))).toBe(true);
    for (let i = 0; i < 6; i++) {
      if (!(await page.evaluate(() => document.activeElement?.classList.contains('git-tree-row-current')))) break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await expect(opener).not.toHaveText(before!);
    await expect(page.locator('.git-tree-panel-open')).toBeHidden(); // selecting closes the panel
  });
});

test.describe('New feature form', () => {
  test('opened from the toolbar pill: dialog, focus in, Escape keeps typed work behind a confirm, then focus returns', async ({ page }) => {
    await openView(page, '/#/features', '[data-nav-area="features-list"]');
    await page.keyboard.press('F6');
    const pill = page.locator('.feed-new-pill');
    await page.keyboard.press('Home');
    for (let i = 0; i < 80 && !(await pill.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowRight');
    await expect(pill).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /new feature/i });
    await expect(dialog).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);

    await page.keyboard.type('Draft title');
    await page.keyboard.press('Escape'); // dirty: must not silently discard
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('text=/discard/i').first()).toBeVisible();
    await dialog.getByRole('button', { name: /discard/i }).click();
    await expect(dialog).toBeHidden();
    await expect(pill).toBeFocused();
  });

  test('Escape on an untouched form closes it straight away and returns focus', async ({ page }) => {
    await openView(page, '/#/features', '[data-nav-area="features-list"]');
    const pill = page.locator('.feed-new-pill');
    await pill.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /new feature/i });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(pill).toBeFocused();
  });
});

test.describe('Tag input', () => {
  test('Enter adds a tag, Backspace on an empty field removes the last, Escape only closes suggestions', async ({ page }) => {
    // Tags are edited on the feature's page.
    await openView(page, '/#/features', '[data-nav-area="features-list"]');
    const id = await page.locator('[data-feature-id]').first().getAttribute('data-feature-id');
    await page.goto(`/#/feature/${id}`);
    const form = page.locator('.fd-tags');
    await expect(form).toBeVisible();
    const tagInput = form.locator('.tag-input-chip-row input').first();
    await tagInput.focus();
    await page.keyboard.type('keyboardtag');
    await page.keyboard.press('Enter');
    await expect(form.locator('.tag-input-chip', { hasText: 'keyboardtag' })).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(form.locator('.tag-input-chip', { hasText: 'keyboardtag' })).toHaveCount(0);
    await page.keyboard.type('x');
    await page.keyboard.press('Escape'); // closes the suggestion list only
    await expect(form).toBeVisible();
  });
});

test.describe('Profile form (radio groups)', () => {
  test('a radio group is one Tab stop; arrows move and select; Space selects', async ({ page }) => {
    await openView(page, '/#/profile', '.profile-title');
    const group = page.locator('.profile-choices-radio').first();
    const radios = group.locator('[role="radio"]');
    expect(await radios.count()).toBeGreaterThan(2);
    // roving tabindex: exactly one tabbable radio per group
    expect(await group.locator('[role="radio"][tabindex="0"]').count()).toBe(1);
    expect(await group.locator('[role="radio"][tabindex="-1"]').count()).toBe((await radios.count()) - 1);

    await group.locator('[role="radio"][tabindex="0"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(2)).toHaveAttribute('aria-checked', 'true');
    await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('ArrowLeft');
    await expect(radios.nth(1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(radios.first()).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('End');
    await expect(radios.last()).toHaveAttribute('aria-checked', 'true');
  });

  test('mouse then keyboard: clicking a radio makes it the group stop; arrows continue from it', async ({ page }) => {
    await openView(page, '/#/profile', '.profile-title');
    const group = page.locator('.profile-choices-radio').first();
    const radios = group.locator('[role="radio"]');
    await radios.nth(2).click();
    await expect(radios.nth(2)).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('ArrowLeft');
    await expect(radios.nth(1)).toBeFocused();
  });
});
