import { test, expect } from './helpers/input';
import type { APIRequestContext } from '@playwright/test';

// A trust zone on each project's service profile: a flow hop between features in different
// zones crosses a trust boundary without anyone marking it, on the flow page, its connection
// panel and the service map; a feature's zone:<name> tag places it in another zone.

type Feature = { id: string; title: string; tags: string[] };
const login = async (request: APIRequestContext, slug: string) =>
  ((await (await request.get(`/api/projects/${slug}/features`)).json()) as Feature[]).find((f) => f.title === 'POST /login')!;

let flowId = '';
test.beforeEach(async ({ request }) => {
  const [a, b] = [await login(request, 'alpha'), await login(request, 'beta')];
  const r = await request.post('/api/flows', {
    data: {
      name: `zones e2e ${Math.random().toString(36).slice(2, 7)}`,
      steps: [{ clientId: 'a', projectSlug: 'alpha', featureId: a.id }, { clientId: 'b', projectSlug: 'beta', featureId: b.id }],
      edges: [{ from: 'a', to: 'b', kind: 'call', protocol: 'http' }],
    },
  });
  flowId = (await r.json()).id;
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/flows/${flowId}`);
  for (const slug of ['alpha', 'beta']) await request.patch(`/api/projects/${slug}/profile`, { data: { trustZone: '' } });
  const b = await login(request, 'beta');
  await request.patch(`/api/projects/beta/features/${b.id}`, { data: { tags: b.tags.filter((t) => !t.startsWith('zone:')) } });
});

test('zones set on the profile page make a hop between them a trust boundary', async ({ page, request }) => {
  // alpha's zone through its Profile page, beta's through the API.
  await page.goto('/p/alpha#/profile');
  await page.getByLabel('Trust zone').fill('public-edge');
  await expect.poll(async () => (await (await request.get('/api/projects/alpha/profile')).json()).trustZone).toBe('public-edge');
  await request.patch('/api/projects/beta/profile', { data: { trustZone: 'core' } });

  await page.goto(`/flows/${flowId}`);
  const edge = page.locator('.flow-edge').first();
  await expect(edge.locator('.flow-edge-chip', { hasText: 'trust boundary' })).toHaveAttribute('title', 'The two ends sit in different trust zones');
  await edge.getByRole('button', { name: 'details' }).click();
  const panel = page.getByLabel('Connection', { exact: true });
  await expect(panel.locator('.map-edge-zones')).toHaveText('Crosses trust zones: public-edge → core');
  await expect(panel.getByLabel(/Also mark as a trust boundary/)).not.toBeChecked();

  // The map: each card names its zone, and the connection is marked as crossing.
  await page.goto('/map?show=connected');
  await expect(page.locator('[data-service="alpha"] [aria-label="Trust zone public-edge"]')).toBeVisible();
  await expect(page.locator('[data-service="beta"] [aria-label="Trust zone core"]')).toBeVisible();
  await page.locator('.smap-link').first().locator('path[role="button"]').click({ force: true });
  await expect(page.locator('.smap-panel')).toContainText('crosses trust zones: public-edge → core');
});

test('a feature tagged zone:<name> sits in that zone instead of its project\'s', async ({ page, request }) => {
  await request.patch('/api/projects/alpha/profile', { data: { trustZone: 'public-edge' } });
  await request.patch('/api/projects/beta/profile', { data: { trustZone: 'core' } });
  const b = await login(request, 'beta');
  await request.patch(`/api/projects/beta/features/${b.id}`, { data: { tags: [...b.tags, 'zone:public-edge'] } });

  await page.goto(`/flows/${flowId}`);
  const edge = page.locator('.flow-edge').first();
  // The hop's chips have rendered (its kind), and none says it crosses a boundary.
  await expect(edge.locator('.flow-edge-chip', { hasText: 'call · http' })).toBeVisible();
  await expect(edge.locator('.flow-edge-chip', { hasText: 'trust boundary' })).toHaveCount(0);
  await expect(page.locator('.flow-step').nth(1).locator('.flow-step-title')).toHaveText('POST /login');
});
