import { test, expect, openView, activeArea, isPhone, primaryPane, api } from './helpers/input';
import type { Locator, Page } from '@playwright/test';

// Modal chain: for every overlay, the same expected behaviour.
//   semantics  - role=dialog, aria-modal, an accessible name
//   open       - focus moves INTO the dialog (keyboard- and mouse-opened)
//   trap       - Tab / Shift+Tab never leave it
//   close      - Escape closes it; so does a backdrop click
//   return     - focus goes back to what had it before (the opener)
// `.focus()` / shortcuts only ARRANGE or OPEN; assertions read real focus.

interface ModalSpec {
  name: string;
  route: string;
  ready: string;
  dialog: string;
  backdrop: string;
  /** The desktop panes this opens from do not exist on a phone (drawers): covered in responsive.spec. */
  skipOnPhone?: boolean;
  /** Prepare the page (e.g. open a file) before opening the modal. */
  prepare?: (page: Page) => Promise<void>;
  /** The element that should get focus back; also what a keyboard user opens it from. */
  opener: (page: Page) => Locator;
  /** Open with the keyboard from `opener` focused. */
  openByKeyboard: (page: Page, opener: Locator) => Promise<void>;
  /** Open with the mouse. */
  openByMouse: (page: Page, opener: Locator) => Promise<void>;
}

const enterOnOpener = async (_p: Page, opener: Locator) => { await opener.focus(); await opener.press('Enter'); };
const clickOpener = async (_p: Page, opener: Locator) => { await opener.click(); };

const openFile = async (page: Page) => {
  await page.locator('.tree-file').first().click();
  await page.waitForSelector('[data-line-id]');
};

const MODALS: ModalSpec[] = [
  {
    name: 'Keyboard shortcuts', route: '/#/findings', ready: '[data-nav-area="findings-list"]', skipOnPhone: true,
    dialog: '.shortcuts-modal', backdrop: '.shortcuts-overlay',
    opener: (p) => p.locator('.shortcuts-fab'),
    openByKeyboard: enterOnOpener, openByMouse: clickOpener,
  },
  {
    name: 'Set baseline', route: '/#/delta', ready: '[data-nav-area="delta"]',
    dialog: '.set-baseline-modal', backdrop: '.set-baseline-overlay',
    opener: (p) => p.locator('.delta-edit-pencil[data-tooltip="Set new baseline"]'),
    openByKeyboard: enterOnOpener,
    openByMouse: async (p, o) => { await o.hover(); await o.click(); },
  },
  {
    name: 'Manage links', route: '/#/findings', ready: '[data-nav-area="findings-list"]',
    dialog: '.link-manage-modal', backdrop: '.overlay-backdrop',
    opener: (p) => p.locator('[data-finding-id] button[title="Manage links"]').first(),
    openByKeyboard: enterOnOpener, openByMouse: clickOpener,
  },
  {
    name: 'Manage web links', route: '/#/findings', ready: '[data-nav-area="findings-list"]',
    dialog: '.ref-manage-modal', backdrop: '.overlay-backdrop',
    opener: (p) => p.locator('[data-finding-id] button[title="Manage web links"]').first(),
    openByKeyboard: enterOnOpener, openByMouse: clickOpener,
  },
  {
    name: 'Orphan triage', route: '/#/browse', ready: '.tree-node', skipOnPhone: true,
    prepare: openFile,
    dialog: '.orphan-modal', backdrop: '.orphan-overlay',
    opener: (p) => p.locator('.sidebar-orphan-badge'),
    openByKeyboard: enterOnOpener, openByMouse: clickOpener,
  },
  {
    name: 'Go to file', route: '/#/browse/CLAUDE.md', ready: '[data-line-id]',
    dialog: '.file-search-modal', backdrop: '.file-search-overlay',
    opener: (p) => primaryPane(p),
    openByKeyboard: async (p, o) => { await o.focus(); await p.keyboard.press('Control+g'); },
    openByMouse: async (p, o) => { await o.click({ position: { x: 4, y: 4 } }); await p.keyboard.press('Control+g'); },
  },
  {
    name: 'Find in files', route: '/#/browse/CLAUDE.md', ready: '[data-line-id]',
    dialog: '.content-search-modal', backdrop: '.content-search-overlay',
    opener: (p) => primaryPane(p),
    openByKeyboard: async (p, o) => { await o.focus(); await p.keyboard.press('Control+Shift+f'); },
    openByMouse: async (p, o) => { await o.click({ position: { x: 4, y: 4 } }); await p.keyboard.press('Control+Shift+f'); },
  },
];

const inDialog = (page: Page, dialog: string) =>
  page.evaluate((sel) => !!document.activeElement?.closest(sel), dialog);

for (const m of MODALS) {
  test.describe(`Modal: ${m.name}`, () => {
    test.beforeEach(async ({ page }) => {
      test.skip(!!m.skipOnPhone && isPhone(page), 'opens from a desktop pane; the phone equivalent is covered in responsive.spec');
      await openView(page, m.route, m.ready);
      await m.prepare?.(page);
      await expect(m.opener(page)).toBeVisible();
    });

    test('is a labelled modal dialog', async ({ page }) => {
      await m.openByKeyboard(page, m.opener(page));
      const dialog = page.locator(m.dialog);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      const named = await dialog.evaluate((el) => {
        const lb = el.getAttribute('aria-labelledby');
        const byId = lb ? document.getElementById(lb)?.textContent?.trim() : '';
        return !!(el.getAttribute('aria-label')?.trim() || byId);
      });
      expect(named).toBe(true);
    });

    test('keyboard: focus enters the dialog, Tab stays inside, Escape closes and returns focus', async ({ page }) => {
      const opener = m.opener(page);
      await m.openByKeyboard(page, opener);
      await expect(page.locator(m.dialog)).toBeVisible();
      await expect.poll(() => inDialog(page, m.dialog)).toBe(true);

      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Tab');
        expect(await inDialog(page, m.dialog)).toBe(true);
      }
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await inDialog(page, m.dialog)).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(page.locator(m.dialog)).toBeHidden();
      await expect(opener).toBeFocused();
    });

    test('mouse: opens with focus inside; a backdrop click closes it and returns focus', async ({ page }) => {
      const opener = m.opener(page);
      await m.openByMouse(page, opener);
      await expect(page.locator(m.dialog)).toBeVisible();
      await expect.poll(() => inDialog(page, m.dialog)).toBe(true);

      await page.locator(m.backdrop).click({ position: { x: 4, y: 4 } });
      await expect(page.locator(m.dialog)).toBeHidden();
      await expect(opener).toBeFocused();
    });
  });
}

// Editing a ref inside a modal: Escape leaves the edit, not the dialog, from ANY
// field of the edit form (it used to work only from the last input), and Enter
// in a text field saves.
for (const m of [
  { name: 'Manage web links', opener: '[data-finding-id] button[title="Manage web links"]', dialog: '.ref-manage-modal', entity: ['comment', 'c-on-finding'] },
  { name: 'Manage links', opener: '[data-finding-id] button[title="Manage links"]', dialog: '.link-manage-modal', entity: ['finding', null] },
]) {
  test.describe(`Modal: ${m.name} - editing a ref`, () => {
    // Writes a ref into the shared backend; the layout projects run in parallel
    // against the same fixture and would race on it. Not layout-dependent.
    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium', 'shared fixture state; chromium only');
      await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
      let entityId = m.entity[1];
      if (!entityId) {
        // The finding whose card we open from (first card).
        entityId = await page.locator('[data-finding-id]').first().getAttribute('data-finding-id');
      }
      const res = await page.request.post(api('/api/refs'), {
        data: { entityType: m.entity[0], entityId, provider: 'url', url: 'https://example.com/original', title: 'Original' },
      });
      expect(res.ok()).toBe(true);
      await page.reload();
      await page.waitForSelector('[data-nav-area="findings-list"]');
    });

    async function openEdit(page: Page) {
      const opener = page.locator(m.opener).first();
      await opener.focus(); // arrange
      await opener.press('Enter');
      const dialog = page.locator(m.dialog);
      await expect(dialog).toBeVisible();
      await dialog.locator('.ref-manage-row').first().locator('button[title="Edit"]').click();
      await expect(dialog.locator('.ref-manage-edit-form')).toBeVisible();
      return dialog;
    }

    for (const field of ['url', 'label', 'provider'] as const) {
      test(`Escape in the ${field} field leaves the edit; a second Escape closes the dialog`, async ({ page }) => {
        const dialog = await openEdit(page);
        const form = dialog.locator('.ref-manage-edit-form');
        const target = field === 'url' ? form.locator('input[type="url"]')
          : field === 'label' ? form.locator('input[type="text"]')
          : form.locator('select');
        await target.focus();
        await page.keyboard.press('Escape');
        await expect(form).toBeHidden();
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      });
    }

    test('Enter in the URL field saves the edit', async ({ page }) => {
      const dialog = await openEdit(page);
      const form = dialog.locator('.ref-manage-edit-form');
      await form.locator('input[type="text"]').fill('Renamed');
      await form.locator('input[type="url"]').focus();
      await page.keyboard.press('Enter');
      await expect(form).toBeHidden();
      await expect(dialog.locator('.ref-manage-label').first()).toHaveText('Renamed');
      await expect(dialog).toBeVisible();
    });
  });
}
