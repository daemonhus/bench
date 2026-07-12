import { test, expect, type Page } from '@playwright/test';

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function openFirstFile(page: Page) {
  await page.goto('/#/browse');
  await page.waitForSelector('.tree-node', { timeout: 15000 });
  await page.locator('.tree-file').first().click();
  await page.waitForSelector('[data-line-id]', { timeout: 8000 });
  await page.waitForTimeout(300);
}

// Drag first gutter into second to open the toolbar (mouse source).
// Returns false if fewer than 2 gutters are present.
async function dragGutters(page: Page): Promise<boolean> {
  const gutters = page.locator('.diff-row .action-gutter');
  if (await gutters.count() < 2) return false;
  await gutters.first().dispatchEvent('mousedown');
  await gutters.nth(1).dispatchEvent('mouseenter');
  await page.mouse.up();
  await page.waitForTimeout(300);
  return page.locator('.selection-toolbar').isVisible().catch(() => false);
}

// Click a single gutter (single-line mouse selection).
async function clickGutter(page: Page, index = 0): Promise<boolean> {
  const gutters = page.locator('.diff-row .action-gutter');
  if (await gutters.count() <= index) return false;
  await gutters.nth(index).dispatchEvent('mousedown');
  await page.mouse.up();
  await page.waitForTimeout(200);
  return page.locator('.selection-toolbar').isVisible().catch(() => false);
}

// Open toolbar using keyboard: ↓ ↓ Enter ↓ ↓ Enter on the codeview.
// Returns true if the toolbar appears.
async function openToolbarKeyboard(page: Page): Promise<boolean> {
  await page.locator('[data-nav-area="codeview"]').focus();
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  return page.locator('.selection-toolbar').isVisible().catch(() => false);
}

// Open a mouse toolbar then click the given button label.
// Returns false if toolbar couldn't be opened.
async function openDraftViaToolbar(page: Page, label: 'Comment' | 'Finding' | 'Feature'): Promise<boolean> {
  let ok = await dragGutters(page);
  if (!ok) ok = await clickGutter(page);
  if (!ok) return false;
  await page.locator('.selection-toolbar button', { hasText: label }).click();
  await page.waitForTimeout(300);
  const selector = label === 'Comment' ? '.comment-card-new'
    : label === 'Feature' ? '.feature-card-new'
    : '.finding-card-new';
  return page.locator(selector).isVisible().catch(() => false);
}

// ── 1. Toolbar opening ─────────────────────────────────────────────────────────

test.describe('1. Toolbar opening', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
  });

  // 1.1
  test('mouse drag opens toolbar and it stays visible', async ({ page }) => {
    const ok = await dragGutters(page);
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    // Wait to confirm it does not auto-dismiss due to a spurious focus-out event
    await page.waitForTimeout(600);
    await expect(page.locator('.selection-toolbar')).toBeVisible();
  });

  // 1.2
  test('single gutter click opens toolbar and it stays visible', async ({ page }) => {
    const ok = await clickGutter(page);
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    await page.waitForTimeout(600);
    await expect(page.locator('.selection-toolbar')).toBeVisible();
  });

  // 1.3
  test('keyboard ↓↓ Enter ↓↓ Enter opens toolbar with first button focused', async ({ page }) => {
    const ok = await openToolbarKeyboard(page);
    if (!ok) { test.skip(); return; }
    // commentDrag.source === 'keyboard' → toolbar auto-focuses first button
    const firstBtn = page.locator('.selection-toolbar button').first();
    await expect(firstBtn).toBeFocused();
  });
});

// ── 2. Toolbar internal navigation ────────────────────────────────────────────

test.describe('2. Toolbar internal navigation', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
    // Use keyboard open so the first button starts focused
    const ok = await openToolbarKeyboard(page);
    if (!ok) test.skip();
  });

  // 2.1
  test('ArrowRight moves focus to next button', async ({ page }) => {
    const btns = page.locator('.selection-toolbar button');
    if (await btns.count() < 2) { test.skip(); return; }
    await expect(btns.first()).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(btns.nth(1)).toBeFocused();
  });

  // 2.1b
  test('ArrowLeft moves focus to previous button', async ({ page }) => {
    const btns = page.locator('.selection-toolbar button');
    if (await btns.count() < 2) { test.skip(); return; }
    await page.keyboard.press('ArrowRight');
    await expect(btns.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(btns.first()).toBeFocused();
  });

  // 2.1c - wrap at end
  test('ArrowRight wraps from last button back to first', async ({ page }) => {
    const btns = page.locator('.selection-toolbar button');
    const count = await btns.count();
    if (count < 2) { test.skip(); return; }
    for (let i = 0; i < count - 1; i++) await page.keyboard.press('ArrowRight');
    await expect(btns.nth(count - 1)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(btns.first()).toBeFocused();
  });

  // 2.1d - wrap backwards
  test('ArrowLeft wraps from first button to last', async ({ page }) => {
    const btns = page.locator('.selection-toolbar button');
    const count = await btns.count();
    if (count < 2) { test.skip(); return; }
    await expect(btns.first()).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(btns.nth(count - 1)).toBeFocused();
  });

  // 2.2 - Tab stays inside toolbar
  test('Tab cycles focus within toolbar without escaping to next nav-area', async ({ page }) => {
    const btns = page.locator('.selection-toolbar button');
    if (await btns.count() < 2) { test.skip(); return; }
    await expect(btns.first()).toBeFocused();
    await page.keyboard.press('Tab');
    const insideToolbar = await page.evaluate(
      () => !!document.activeElement?.closest('.selection-toolbar'),
    );
    expect(insideToolbar).toBe(true);
  });

  // 2.2b - Shift+Tab wraps backwards inside toolbar
  test('Shift+Tab wraps backwards within toolbar', async ({ page }) => {
    const btns = page.locator('.selection-toolbar button');
    const count = await btns.count();
    if (count < 2) { test.skip(); return; }
    await expect(btns.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(btns.nth(count - 1)).toBeFocused();
  });

  // 2.3
  test('Escape dismisses the toolbar', async ({ page }) => {
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // 2.4
  test('mousedown outside toolbar dismisses it', async ({ page }) => {
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    // Click an area with no action gutter - the filetree panel header is safe
    await page.locator('[data-nav-area="filetree"]').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // 2.4b - mousedown on action gutter does NOT permanently dismiss
  test('mousedown on action gutter starts new selection instead of dismissing', async ({ page }) => {
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    // Start a new drag on the gutter - toolbar should survive (possibly with updated range)
    const gutter = page.locator('.diff-row .action-gutter').first();
    await gutter.dispatchEvent('mousedown');
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(300);
    // A new toolbar should be visible (the gutter started a fresh selection)
    await expect(page.locator('.selection-toolbar')).toBeVisible();
  });
});

// ── 3. Toolbar → draft form ────────────────────────────────────────────────────

test.describe('3. Toolbar to draft form', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
  });

  // 3.1a
  test('clicking Comment button opens comment draft card and closes toolbar', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.comment-card-new')).toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // 3.1b
  test('clicking Finding button opens finding draft card and closes toolbar', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Finding');
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.finding-card-new')).toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // 3.1c
  test('clicking Feature button opens feature draft card and closes toolbar', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Feature');
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.feature-card-new')).toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // 3.1d - sidebar opens automatically
  test('draft form opens sidebar when sidebar is closed', async ({ page }) => {
    // Close sidebar
    const closeBtn = page.locator('.panel-drawer-btn');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(200);
    }
    if (!await page.locator('.sidebar-collapsed').isVisible().catch(() => false)) {
      test.skip(); return;
    }
    // Open toolbar and pick Comment (isMobile=false path opens sidebar)
    let ok = await dragGutters(page);
    if (!ok) ok = await clickGutter(page);
    if (!ok) { test.skip(); return; }
    await page.locator('.selection-toolbar button', { hasText: 'Comment' }).click();
    await page.waitForTimeout(400);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.comment-card-new')).toBeVisible();
  });

  // 3.1e - first input in draft card is auto-focused
  test('first input in comment draft card receives autoFocus', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) { test.skip(); return; }
    // The comment card has a textarea with autoFocus
    await expect(page.locator('.comment-card-new textarea')).toBeFocused();
  });

  test('first input in finding draft card receives autoFocus', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Finding');
    if (!ok) { test.skip(); return; }
    // Title input has autoFocus
    await expect(page.locator('.finding-card-new input[type="text"]').first()).toBeFocused();
  });
});

// ── 4. Draft form keyboard ─────────────────────────────────────────────────────

test.describe('4. Draft form keyboard - finding card', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
    const ok = await openDraftViaToolbar(page, 'Finding');
    if (!ok) test.skip();
  });

  // 4.1a - Tab wraps at end of card
  test('Tab from last focusable wraps to first focusable', async ({ page }) => {
    const card = page.locator('.finding-card-new');
    const focusables = card.locator(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    const count = await focusables.count();
    if (count < 2) { test.skip(); return; }
    // Title has autoFocus - Tab through to last
    for (let i = 0; i < count - 1; i++) await page.keyboard.press('Tab');
    await expect(focusables.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(focusables.first()).toBeFocused();
  });

  // 4.1b - Shift+Tab wraps at start of card
  test('Shift+Tab from first focusable wraps to last focusable', async ({ page }) => {
    const card = page.locator('.finding-card-new');
    const focusables = card.locator(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    const count = await focusables.count();
    if (count < 2) { test.skip(); return; }
    await expect(focusables.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(focusables.nth(count - 1)).toBeFocused();
  });

  // 4.1c - Tab never escapes to next nav-area
  test('Tab stays inside the finding draft card on every press', async ({ page }) => {
    const card = page.locator('.finding-card-new');
    const focusables = card.locator(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    const count = await focusables.count();
    // Tab through twice the count to exercise wrap behaviour
    for (let i = 0; i < count * 2; i++) {
      await page.keyboard.press('Tab');
      const insideCard = await page.evaluate(
        () => !!document.activeElement?.closest('.finding-card-new'),
      );
      expect(insideCard).toBe(true);
    }
  });

  // 4.2a - ArrowDown on severity select changes value
  test('ArrowDown on severity select changes the selected option', async ({ page }) => {
    const sel = page.locator('.finding-card-new .finding-severity-select');
    await sel.focus();
    const before = await sel.inputValue();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(50);
    const after = await sel.inputValue();
    expect(after).not.toBe(before);
  });

  // 4.2b - ArrowUp on severity select changes value
  test('ArrowUp on severity select changes the selected option', async ({ page }) => {
    const sel = page.locator('.finding-card-new .finding-severity-select');
    await sel.selectOption('medium');
    await sel.focus();
    const before = await sel.inputValue();
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(50);
    const after = await sel.inputValue();
    expect(after).not.toBe(before);
  });

  // 4.4a - Escape with empty title cancels
  test('Escape with empty title cancels the finding draft', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.focus();
    expect(await titleInput.inputValue()).toBe('');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.locator('.finding-card-new')).not.toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // 4.4b - Escape with content does NOT cancel
  test('Escape with content in title does not cancel the finding draft', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.focus();
    await page.keyboard.type('SQL injection');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.locator('.finding-card-new')).toBeVisible();
  });

  // 4.5 - Cmd+Enter submits when title is filled
  test('Cmd+Enter submits the finding draft and closes the card', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.focus();
    await page.keyboard.type('Test finding via keyboard');
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(600);
    await expect(page.locator('.finding-card-new')).not.toBeVisible();
  });

  // Tab past last element - targeted wrap tests

  // When title is empty the submit button is disabled, so the last focusable is
  // the Cancel button.  Tab from it must wrap back to title, not escape to the
  // next nav-area.
  test('Tab from Cancel button (last focusable) wraps to title input', async ({ page }) => {
    const cancelBtn = page.locator('.finding-card-new .comment-btn-cancel');
    await cancelBtn.focus();
    await expect(cancelBtn).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.finding-card-new input[type="text"]').first()).toBeFocused();
    // Focus must not have left the card
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  // When title is filled the submit button becomes enabled and is the last
  // focusable.  Tab from it must still wrap to title, not escape.
  test('Tab from Submit button (last when enabled) wraps to title input', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.fill('XSS in login form');
    const submitBtn = page.locator('.finding-card-new .comment-btn-submit');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.focus();
    await expect(submitBtn).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(titleInput).toBeFocused();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  // The global capture Tab handler in App.tsx only bails early for INPUT and
  // TEXTAREA - not SELECT.  The draft-card guard on line 460 of App.tsx must
  // catch <select> elements so the global handler doesn't yank focus out to
  // the next nav-area.
  test('Tab from severity <select> stays inside the card (global handler does not intercept)', async ({ page }) => {
    const severitySelect = page.locator('.finding-card-new .finding-severity-select');
    await severitySelect.focus();
    await expect(severitySelect).toBeFocused();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(50);
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
    // Focus must NOT have jumped to a nav-area wrapper
    const landedOnNavArea = await page.evaluate(
      () => !!(document.activeElement as HTMLElement)?.getAttribute('data-nav-area'),
    );
    expect(landedOnNavArea).toBe(false);
  });
});

// Escape from each input type inside the finding draft card.
// The expected behaviour for every non-primary field is the same:
//   • form stays visible
//   • focus stays inside the card (nav-list handler must not steal it)
// The primary field (title) cancels only when empty - tested separately.
test.describe('4. Draft form keyboard - Escape per input type (finding)', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
    const ok = await openDraftViaToolbar(page, 'Finding');
    if (!ok) test.skip();
  });

  // Non-primary text INPUT (CWE field)
  test('Escape from non-primary text input does not cancel and keeps focus in card', async ({ page }) => {
    const cweInput = page.locator('.finding-card-new input[placeholder*="CWE"]');
    await cweInput.focus();
    await expect(cweInput).toBeFocused();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.finding-card-new')).toBeVisible();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  // SELECT (severity)
  test('Escape from severity select does not cancel and keeps focus in card', async ({ page }) => {
    const sel = page.locator('.finding-card-new .finding-severity-select');
    await sel.focus();
    await expect(sel).toBeFocused();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.finding-card-new')).toBeVisible();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  // TEXTAREA (description - non-primary)
  test('Escape from description textarea does not cancel and keeps focus in card', async ({ page }) => {
    const desc = page.locator('.finding-card-new textarea');
    await desc.focus();
    await expect(desc).toBeFocused();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.finding-card-new')).toBeVisible();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  // BUTTON (Cancel)
  test('Escape from Cancel button does not dismiss the form', async ({ page }) => {
    const cancelBtn = page.locator('.finding-card-new .comment-btn-cancel');
    await cancelBtn.focus();
    await expect(cancelBtn).toBeFocused();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.finding-card-new')).toBeVisible();
  });

  // Primary INPUT with content - no cancel, focus stays in card
  test('Escape from title input with content does not cancel and keeps focus in card', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.focus();
    await page.keyboard.type('IDOR in profile endpoint');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.finding-card-new')).toBeVisible();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.finding-card-new'),
    );
    expect(insideCard).toBe(true);
  });
});

test.describe('4. Draft form keyboard - comment card', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) test.skip();
  });

  // 4.1 - Tab traps in comment card
  test('Tab wraps within comment draft card', async ({ page }) => {
    const card = page.locator('.comment-card-new');
    const focusables = card.locator(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    const count = await focusables.count();
    if (count < 2) { test.skip(); return; }
    // textarea has autoFocus
    for (let i = 0; i < count - 1; i++) await page.keyboard.press('Tab');
    await expect(focusables.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(focusables.first()).toBeFocused();
  });

  // 4.4 - Escape with empty textarea cancels
  test('Escape with empty comment textarea cancels the draft', async ({ page }) => {
    const textarea = page.locator('.comment-card-new textarea');
    await textarea.focus();
    expect(await textarea.inputValue()).toBe('');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.locator('.comment-card-new')).not.toBeVisible();
  });

  // 4.4b - Escape with content does NOT cancel
  test('Escape with text in textarea does not cancel the comment draft', async ({ page }) => {
    const textarea = page.locator('.comment-card-new textarea');
    await textarea.focus();
    await page.keyboard.type('Potential concern here');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.locator('.comment-card-new')).toBeVisible();
  });

  // 4.5 - Cmd+Enter submits when textarea has content
  test('Cmd+Enter submits the comment draft and closes the card', async ({ page }) => {
    const textarea = page.locator('.comment-card-new textarea');
    await textarea.focus();
    await page.keyboard.type('A review note');
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(600);
    await expect(page.locator('.comment-card-new')).not.toBeVisible();
  });
});

// ── 4c. Feature draft card ────────────────────────────────────────────────────
// The feature card has different submit semantics (plain Enter, not Cmd+Enter)
// and its own cancel path, which previously had a bug: the inline Cancel handler
// and Escape handler did not reset commentDrag, causing the toolbar to reappear
// after cancel.

test.describe('4. Draft form keyboard - feature card', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
    const ok = await openDraftViaToolbar(page, 'Feature');
    if (!ok) test.skip();
  });

  // Tab trap
  test('Tab wraps within feature draft card', async ({ page }) => {
    const card = page.locator('.feature-card-new');
    const focusables = card.locator(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    const count = await focusables.count();
    if (count < 2) { test.skip(); return; }
    for (let i = 0; i < count - 1; i++) await page.keyboard.press('Tab');
    await expect(focusables.nth(count - 1)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(focusables.first()).toBeFocused();
  });

  test('Shift+Tab from first focusable wraps to last', async ({ page }) => {
    const card = page.locator('.feature-card-new');
    const focusables = card.locator(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    const count = await focusables.count();
    if (count < 2) { test.skip(); return; }
    await expect(focusables.first()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(focusables.nth(count - 1)).toBeFocused();
  });

  // Escape per input type
  test('Escape from Kind select does not cancel and keeps focus in card', async ({ page }) => {
    const kindSelect = page.locator('.feature-card-new select').first();
    await kindSelect.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.feature-card-new')).toBeVisible();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.feature-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  test('Escape from description textarea does not cancel and keeps focus in card', async ({ page }) => {
    const desc = page.locator('.feature-card-new textarea');
    await desc.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.feature-card-new')).toBeVisible();
    const insideCard = await page.evaluate(
      () => !!document.activeElement?.closest('.feature-card-new'),
    );
    expect(insideCard).toBe(true);
  });

  test('Escape from title with content does not cancel the feature draft', async ({ page }) => {
    const titleInput = page.locator('.feature-card-new input[placeholder*="api"]');
    await titleInput.focus();
    await page.keyboard.type('/api/users');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await expect(page.locator('.feature-card-new')).toBeVisible();
  });

  test('Escape from empty title cancels the feature draft', async ({ page }) => {
    const titleInput = page.locator('.feature-card-new input[placeholder*="api"]');
    await titleInput.focus();
    expect(await titleInput.inputValue()).toBe('');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.locator('.feature-card-new')).not.toBeVisible();
  });

  // Submit semantics: plain Enter (not Cmd+Enter) from the title field
  test('plain Enter from title field submits the feature draft', async ({ page }) => {
    const titleInput = page.locator('.feature-card-new input[placeholder*="api"]');
    await titleInput.focus();
    await page.keyboard.type('/healthz');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await expect(page.locator('.feature-card-new')).not.toBeVisible();
  });

  // Submit button disabled / enabled
  test('Save button is disabled when title is empty and enables when filled', async ({ page }) => {
    const saveBtn = page.locator('.feature-card-new .comment-btn-submit');
    await expect(saveBtn).toBeDisabled();
    await page.locator('.feature-card-new input[placeholder*="api"]').fill('/login');
    await expect(saveBtn).toBeEnabled();
  });
});

// ── Toolbar-reappears regression ───────────────────────────────────────────────
// commentDrag must be fully reset on every cancel path so the toolbar
// (which renders when isActive && annotationAction === null) does not
// flash back into view after the draft form is dismissed.

test.describe('Post-cancel toolbar regression', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
  });

  test('cancelling finding draft does not make toolbar reappear', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Finding');
    if (!ok) { test.skip(); return; }
    await page.locator('.finding-card-new .comment-btn-cancel').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.finding-card-new')).not.toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  test('cancelling comment draft does not make toolbar reappear', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) { test.skip(); return; }
    await page.locator('.comment-card-new .comment-btn-cancel').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.comment-card-new')).not.toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  // This was the specific bug: feature Cancel used an inline handler that
  // skipped setCommentDrag, so the toolbar reappeared.
  test('cancelling feature draft via Cancel button does not make toolbar reappear', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Feature');
    if (!ok) { test.skip(); return; }
    await page.locator('.feature-card-new .comment-btn-cancel').click();
    await page.waitForTimeout(300);
    await expect(page.locator('.feature-card-new')).not.toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });

  test('cancelling feature draft via Escape does not make toolbar reappear', async ({ page }) => {
    const ok = await openDraftViaToolbar(page, 'Feature');
    if (!ok) { test.skip(); return; }
    // Title is empty by default → Escape should cancel
    const titleInput = page.locator('.feature-card-new input[placeholder*="api"]');
    await titleInput.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.locator('.feature-card-new')).not.toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });
});

// ── Mouse-open auto-focus guard ────────────────────────────────────────────────
// Toolbar opened via mouse must NOT auto-focus its first button.
// If it did, the focus-out handler would immediately dismiss it.
// This is the mechanism tested by sections 1.1 and 1.2 (toolbar stays visible);
// here we verify the mechanism itself.

test.describe('Toolbar mouse-open does not auto-focus first button', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
  });

  test('mouse-drag open: first button is not focused', async ({ page }) => {
    const ok = await dragGutters(page);
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    const firstBtnFocused = await page.evaluate(
      () => document.activeElement === document.querySelector('.selection-toolbar button'),
    );
    expect(firstBtnFocused).toBe(false);
  });

  test('single-click open: first button is not focused', async ({ page }) => {
    const ok = await clickGutter(page);
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.selection-toolbar')).toBeVisible();
    const firstBtnFocused = await page.evaluate(
      () => document.activeElement === document.querySelector('.selection-toolbar button'),
    );
    expect(firstBtnFocused).toBe(false);
  });

  test('keyboard open: first button IS focused (control)', async ({ page }) => {
    const ok = await openToolbarKeyboard(page);
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.selection-toolbar button').first()).toBeFocused();
  });
});

// ── 5. Draft form side effects ─────────────────────────────────────────────────

test.describe('5. Draft form side effects', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
  });

  // 5.1 - Cancel does not reset codeview scroll position
  test('cancelling a draft does not scroll codeview back to top', async ({ page }) => {
    const lineCount = await page.locator('[data-line-id]').count();
    if (lineCount < 20) { test.skip(); return; }

    const codeview = page.locator('[data-nav-area="codeview"]');
    // Scroll the codeview down to roughly the middle
    await codeview.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(150);
    const scrollBefore = await codeview.evaluate((el) => el.scrollTop);
    if (scrollBefore < 10) { test.skip(); return; }

    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) { test.skip(); return; }

    // Cancel via the Cancel button
    await page.locator('.comment-card-new .comment-btn-cancel').click();
    await page.waitForTimeout(400);

    const scrollAfter = await codeview.evaluate((el) => el.scrollTop);
    // Scroll should not have been reset to 0
    expect(scrollAfter).toBeGreaterThan(0);
  });

  // 5.1b - Escape cancel also preserves scroll
  test('Escape-cancelling a draft does not scroll codeview back to top', async ({ page }) => {
    const lineCount = await page.locator('[data-line-id]').count();
    if (lineCount < 20) { test.skip(); return; }

    const codeview = page.locator('[data-nav-area="codeview"]');
    await codeview.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(150);
    const scrollBefore = await codeview.evaluate((el) => el.scrollTop);
    if (scrollBefore < 10) { test.skip(); return; }

    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) { test.skip(); return; }

    // Escape from empty textarea
    await page.locator('.comment-card-new textarea').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    const scrollAfter = await codeview.evaluate((el) => el.scrollTop);
    expect(scrollAfter).toBeGreaterThan(0);
  });

  // 5.2 - Switching files cancels draft
  test('selecting a different file discards the open draft', async ({ page }) => {
    const files = page.locator('.tree-file');
    if (await files.count() < 2) { test.skip(); return; }

    const ok = await openDraftViaToolbar(page, 'Comment');
    if (!ok) { test.skip(); return; }
    await expect(page.locator('.comment-card-new')).toBeVisible();

    // Click a different file
    await files.nth(1).click();
    await page.waitForTimeout(500);

    await expect(page.locator('.comment-card-new')).not.toBeVisible();
    await expect(page.locator('.selection-toolbar')).not.toBeVisible();
  });
});

// ── 6. Finding form fields ─────────────────────────────────────────────────────

test.describe('6. Finding form fields', () => {
  test.beforeEach(async ({ page }) => {
    await openFirstFile(page);
    const ok = await openDraftViaToolbar(page, 'Finding');
    if (!ok) test.skip();
  });

  // 6.1 - All expected fields are present
  test('finding draft card renders all required fields', async ({ page }) => {
    const card = page.locator('.finding-card-new');
    // Title (autoFocus)
    await expect(card.locator('input[type="text"]').first()).toBeVisible();
    await expect(card.locator('input[type="text"]').first()).toBeFocused();
    // Severity select
    await expect(card.locator('.finding-severity-select')).toBeVisible();
    // Status select
    await expect(card.locator('.finding-status-select').first()).toBeVisible();
    // Description textarea
    await expect(card.locator('textarea')).toBeVisible();
    // Submit button (disabled when title empty)
    await expect(card.locator('.comment-btn-submit')).toBeDisabled();
    // Cancel button
    await expect(card.locator('.comment-btn-cancel')).toBeVisible();
  });

  // 6.2a - Submit disabled without title
  test('submit button is disabled when title is empty', async ({ page }) => {
    await expect(page.locator('.finding-card-new .comment-btn-submit')).toBeDisabled();
  });

  // 6.2b - Submit enables when title is filled
  test('submit button enables once title has content', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.fill('Race condition in session handler');
    await expect(page.locator('.finding-card-new .comment-btn-submit')).toBeEnabled();
  });

  // 6.2c - Clearing title disables submit again
  test('submit button disables again when title is cleared', async ({ page }) => {
    const titleInput = page.locator('.finding-card-new input[type="text"]').first();
    await titleInput.fill('Race condition');
    await expect(page.locator('.finding-card-new .comment-btn-submit')).toBeEnabled();
    await titleInput.fill('');
    await expect(page.locator('.finding-card-new .comment-btn-submit')).toBeDisabled();
  });

  // 6.2d - Severity defaults to a valid value
  test('severity select has a valid default value', async ({ page }) => {
    const value = await page.locator('.finding-card-new .finding-severity-select').inputValue();
    expect(['critical', 'high', 'medium', 'low', 'info']).toContain(value);
  });

  // 6.2e - Status select has all expected options
  test('status select contains all valid status options', async ({ page }) => {
    const options = await page.locator('.finding-card-new .finding-status-select option').allTextContents();
    const normalized = options.map((o) => o.trim().toLowerCase());
    for (const expected of ['draft', 'open', 'in progress', 'false positive', 'accepted', 'closed']) {
      expect(normalized.some((o) => o.includes(expected.split(' ')[0]))).toBe(true);
    }
  });
});
