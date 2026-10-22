import { test, expect } from './helpers/input';
import type { APIRequestContext } from '@playwright/test';

// Feature links and flows, joined up: a hop between projects that no feature link backs is
// marked, and one click links the two features; while building a flow, the features linked to
// the previous step come first in the picker; and the service map draws the links no flow
// covers yet.

type Feature = { id: string; title: string; linkedFeatures: { id: string; description?: string }[] };
const feature = async (request: APIRequestContext, slug: string, title: string) =>
  ((await (await request.get(`/api/projects/${slug}/features`)).json()) as Feature[]).find((f) => f.title === title)!;

const LOGIN = 'POST /login';
const READ = 'sqlite://users.db (read)';

const created: string[] = [];
let restore: (() => Promise<unknown>) | null = null;
test.afterEach(async ({ request }) => {
  while (created.length) await request.delete(`/api/flows/${created.pop()}`);
  await restore?.();
  restore = null;
});

/** Keep alpha's login links as they are once the test is done. */
async function keepLinks(request: APIRequestContext) {
  const a = await feature(request, 'alpha', LOGIN);
  restore = () => request.patch(`/api/projects/alpha/features/${a.id}`, { data: { linkedFeatures: a.linkedFeatures } });
  return a;
}

test('a hop between projects with no feature link is marked, and one click links them', async ({ page, request }) => {
  const a = await keepLinks(request);
  const b = await feature(request, 'beta', LOGIN);
  const r = await request.post('/api/flows', {
    data: {
      name: `links e2e ${Math.random().toString(36).slice(2, 7)}`,
      steps: [{ clientId: 'a', projectSlug: 'alpha', featureId: a.id }, { clientId: 'b', projectSlug: 'beta', featureId: b.id }],
      edges: [{ from: 'a', to: 'b', kind: 'call', description: 'posts credentials' }],
    },
  });
  created.push((await r.json()).id);

  await page.goto(`/flows/${created[0]}`);
  const edge = page.locator('.flow-edge').first();
  await expect(edge.locator('.flow-edge-chip', { hasText: 'unlinked' })).toBeVisible();
  await edge.getByRole('button', { name: 'details' }).click();
  const panel = page.getByLabel('Connection', { exact: true });
  await expect(panel.locator('.map-edge-unlinked')).toContainText("the two features aren't linked");
  await panel.getByRole('button', { name: 'Link the features' }).click();
  await expect(panel.locator('.map-edge-linked')).toHaveText('A feature link backs this hop.');
  await expect(edge.locator('.flow-edge-chip', { hasText: 'unlinked' })).toHaveCount(0);
  // The link is the feature's own, with the hop's label as its description.
  const after = await feature(request, 'alpha', LOGIN);
  expect(after.linkedFeatures).toContainEqual({ id: `beta:${b.id}`, description: 'posts credentials' });
});

test('the step picker puts the features linked to the previous step first', async ({ page, request }) => {
  const a = await keepLinks(request);
  const read = await feature(request, 'beta', READ);
  await request.patch(`/api/projects/alpha/features/${a.id}`, { data: { linkedFeatures: [...a.linkedFeatures, { id: `beta:${read.id}`, description: 'reads the user row' }] } });
  const r = await request.post('/api/flows', {
    data: { name: `suggest e2e ${Math.random().toString(36).slice(2, 7)}`, steps: [{ clientId: 'a', projectSlug: 'alpha', featureId: a.id }], edges: [] },
  });
  created.push((await r.json()).id);

  await page.goto(`/flows/${created[0]}`);
  await page.getByRole('button', { name: '+ continue this path' }).click();
  const picker = page.getByRole('complementary', { name: 'Insert step' });
  const group = picker.getByLabel('Linked to this step');
  await expect(group.locator('.flow-picker-group-label').first()).toHaveText("Linked to this step's feature");
  const suggestion = group.locator('.flow-picker-result').first();
  await expect(suggestion).toContainText('beta');
  await expect(suggestion).toContainText(READ);
  await expect(suggestion.locator('.flow-picker-result-desc')).toHaveText('reads the user row');
  await suggestion.click();
  await expect(page.locator('.flow-step')).toHaveCount(2);
  await expect(page.locator('.flow-step').nth(1)).toContainText(READ);
  // A search hides the suggestions: the results are the search's.
  await page.getByRole('button', { name: '+ continue this path' }).click();
  await picker.getByPlaceholder(/Search features/).fill('reaper');
  await expect(picker.getByLabel('Linked to this step')).toHaveCount(0);
});

test('the service map draws feature links no flow covers, and lists them on the feature', async ({ page, request }) => {
  const a = await keepLinks(request);
  const reaper = await feature(request, 'beta', 'session reaper');
  await request.patch(`/api/projects/alpha/features/${a.id}`, { data: { linkedFeatures: [...a.linkedFeatures, { id: `beta:${reaper.id}` }] } });

  await page.goto('/map?show=connected');
  const key = `alpha:${a.id}~beta:${reaper.id}`;
  await expect(page.locator(`.smap-feature-link[data-link="${key}"]`)).toHaveCount(1);
  await expect(page.locator('.smap-legend')).toContainText('Feature link, not on a flow');
  await expect(page.locator('.smap-summary')).toContainText('1 link not on a flow');
  // Drawn even with "connected features" only: the linked reaper stays on beta's card.
  await page.locator(`[data-feature="alpha:${a.id}"]`).click();
  const linked = page.locator('.smap-panel').getByLabel('Linked features');
  await expect(linked).toContainText('session reaper');
  await expect(linked).toContainText('not on a flow');
  // Display → off.
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByLabel('Feature links no flow covers').uncheck();
  await expect(page.locator('.smap-feature-link')).toHaveCount(0);
  await expect(page).toHaveURL(/links=0|links=false/);
});
