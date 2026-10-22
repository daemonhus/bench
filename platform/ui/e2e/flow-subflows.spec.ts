import { test, expect } from './helpers/input';
import type { APIRequestContext } from '@playwright/test';

// A subflow step slots a whole flow into another as one block: added from the step picker's
// Flows tab, drawn as a stacked card in the outline and on the flow's map, opening the flow it
// stands for; that flow lists where it's used, and a flow can't end up containing itself.

type Feature = { id: string; title: string };

async function makeFlow(request: APIRequestContext, name: string, titles: string[]): Promise<string> {
  const feats: Feature[] = await (await request.get('/api/projects/alpha/features')).json();
  const id = (t: string) => feats.find((f) => f.title === t)!.id;
  const r = await request.post('/api/flows', {
    data: {
      name,
      steps: titles.map((t, i) => ({ clientId: String(i), projectSlug: 'alpha', featureId: id(t) })),
      edges: titles.slice(1).map((_, i) => ({ from: String(i), to: String(i + 1) })),
    },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id;
}

const created: string[] = [];
test.afterEach(async ({ request }) => {
  while (created.length) await request.delete(`/api/flows/${created.pop()}`);
});

test('a flow slots into another as one subflow step, and opens from there', async ({ page, request }) => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const shared = await makeFlow(request, `Shared reads ${suffix}`, ['sqlite://users.db (read)', 'sqlite://users.db (write)']);
  const outer = await makeFlow(request, `Outer ${suffix}`, ['POST /login', 'session reaper']);
  created.push(outer, shared);

  await page.goto(`/flows/${outer}`);
  await page.locator('.flow-edge').first().getByRole('button', { name: '+ insert step' }).click();
  const picker = page.getByRole('complementary', { name: 'Insert step' });
  await picker.getByRole('button', { name: 'Flows' }).click();
  await picker.getByPlaceholder('Search flows…').fill(`Shared reads ${suffix}`);
  await picker.locator('.flow-picker-result', { hasText: `Shared reads ${suffix}` }).click();
  await expect(picker).toBeHidden();

  // The outline: login, the subflow, the reaper, joined up.
  const sub = page.locator('.flow-step--subflow');
  await expect(page.locator('.flow-step')).toHaveCount(3);
  await expect(sub.locator('.flow-step-kind--subflow')).toHaveText('⧉ subflow');
  await expect(sub.locator('.flow-step-title')).toHaveText(`Shared reads ${suffix}`);
  await expect(sub.locator('.flow-step-subflow-count')).toHaveText('2 steps · draft');
  const flow = await (await request.get(`/api/flows/${outer}`)).json() as { steps: { id: string; subflowId?: string }[]; edges: { fromStepId: string; toStepId: string }[] };
  const subStep = flow.steps.find((s) => s.subflowId === shared)!;
  expect(flow.edges.filter((e) => e.fromStepId === subStep.id || e.toStepId === subStep.id)).toHaveLength(2);

  // On the map it's a block of its own, with a panel that opens the flow.
  await page.locator('.flow-detail-tab-bar').getByRole('button', { name: 'Map' }).click();
  await page.locator('.flow-graph-node', { has: page.locator('text=SUBFLOW') }).first().click();
  const panel = page.getByLabel('Subflow', { exact: true });
  await expect(panel).toContainText(`Shared reads ${suffix}`);
  await expect(panel).toContainText('2 steps · draft');
  await panel.getByRole('button', { name: 'Open flow' }).click();
  await expect(page).toHaveURL(new RegExp(`/flows/${shared}$`));

  // The shared flow says where it's used, and links back.
  const usedIn = page.locator('.flow-detail-attr', { hasText: 'Used in' });
  await expect(usedIn.getByRole('button', { name: `Outer ${suffix}` })).toBeVisible();
  await usedIn.getByRole('button', { name: `Outer ${suffix}` }).click();
  await expect(page).toHaveURL(new RegExp(`/flows/${outer}$`));
  await page.locator('.flow-step--subflow').getByRole('button', { name: /Open the flow/ }).click();
  await expect(page).toHaveURL(new RegExp(`/flows/${shared}$`));
});

test('a flow that contains this one is refused as its subflow, with the reason', async ({ page, request }) => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const inner = await makeFlow(request, `Inner ${suffix}`, ['POST /login']);
  const outer = await makeFlow(request, `Container ${suffix}`, ['session reaper']);
  created.push(outer, inner);
  expect((await request.post(`/api/flows/${outer}/steps`, { data: { subflowId: inner } })).status()).toBe(201);

  await page.goto(`/flows/${inner}`);
  await page.getByRole('button', { name: '+ continue this path' }).click();
  const picker = page.getByRole('complementary', { name: 'Insert step' });
  await picker.getByRole('button', { name: 'Flows' }).click();
  await picker.getByPlaceholder('Search flows…').fill(`Container ${suffix}`);
  await picker.locator('.flow-picker-result', { hasText: `Container ${suffix}` }).click();
  await expect(picker.getByRole('alert')).toContainText(`"Container ${suffix}" already contains this flow`);
  await expect(page.locator('.flow-step')).toHaveCount(1);
  // The picker never offers the flow itself.
  await picker.getByPlaceholder('Search flows…').fill(`Inner ${suffix}`);
  await expect(picker.locator('.flow-picker-empty')).toContainText('No flows match');
});
