import { test, expect, parkMouse } from './helpers/input';
import type { APIRequestContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Flows gallery and nested folders: navigation, the folder path under the title, creating
// in the current folder, moving by drag and by keyboard menu, rename, delete (which deletes
// the flows inside), search across folders, and back from a flow to its folder.
//
// Every test creates its own folders and flows and only moves those, so the seeded flows
// stay at the top level for the other suites. afterEach removes whatever folders remain.

interface Folder { id: string; name: string; parentId?: string }

const createdFlows: string[] = [];
const api = {
  folder: async (r: APIRequestContext, name: string, parentId = '') =>
    (await (await r.post('/api/flow-folders', { data: { name, parentId } })).json()) as Folder,
  flow: async (r: APIRequestContext, name: string, folderId = '') => {
    const f = (await (await r.post('/api/flows', { data: { name, folderId } })).json()) as { id: string };
    createdFlows.push(f.id);
    return f;
  },
  getFlow: async (r: APIRequestContext, id: string) => r.get(`/api/flows/${id}`),
};

const card = (page: Page, name: string) => page.locator('.flow-card', { has: page.locator('.flow-card-title', { hasText: new RegExp(`^${name}$`) }) });
const crumbs = (page: Page) => page.locator('.flows-list-header .flow-path').locator('.flow-path-link, .flow-path-current');

test.afterEach(async ({ request }) => {
  // Flows made here (including ones moved back to the top level, or made through the UI).
  for (const id of createdFlows.splice(0)) await request.delete(`/api/flows/${id}`);
  const page1 = (await (await request.get('/api/flows?limit=200')).json()) as { items: { id: string; name: string }[] };
  for (const f of page1.items.filter((x) => x.name === 'Pay by card')) await request.delete(`/api/flows/${f.id}`);
  const folders = (await (await request.get('/api/flow-folders')).json()) as Folder[];
  for (const f of folders.filter((x) => !x.parentId)) {
    await request.delete(`/api/flow-folders/${f.id}?confirm=true`);
  }
});

test('the flows page opens as a gallery; the table choice is remembered', async ({ page }) => {
  await page.goto('/flows');
  await expect(page.locator('.flow-card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gallery' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.locator('.flows-table-row').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.flows-table-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Gallery' }).click();
  await expect(page.locator('.flow-card').first()).toBeVisible();
});

test('New folder creates a folder card here; opening it shows its path under the title', async ({ page }) => {
  await page.goto('/flows');
  await expect(crumbs(page)).toHaveText(['Flows']);
  await page.getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await dialog.getByLabel('Name').fill('Auth');
  await dialog.getByRole('button', { name: 'Create folder' }).click();
  await expect(dialog).toBeHidden();

  await card(page, 'Auth').locator('.flow-card-title').click();
  await expect(page).toHaveURL(/\/flows\?folder=/);
  await expect(page.locator('.flows-list-header h1')).toHaveText('Auth');
  await expect(crumbs(page)).toHaveText(['Flows', 'Auth']);
  await expect(page.locator('.flows-list-header .flow-path-icon svg')).toBeVisible(); // the little folder icon
  await expect(page.getByText('This folder is empty')).toBeVisible();

  // A nested folder, then up again by the path and by Back.
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('dialog', { name: 'New folder in Auth' }).getByLabel('Name').fill('Login');
  await page.keyboard.press('Enter');
  await card(page, 'Login').click();
  await expect(crumbs(page)).toHaveText(['Flows', 'Auth', 'Login']);
  await expect(crumbs(page).last()).toHaveAttribute('aria-current', 'location');
  await crumbs(page).nth(1).click();
  await expect(page.locator('.flows-list-header h1')).toHaveText('Auth');
  await page.goBack();
  await expect(page.locator('.flows-list-header h1')).toHaveText('Login');
  await crumbs(page).first().click();
  await expect(page.locator('.flows-list-header h1')).toHaveText('Flows');
});

test('folder names are unique among siblings; the dialog says so', async ({ page, request }) => {
  await api.folder(request, 'Payments');
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await dialog.getByLabel('Name').fill('payments');
  await dialog.getByRole('button', { name: 'Create folder' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a new flow is created in the open folder', async ({ page, request }) => {
  const dir = await api.folder(request, 'Checkout');
  await page.goto(`/flows?folder=${dir.id}`);
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByLabel('New flow name').fill('Pay by card');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/flows\/[^/?]+$/);
  // The folder crumb on the flow page returns to its folder.
  await page.locator('.flow-path').getByRole('button', { name: 'Checkout', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`folder=${dir.id}`));
  await expect(card(page, 'Pay by card')).toBeVisible();
  const root = await (await request.get('/api/flows?folder=root')).json();
  expect(root.items.map((f: { name: string }) => f.name)).not.toContain('Pay by card');
});

test('drag a flow onto a folder card, then back onto "All flows" in the path', async ({ page, request }) => {
  const dir = await api.folder(request, 'Drop here');
  const flow = await api.flow(request, 'Draggable flow');
  await page.goto('/flows');
  await card(page, 'Draggable flow').dragTo(card(page, 'Drop here'));
  await expect(card(page, 'Draggable flow')).toHaveCount(0);
  expect((await (await api.getFlow(request, flow.id)).json()).folderId).toBe(dir.id);

  await card(page, 'Drop here').click();
  await expect(card(page, 'Draggable flow')).toBeVisible();
  await card(page, 'Draggable flow').dragTo(crumbs(page).first());
  await expect(card(page, 'Draggable flow')).toHaveCount(0);
  expect((await (await api.getFlow(request, flow.id)).json()).folderId).toBeUndefined();
});

test('folders can be dragged into folders, but never into themselves', async ({ page, request }) => {
  const outer = await api.folder(request, 'Outer');
  await api.folder(request, 'Inner');
  await page.goto('/flows');
  await card(page, 'Inner').dragTo(card(page, 'Outer'));
  await expect(card(page, 'Inner')).toHaveCount(0);
  await card(page, 'Outer').click();
  await expect(card(page, 'Inner')).toBeVisible();
  // Moving Outer into itself or its own child is never offered.
  await page.goto('/flows');
  await card(page, 'Outer').getByRole('button', { name: 'Actions for Outer' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await expect(page.getByRole('menuitem', { name: /Outer\/Inner/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^Outer$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect((await (await request.get('/api/flow-folders')).json()).find((f: Folder) => f.name === 'Inner').parentId).toBe(outer.id);
});

test('keyboard: the card menu moves a flow without dragging, and Escape returns focus', async ({ page, request }) => {
  const dir = await api.folder(request, 'Keyboard target');
  await api.flow(request, 'Keyboard flow');
  await page.goto('/flows');
  await parkMouse(page);
  const trigger = card(page, 'Keyboard flow').getByRole('button', { name: 'Actions for Keyboard flow' });
  await trigger.focus(); // arrange
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // Move to…
  const target = page.getByRole('menuitem', { name: 'Keyboard target' });
  for (let i = 0; i < 6 && !(await target.evaluate((e) => e === document.activeElement)); i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page, 'Keyboard flow')).toHaveCount(0);
  await page.goto(`/flows?folder=${dir.id}`);
  await expect(card(page, 'Keyboard flow')).toBeVisible();
});

test('rename a folder from its menu', async ({ page, request }) => {
  await api.folder(request, 'Old name');
  await page.goto('/flows');
  await card(page, 'Old name').getByRole('button', { name: 'Actions for Old name' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename folder' });
  await expect(dialog.getByLabel('Name')).toHaveValue('Old name');
  await dialog.getByLabel('Name').fill('New name');
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await expect(card(page, 'New name')).toBeVisible();
  await expect(card(page, 'Old name')).toHaveCount(0);
});

test('deleting a folder says what goes with it, and removes its flows', async ({ page, request }) => {
  const top = await api.folder(request, 'Doomed');
  const sub = await api.folder(request, 'Doomed child', top.id);
  const a = await api.flow(request, 'Doomed flow A', top.id);
  const b = await api.flow(request, 'Doomed flow B', sub.id);
  await page.goto('/flows');
  await card(page, 'Doomed').getByRole('button', { name: 'Actions for Doomed' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete folder' });
  await expect(dialog).toContainText('1 subfolder');
  await expect(dialog).toContainText('2 flows');
  await expect(dialog.getByRole('button', { name: 'Keep folder' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep folder' }).click();
  await expect(card(page, 'Doomed')).toBeVisible();
  expect((await api.getFlow(request, a.id)).status()).toBe(200);

  await card(page, 'Doomed').getByRole('button', { name: 'Actions for Doomed' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Delete folder and flows' }).click();
  await expect(card(page, 'Doomed')).toHaveCount(0);
  expect((await api.getFlow(request, a.id)).status()).toBe(404);
  expect((await api.getFlow(request, b.id)).status()).toBe(404);
});

test('deleting the folder you are in takes you to its parent', async ({ page, request }) => {
  const top = await api.folder(request, 'Parent');
  const child = await api.folder(request, 'Child', top.id);
  await page.goto(`/flows?folder=${child.id}`);
  await expect(page.locator('.flows-list-header h1')).toHaveText('Child');
  await page.goto(`/flows?folder=${top.id}`);
  await card(page, 'Child').getByRole('button', { name: 'Actions for Child' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Delete folder and flows' }).click();
  await expect(page.locator('.flows-list-header h1')).toHaveText('Parent');
  // A stale link to a deleted folder falls back to the top level.
  await page.goto(`/flows?folder=${child.id}`);
  await expect(page.locator('.flows-list-header h1')).toHaveText('Flows');
});

test('search looks across folders and shows where each match lives', async ({ page, request }) => {
  const dir = await api.folder(request, 'Hidden away');
  await api.flow(request, 'Needle flow', dir.id);
  await page.goto('/flows');
  await expect(card(page, 'Needle flow')).toHaveCount(0);
  await page.getByPlaceholder(/Search flows/).fill('Needle');
  await expect(card(page, 'Needle flow')).toBeVisible();
  await expect(card(page, 'Needle flow').locator('.flow-card-folder-path')).toHaveText('Hidden away');
  await expect(page.locator('.flows-list-header .flow-path')).toContainText('Searching all folders');
  // Folder cards are not search results.
  await expect(card(page, 'Hidden away')).toHaveCount(0);
});

test('axe: gallery with folders, the card menu and the delete dialog', async ({ page, request }) => {
  const dir = await api.folder(request, 'Accessible');
  await api.flow(request, 'Inside accessible', dir.id);
  await page.goto('/flows');
  await expect(card(page, 'Accessible')).toBeVisible();
  const scan = async (include?: string) => {
    const b = new AxeBuilder({ page }).disableRules(['color-contrast']);
    if (include) b.include(include);
    return (await b.analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  };
  expect(await scan()).toEqual([]);
  await card(page, 'Accessible').getByRole('button', { name: 'Actions for Accessible' }).click();
  expect(await scan('.flow-card-menu')).toEqual([]);
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByRole('dialog')).toContainText('1 flow');
  expect(await scan('[role="dialog"]')).toEqual([]);
});

test('gallery cards are roomy, readable, and show the flow\'s outline behind the text', async ({ page }) => {
  await page.goto('/flows');
  const login = card(page, 'Login path');
  await expect(login).toBeVisible();
  const m = await login.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const t = getComputedStyle(e.querySelector('.flow-card-title')!);
    const d = e.querySelector('.flow-card-desc');
    return { w: r.width, h: r.height, title: parseFloat(t.fontSize), desc: d ? parseFloat(getComputedStyle(d).fontSize) : 0 };
  });
  expect(m.w).toBeGreaterThanOrEqual(340);
  expect(m.h).toBeGreaterThanOrEqual(200);
  expect(m.title).toBeGreaterThanOrEqual(16);
  expect(m.desc).toBeGreaterThanOrEqual(14);
  // Login path has a branched step tree: one dot per step behind the card; an empty flow has none.
  await expect(login.locator('svg.flow-card-backdrop circle')).toHaveCount(4);
  await expect(card(page, 'Empty flow').locator('svg.flow-card-backdrop')).toHaveCount(0);
  const backdrop = await login.locator('svg.flow-card-backdrop').evaluate((e) => ({ events: getComputedStyle(e).pointerEvents, hidden: e.getAttribute('aria-hidden') }));
  expect(backdrop).toEqual({ events: 'none', hidden: 'true' });
});

test('the folder path is set in the UI font, not monospace', async ({ page, request }) => {
  const dir = await api.folder(request, 'Font check');
  await page.goto(`/flows?folder=${dir.id}`);
  const font = await page.locator('.flows-list-header .flow-path').evaluate((e) => getComputedStyle(e).fontFamily);
  expect(font.toLowerCase()).not.toMatch(/mono|menlo|consolas|courier/);
});

test('a flow\'s detail page shows its folder path, and the folders link back', async ({ page, request }) => {
  const top = await api.folder(request, 'Detail top');
  const sub = await api.folder(request, 'Detail sub', top.id);
  const flow = await api.flow(request, 'Deep flow', sub.id);
  await page.goto(`/flows/${flow.id}`);
  const path = page.getByRole('navigation', { name: 'Folder' });
  await expect(path).toContainText('Detail top');
  await expect(path).toContainText('Detail sub');
  // Only the containing folders: the flow's name is the page title, not repeated in the trail.
  await expect(path).not.toContainText('Deep flow');
  await expect(path.getByRole('button')).toHaveText(['Flows', 'Detail top', 'Detail sub']);
  const font = await path.evaluate((e) => getComputedStyle(e.querySelector('button')!).fontFamily);
  expect(font.toLowerCase()).not.toMatch(/mono|menlo|consolas|courier/);
  await path.getByRole('button', { name: 'Detail top' }).click();
  await expect(page).toHaveURL(new RegExp(`folder=${top.id}`));
  await expect(page.locator('.flows-list-header h1')).toHaveText('Detail top');
});

test('the flow page is always editable and autosaves, with the status badge as its status control', async ({ page, request }) => {
  const flow = await api.flow(request, 'Badge flow');
  await page.goto(`/flows/${flow.id}`);
  await expect(page.locator('.editable').first()).toBeVisible(); // editable fields, no edit mode
  await expect(page.getByRole('button', { name: /^(Done|Edit)$/ })).toHaveCount(0);
  // One status control in the title row: bench's pick-one dropdown (the filters' pill).
  const status = page.getByRole('button', { name: /^Flow status:/ });
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText(/Draft/);
  await expect(status).toHaveClass(/select-tinted/); // bench's status control
  expect(await status.evaluate((e) => !!e.closest('.flow-detail-name-row'))).toBe(true);
  await status.click();
  await page.getByRole('option', { name: 'Active' }).click();
  await expect(status).toHaveText(/Active/);
  await expect.poll(async () => (await (await api.getFlow(request, flow.id)).json()).status).toBe('active');
  // Renaming saves without any explicit action.
  await page.locator('.flow-detail-name').first().click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Badge flow renamed');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await (await api.getFlow(request, flow.id)).json()).name).toBe('Badge flow renamed');
});

test('the flow page draws its outline at a readable size', async ({ page }) => {
  const r = await page.request.get('/api/flows?limit=50');
  const id = ((await r.json()).items as { id: string; name: string }[]).find((f) => f.name === 'Login path')!.id;
  await page.goto(`/flows/${id}`);
  const shape = page.locator('.flow-detail-shape svg');
  await expect(shape).toBeVisible();
  const box = await shape.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(60);
  expect(await shape.locator('circle').first().getAttribute('r')).toBe('6');
  // It sits at the header's right edge, clear of the status control, and above the tab bar.
  const main = (await page.locator('.flow-detail-toolbar').boundingBox())!;
  expect(Math.abs((box!.x + box!.width) - (main.x + main.width))).toBeLessThanOrEqual(2);
  const badge = (await page.getByRole('button', { name: /^Flow status:/ }).boundingBox())!;
  expect(badge.x + badge.width).toBeLessThanOrEqual(box!.x);
  const tabs = (await page.locator('.flow-detail-tab-bar').boundingBox())!;
  expect(box!.y + box!.height).toBeLessThanOrEqual(tabs.y);
});

test('the flow page puts its title above the folder path and tabs, as the list page does', async ({ page, request }) => {
  const dir = await api.folder(request, 'Heading check');
  const flow = await api.flow(request, 'Heading flow', dir.id);
  await page.goto(`/flows?folder=${dir.id}`);
  const listTitle = (await page.locator('.flows-list-header h1').boundingBox())!;
  const listPath = (await page.locator('.flows-list-header .flow-path').boundingBox())!;
  await page.goto(`/flows/${flow.id}`);
  const title = (await page.locator('.flow-detail-heading .flow-detail-name').boundingBox())!;
  const path = (await page.locator('.flow-detail-heading .flow-path').boundingBox())!;
  const tabs = (await page.locator('.flow-detail-tab-bar').boundingBox())!;
  expect(title.y + title.height).toBeLessThanOrEqual(path.y + 1);
  expect(path.y + path.height).toBeLessThanOrEqual(tabs.y);
  // Same vertical rhythm as the list page header (within a few px of the editable field's padding).
  expect(Math.abs(path.y - listPath.y)).toBeLessThanOrEqual(6);
  expect(Math.abs(title.y + title.height / 2 - (listTitle.y + listTitle.height / 2))).toBeLessThanOrEqual(6);
  // Still shown on the other tabs.
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.flow-detail-heading .flow-detail-name')).toBeVisible();
});

test('The toolbar runs search, filter, sort; New folder / New flow sit top right; the views row appears only when there are saved views', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/flows');
  const x = async (sel: string) => (await page.locator(`.flows-filter-bar ${sel}`).first().boundingBox())!.x;
  const order = [await x('.flows-search'), await x('.activity-filters'), await x('.sort-control')];
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // One toolbar line at desktop width, and the actions in the title row's right end.
  const bar = (await page.locator('.flows-filter-bar').boundingBox())!;
  expect(bar.height).toBeLessThan(60);
  const header = (await page.locator('.flows-list-header').boundingBox())!;
  const actions = (await page.locator('.flows-list-header .flows-list-actions').boundingBox())!;
  expect(Math.abs(actions.x + actions.width - (header.x + header.width))).toBeLessThanOrEqual(2);
  // The fixture has a saved view ("Drafts"), so the row shows; with none and no filter it would not.
  await expect(page.locator('.flows-view-tabs')).toBeVisible();
  const views = (await (await request.get('/api/flow-views')).json()) as { id: string; name: string; query: string; owner: string; isShared: boolean }[];
  for (const v of views) await request.delete(`/api/flow-views/${v.id}`);
  await page.reload();
  await expect(page.locator('.flows-list-actions')).toBeVisible();
  await expect(page.locator('.flows-view-tabs')).toHaveCount(0);
  await page.getByPlaceholder(/Search flows/).fill('login');
  await expect(page.locator('.flows-view-tabs')).toBeVisible(); // a filter can be saved as a view
  for (const v of views) await request.post('/api/flow-views', { data: { name: v.name, query: v.query, owner: v.owner, isShared: v.isShared } });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the gallery is one column and nothing scrolls sideways', async ({ page, request }) => {
    await api.folder(request, 'Phone folder');
    await page.goto('/flows');
    await expect(card(page, 'Phone folder')).toBeVisible();
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      lefts: [...new Set([...document.querySelectorAll('.flow-card')].map((e) => Math.round(e.getBoundingClientRect().left)))],
    }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(m.lefts.length).toBe(1);
  });
});
