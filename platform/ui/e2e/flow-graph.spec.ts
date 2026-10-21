import { test, expect } from './helpers/input';
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';

// Editing a flow as a graph from its page: inserting between steps, removing from the middle,
// moving along the path, branching and joining, the connection details, actor and controls,
// and export. Each test builds its own flow through the API (and deletes it after), so the
// seeded flows other specs count stay as they are.

type Feature = { id: string; title: string };
type FlowJSON = { id: string; steps: { id: string; featureId: string; actor: string; controls: string[] }[]; edges: Record<string, unknown>[] };

async function features(request: APIRequestContext, project = 'alpha'): Promise<Feature[]> {
  return (await request.get(`/api/projects/${project}/features`)).json();
}

/** A flow on alpha's features (by title), steps joined as edges [from, to] by index. */
async function makeFlow(request: APIRequestContext, titles: string[], edges: [number, number, Record<string, unknown>?][]): Promise<string> {
  const feats = await features(request);
  const id = (t: string) => feats.find((f) => f.title === t)!.id;
  const r = await request.post('/api/flows', {
    data: {
      name: `graph e2e ${Math.random().toString(36).slice(2, 8)}`,
      steps: titles.map((t, i) => ({ clientId: String(i), projectSlug: 'alpha', featureId: id(t) })),
      edges: edges.map(([a, b, props]) => ({ from: String(a), to: String(b), ...props })),
    },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id;
}

async function getFlow(request: APIRequestContext, id: string): Promise<FlowJSON> {
  return (await request.get(`/api/flows/${id}`)).json();
}

/** The flow's edges as "title>title", by feature title (branch order kept). */
async function edgeList(request: APIRequestContext, id: string): Promise<string[]> {
  const [f, feats] = await Promise.all([getFlow(request, id), features(request)]);
  const title = (stepId: string) => feats.find((x) => x.id === f.steps.find((s) => s.id === stepId)!.featureId)!.title;
  return f.edges.map((e) => `${title(e.fromStepId as string)}>${title(e.toStepId as string)}`).sort();
}

const created: string[] = [];
test.afterEach(async ({ request }) => {
  while (created.length) await request.delete(`/api/flows/${created.pop()}`);
});

async function open(page: Page, id: string) {
  await page.goto(`/flows/${id}`);
  await expect(page.locator('.flow-step').first()).toBeVisible();
}

const LOGIN = 'POST /login';
const READ = 'sqlite://users.db (read)';
const WRITE = 'sqlite://users.db (write)';
const REAPER = 'session reaper';

test('inserting a step between two keeps the path going', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ], [[0, 1]]);
  created.push(id);
  await open(page, id);
  await page.locator('.flow-edge').first().getByRole('button', { name: '+ insert step' }).click();
  const picker = page.getByRole('complementary', { name: 'Insert step' });
  await expect(picker).toBeVisible();
  await picker.getByPlaceholder(/Search features/).fill('write');
  await picker.locator('.flow-picker-result', { hasText: WRITE }).filter({ hasText: 'alpha' }).click();
  await expect(page.locator('.flow-step')).toHaveCount(3);
  await expect(page.locator('.flow-step-title')).toHaveText([LOGIN, WRITE, READ]);
  expect(await edgeList(request, id)).toEqual([`${LOGIN}>${WRITE}`, `${WRITE}>${READ}`]);
});

test('removing a middle step keeps the steps after it', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ, WRITE], [[0, 1], [1, 2]]);
  created.push(id);
  await open(page, id);
  await page.locator('.flow-step').nth(1).getByRole('button', { name: /Remove/ }).click();
  await expect(page.locator('.flow-step-title')).toHaveText([LOGIN, WRITE]);
  expect(await edgeList(request, id)).toEqual([`${LOGIN}>${WRITE}`]);
});

test('moving a step up swaps it with the step before it on the path', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ, WRITE], [[0, 1], [1, 2]]);
  created.push(id);
  await open(page, id);
  await page.locator('.flow-step').nth(2).getByRole('button', { name: /Up/ }).click();
  await expect(page.locator('.flow-step-title')).toHaveText([LOGIN, WRITE, READ]);
  await expect(page.locator('.flow-step-pos')).toHaveText(['1', '2', '3']);
});

test('a branch takes a label, and a step can join another or move to another branch', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ], [[0, 1, { condition: 'user exists' }]]);
  created.push(id);
  await open(page, id);
  // Branch out of step 1.
  await page.locator('.flow-step').first().getByRole('button', { name: /Branch/ }).click();
  const picker = page.getByRole('complementary', { name: 'Branch from step' });
  await picker.getByPlaceholder(/Search features/).fill('reaper');
  await picker.locator('.flow-picker-result', { hasText: REAPER }).filter({ hasText: 'alpha' }).click();
  await expect(page.locator('.flow-branch-connector')).toHaveCount(2);
  // Label the new branch.
  await page.locator('.flow-branch-condition-empty').click();
  await page.locator('.flow-branch-condition-input').fill('user missing');
  await page.keyboard.press('Enter');
  await expect(page.locator('.flow-branch-condition', { hasText: 'user missing' })).toBeVisible();
  // Join: the reaper step (3) also leads to step 2.
  const reaper = page.locator('.flow-node', { has: page.locator('.flow-step-title', { hasText: REAPER }) }).first();
  await reaper.getByRole('button', { name: /More actions for step 3/ }).click();
  await page.getByRole('menuitem', { name: 'Connect to another step…' }).click();
  await page.getByRole('menuitem', { name: `2. ${READ}` }).click();
  await expect(page.locator('.flow-extra-edge')).toContainText(`loops back to step 2: ${READ}`);
  expect(await edgeList(request, id)).toEqual([`${LOGIN}>${READ}`, `${LOGIN}>${REAPER}`, `${REAPER}>${READ}`].sort());
  // Remove that connection again.
  await page.locator('.flow-extra-edge').getByRole('button', { name: /Remove the connection/ }).click();
  await expect(page.locator('.flow-extra-edge')).toHaveCount(0);
  // Move the reaper to be a branch of step 2 instead (re-parent).
  await reaper.getByRole('button', { name: /More actions for step 3/ }).click();
  await page.getByRole('menuitem', { name: 'Move to a branch of…' }).click();
  await page.getByRole('menuitem', { name: `2. ${READ}` }).click();
  await expect.poll(() => edgeList(request, id)).toEqual([`${LOGIN}>${READ}`, `${READ}>${REAPER}`].sort());
});

test('connection details describe the hop, and the map draws it', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ], [[0, 1]]);
  created.push(id);
  await open(page, id);
  await page.locator('.flow-edge').first().getByRole('button', { name: 'details' }).click();
  const panel = page.getByLabel('Connection', { exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: /Connection kind/ }).click();
  await page.getByRole('option', { name: 'Read' }).click();
  await panel.getByLabel('Protocol').fill('sql');
  await panel.getByLabel('Identity carried').fill('service');
  await panel.getByLabel('Protocol').press('Tab');
  await panel.getByLabel('Crosses a trust boundary').check();
  await panel.getByLabel('Attacker-controlled data').check();
  await expect.poll(async () => {
    const e = (await getFlow(request, id)).edges[0];
    return [e.kind, e.protocol, e.auth, e.trustBoundary, e.tainted];
  }).toEqual(['read', 'sql', 'service', true, true]);
  // The hop's chips on the outline …
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.flow-edge .flow-edge-chip')).toHaveText(['read · sql', 'auth: service', 'trust boundary', 'tainted']);
  // … and its label on the map.
  await page.locator('.flow-detail-tab-bar').getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.flow-graph-edge text')).toHaveText('read · sql');
  await page.locator('.flow-graph-edge path[role="button"]').click({ force: true });
  await expect(page.getByLabel('Connection', { exact: true })).toBeVisible();
});

test('a step records who acts there and the controls it applies', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ], [[0, 1]]);
  created.push(id);
  await open(page, id);
  const first = page.locator('.flow-step').first();
  await first.locator('.flow-step-actor').click();
  await page.keyboard.type('anonymous');
  await page.keyboard.press('Enter');
  await first.getByPlaceholder('authn, authz…').fill('rate-limit');
  await page.keyboard.press('Enter');
  await expect.poll(async () => {
    const s = (await getFlow(request, id)).steps[0];
    return [s.actor, s.controls];
  }).toEqual(['anonymous', ['rate-limit']]);
});

test('export downloads the flow as a document flows import takes back', async ({ page, request }) => {
  const id = await makeFlow(request, [LOGIN, READ], [[0, 1, { kind: 'call' }]]);
  created.push(id);
  await open(page, id);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export' }).click()]);
  const path = await download.path();
  const doc = JSON.parse(readFileSync(path!, 'utf8'));
  expect(doc.steps).toHaveLength(2);
  expect(doc.edges).toEqual([expect.objectContaining({ kind: 'call' })]);
  const copy = await request.post('/api/flows', { data: { ...doc, name: 'imported copy' } });
  expect(copy.status()).toBe(201);
  created.push((await copy.json()).id);
});
