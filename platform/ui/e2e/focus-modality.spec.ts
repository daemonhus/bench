import { test, expect, parkMouse, lastInput } from './helpers/input';
import type { Page } from '@playwright/test';

// Platform keyboard <-> mouse cases P1-P11 (see plan/keyboard-focus-tests.md).
// Input is always trusted (page.keyboard / page.mouse); `.focus()` only arranges.

const inDialog = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
const activeIsBody = (page: Page) =>
  page.evaluate(() => !document.activeElement || document.activeElement === document.body);
const inFeatureDetail = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest('.feature-detail'));

/** The workbench pushes its own hash entry, so Back may need more than one step. */
async function backToProjects(page: Page) {
  for (let i = 0; i < 4 && new URL(page.url()).pathname !== '/projects'; i++) await page.goBack();
  await expect(page).toHaveURL(/\/projects$/);
  await page.waitForSelector('.project-card');
}

async function flowId(page: Page, name: string): Promise<string> {
  const r = await page.request.get('/api/platform/flows?limit=50');
  const items = (await r.json()).items as { id: string; name: string }[];
  return items.find((f) => f.name === name)!.id;
}

test.beforeEach(async ({ page }) => {
  // These cases exercise the table layout (the gallery has its own suite: flow-folders.spec).
  await page.addInitScript(() => localStorage.setItem('flows-layout', 'table'));
  await page.goto('/projects');
  await page.waitForSelector('.project-card');
  await parkMouse(page);
});

test.describe('P1. Rail navigation: keyboard and mouse land in the same place', () => {
  test('Enter on Flows and a click both open /flows; keyboard keeps focus on the rail button', async ({ page }) => {
    const flows = page.locator('.platform-rail-btn[title="Flows"]');
    await page.locator('.platform-rail-btn[title="Projects"]').focus(); // arrange
    await page.keyboard.press('Tab');
    await expect(flows).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/flows$/);
    await expect(flows).toHaveAttribute('aria-current', 'page');
    await expect(flows).toBeFocused();
    expect(await lastInput(page)).toBe('keyboard');

    await page.locator('.platform-rail-btn[title="Projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    await flows.click();
    await expect(page).toHaveURL(/\/flows$/);
    await expect(flows).toHaveAttribute('aria-current', 'page');
    expect(await lastInput(page)).toBe('pointer');
  });
});

test.describe('P2. Project cards', () => {
  const open = (page: Page, name: string) => page.locator('.project-card', { hasText: name }).locator('.project-card-open');

  test('the project name is a real button: Enter and Space open the project, nothing scrolls', async ({ page }) => {
    await open(page, 'alpha').focus(); // arrange
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(/\/p\/alpha/);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await backToProjects(page);
    await open(page, 'beta').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/beta/);
  });

  test('the card is not itself a button (it contains other controls); clicking it still opens the project', async ({ page }) => {
    const card = page.locator('.project-card', { hasText: 'alpha' });
    expect(await card.getAttribute('role')).toBeNull();
    await card.click({ position: { x: 8, y: 60 } });
    await expect(page).toHaveURL(/\/p\/alpha/);
  });

  test('Enter on the nested edit button opens the editor, not the project', async ({ page }) => {
    const edit = page.locator('.project-card', { hasText: 'alpha' }).locator('.project-card-edit-btn');
    await edit.focus(); // arrange
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/projects$/);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await edit.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(/\/projects$/);
  });
});

test.describe('P3. Dialogs: open, Escape, focus returns to the opener', () => {
  test('Add project opened by keyboard', async ({ page }) => {
    const opener = page.locator('.add-project-trigger');
    await opener.focus(); // arrange
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Add project' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Add project opened by mouse', async ({ page }) => {
    const opener = page.locator('.add-project-trigger');
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Add project' });
    await expect(dialog.locator('input').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    // Backdrop click closes it too, and still gives focus back.
    await opener.click();
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Edit project returns focus to its edit button', async ({ page }) => {
    const edit = page.locator('.project-card', { hasText: 'beta' }).locator('.project-card-edit-btn');
    await edit.click();
    await expect(page.getByRole('dialog', { name: 'Edit project' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(edit).toBeFocused();
  });
});

test.describe('P4. Dialog focus trap', () => {
  test('Tab and Shift+Tab never leave the dialog', async ({ page }) => {
    await page.locator('.add-project-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Add project' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await inDialog(page)).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await inDialog(page)).toBe(true);
    }
  });

  test('after a mouse click on the backdrop-less area inside, Tab still stays inside', async ({ page }) => {
    await page.locator('.add-project-trigger').click();
    const dialog = page.getByRole('dialog', { name: 'Add project' });
    await dialog.locator('.modal-title').click(); // non-focusable text: focus falls to body/dialog
    await page.keyboard.press('Tab');
    expect(await inDialog(page)).toBe(true);
  });
});

test.describe('P5. Flows filter dropdowns (bench MultiSelectDropdown)', () => {
  const trigger = (page: Page) => page.locator('.multi-select-trigger', { hasText: 'Status' });
  const list = (page: Page) => page.getByRole('listbox', { name: 'Status' });
  test.beforeEach(async ({ page }) => {
    await page.locator('.platform-rail-btn[title="Flows"]').click();
    await page.waitForSelector('.flows-table-row');
  });

  test('keyboard: Enter opens, arrows move the highlight, Escape closes; focus stays on the trigger', async ({ page }) => {
    await trigger(page).focus(); // arrange
    await page.keyboard.press('Enter');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(list(page)).toBeVisible();
    await expect(trigger(page)).toBeFocused();
    const first = await trigger(page).getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    expect(await trigger(page).getAttribute('aria-activedescendant')).not.toBe(first);
    await page.keyboard.press('Escape');
    await expect(list(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('mouse: opens, and Escape after clicking an option also closes it and returns focus to the trigger', async ({ page }) => {
    await trigger(page).click();
    await list(page).getByRole('option').first().click();
    await page.keyboard.press('Escape');
    await expect(list(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await page.getByRole('button', { name: 'Reset filters' }).click(); // undo the toggle
  });

  test('clicking outside closes it', async ({ page }) => {
    await trigger(page).click();
    await expect(list(page)).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(list(page)).toBeHidden();
  });
});

test.describe('P6. Saved view tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('.platform-rail-btn[title="Flows"]').click();
    await page.waitForSelector('.flows-view-tab');
  });

  test('controls are not nested interactive elements', async ({ page }) => {
    expect(await page.locator('.flows-view-tabs button button, .flows-view-tabs button [role="button"]').count()).toBe(0);
  });

  test('the delete control is reachable by Tab and asks before deleting', async ({ page }) => {
    const tab = page.locator('.flows-view-tab', { hasText: 'Drafts' });
    const del = page.getByRole('button', { name: 'Delete view Drafts' });
    await tab.focus(); // arrange
    await page.keyboard.press('Tab');
    await expect(del).toBeFocused();

    await page.keyboard.press('Enter'); // first press only asks
    await expect(page.locator('.flows-view-tab', { hasText: 'Drafts' })).toBeVisible();
    await expect(page.locator('.flows-view-tab-confirm')).toBeVisible();
    await page.keyboard.press('Escape'); // keep
    await expect(page.locator('.flows-view-tab-confirm')).toBeHidden();
    await expect(page.locator('.flows-view-tab', { hasText: 'Drafts' })).toBeVisible();
  });

  test('mouse: delete also needs the confirmation click', async ({ page }) => {
    await page.locator('.flows-view-tab-group', { hasText: 'Drafts' }).hover();
    await page.getByRole('button', { name: 'Delete view Drafts' }).click();
    await expect(page.locator('.flows-view-tab', { hasText: 'Drafts' })).toBeVisible();
    await page.locator('.flows-view-tab-confirm-yes').click();
    await expect(page.locator('.flows-view-tab', { hasText: 'Drafts' })).toHaveCount(0);
    // restore for later tests
    await page.request.post('/api/platform/flow-views', { data: { name: 'Drafts', query: 'status:draft', owner: 'e2e', isShared: false } });
  });
});

test.describe('P7. Inline editing keeps focus', () => {
  test.beforeEach(async ({ page }) => {
    const id = await flowId(page, 'Login path');
    await page.goto(`/flows/${id}`);
    await page.waitForSelector('.editable'); // the flow page opens in edit mode
  });

  test('Enter edits, Enter commits and focus returns to the field', async ({ page }) => {
    const field = page.locator('.editable[role="textbox"]').first();
    await field.focus(); // arrange
    await page.keyboard.press('Enter');
    const input = page.locator('.editable-input').first();
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape'); // cancel
    await expect(page.locator('.editable-input')).toHaveCount(0);
    await expect(field).toBeFocused();
  });

  test('mouse: click edits; clicking elsewhere commits and leaves focus where the user clicked', async ({ page }) => {
    const field = page.locator('.editable[role="textbox"]').first();
    await field.click();
    await expect(page.locator('.editable-input').first()).toBeFocused();
    const other = page.getByRole('button', { name: 'Map', exact: true });
    await other.click();
    await expect(page.locator('.editable-input')).toHaveCount(0);
    await expect(other).toBeFocused(); // not stolen back by the field
  });
});

test.describe('P8. Flow map is keyboard-operable', () => {
  test('Tab reaches a node, arrows move between nodes, Enter selects, Escape clears', async ({ page }) => {
    const id = await flowId(page, 'Login path');
    await page.goto(`/flows/${id}`);
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.waitForSelector('.flow-graph-node');
    const nodes = page.locator('.flow-graph-node');
    expect(await nodes.count()).toBe(4);
    // one roving tab stop
    expect(await page.locator('.flow-graph-node[tabindex="0"]').count()).toBe(1);

    await nodes.first().focus(); // arrange
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-step-id'));
    await page.keyboard.press('ArrowDown');
    const second = await page.evaluate(() => document.activeElement?.getAttribute('data-step-id'));
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(await page.evaluate(() => document.activeElement?.classList.contains('flow-graph-node'))).toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.locator('.flow-graph-node[aria-pressed="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.flow-graph-node[aria-pressed="true"]')).toHaveCount(0);
  });

  test('mouse click selects and the same node is then keyboard-navigable', async ({ page }) => {
    const id = await flowId(page, 'Login path');
    await page.goto(`/flows/${id}`);
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.waitForSelector('.flow-graph-node');
    await page.locator('.flow-graph-node').nth(1).click();
    await expect(page.locator('.flow-graph-node[aria-pressed="true"]')).toHaveCount(1);
    const clicked = await page.locator('.flow-graph-node[aria-pressed="true"]').getAttribute('data-step-id');
    expect(await page.locator('.flow-graph-node[tabindex="0"]').getAttribute('data-step-id')).toBe(clicked);
  });
});

test.describe('P9. Facet filters: keyboard and mouse produce the same filter', () => {
  test('"only Draft" by mouse and by the o key yields the same visible flows', async ({ page }) => {
    await page.locator('.platform-rail-btn[title="Flows"]').click();
    await page.waitForSelector('.flows-table-row');
    const trigger = page.locator('.multi-select-trigger', { hasText: 'Status' });
    const rows = page.locator('.flows-table-row');

    await trigger.click();
    await page.locator('.multi-select-option', { hasText: 'Draft' }).hover();
    await page.getByRole('button', { name: /^Only Draft/ }).click();
    await expect(rows).toHaveCount(2); // the two drafts
    await expect(trigger).toContainText('Status (1)');
    const viaMouse = await page.locator('.flows-table-row .ft-flow-name').allTextContents();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(rows).toHaveCount(3);

    await trigger.focus(); // arrange
    await page.keyboard.press('Enter');
    const draft = page.getByRole('option', { name: /^Draft/ });
    for (let i = 0; i < 4 && (await trigger.getAttribute('aria-activedescendant')) !== (await draft.getAttribute('id')); i++) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('o');
    await expect(rows).toHaveCount(2);
    const viaKeys = await page.locator('.flows-table-row .ft-flow-name').allTextContents();
    expect(viaKeys.sort()).toEqual(viaMouse.sort());
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Reset filters' }).click();
  });
});

test.describe('P10. Open feature in workbench', () => {
  async function openLoginFlow(page: Page) {
    const id = await flowId(page, 'Login path');
    await page.goto(`/flows/${id}`);
    await page.waitForSelector('button.flow-step-title-link');
  }
  const open = (page: Page) => page.locator('button.flow-step-title-link').first();

  test('Enter and click reach the same feature route and anchor focus on the new page', async ({ page }) => {
    await openLoginFlow(page);
    await open(page).focus(); // arrange
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/alpha#\/feature\//);
    const viaKeyUrl = page.url();
    await expect.poll(() => inFeatureDetail(page)).toBe(true);

    await openLoginFlow(page);
    await open(page).click();
    await expect(page).toHaveURL(/\/p\/alpha#\/feature\//);
    expect(page.url()).toBe(viaKeyUrl);
    await expect.poll(() => inFeatureDetail(page)).toBe(true);
  });
});

test.describe('P11. Route changes never strand focus on <body>', () => {
  test('keyboard-only: Flows -> flow -> Projects', async ({ page }) => {
    await page.locator('.platform-rail-btn[title="Flows"]').focus(); // arrange
    await page.keyboard.press('Enter');
    await page.waitForSelector('.flows-table-row');
    expect(await activeIsBody(page)).toBe(false);

    await page.locator('.flows-table-row', { hasText: 'Login path' }).focus(); // arrange
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/flows\/[0-9a-f]+$/);
    await expect.poll(() => activeIsBody(page)).toBe(false);

    await page.locator('.platform-rail-btn[title="Projects"]').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/projects$/);
    expect(await activeIsBody(page)).toBe(false);
  });

  test('mouse-only: the same trip', async ({ page }) => {
    await page.locator('.platform-rail-btn[title="Flows"]').click();
    await page.locator('.flows-table-row', { hasText: 'Login path' }).click();
    await expect(page).toHaveURL(/\/flows\/[0-9a-f]+$/);
    await expect.poll(() => activeIsBody(page)).toBe(false);
    await page.locator('.platform-rail-btn[title="Projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    expect(await activeIsBody(page)).toBe(false);
  });

  test('browser Back from a workbench keeps focus out of <body>', async ({ page }) => {
    await page.locator('.project-card', { hasText: 'alpha' }).click();
    await expect(page).toHaveURL(/\/p\/alpha/);
    await backToProjects(page);
    await expect.poll(() => activeIsBody(page)).toBe(false);
  });
});
