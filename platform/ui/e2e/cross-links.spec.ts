import { test, expect } from './helpers/input';
import type { APIRequestContext } from '@playwright/test';

// On one server a feature can link to another project's feature, and a finding affect one:
// "<project>:<id>" where an id would go. Both ends show the link, labelled with the project,
// and it opens there; the link picker searches every project.

async function features(request: APIRequestContext, slug: string) {
  return await (await request.get(`/api/projects/${slug}/features`)).json() as { id: string; title: string; linkedFeatures: { id: string }[] }[];
}
const login = async (request: APIRequestContext, slug: string) => (await features(request, slug)).find((f) => f.title === 'POST /login')!;

test('a link to another project\'s feature shows on both pages, labelled, and opens there', async ({ page, request }) => {
  const a = await login(request, 'alpha');
  const b = await login(request, 'beta');
  const before = a.linkedFeatures;
  await request.patch(`/api/projects/alpha/features/${a.id}`, { data: { linkedFeatures: [...before, { project: 'beta', id: b.id, description: 'hands the session on' }] } });
  try {
    await page.goto(`/p/alpha#/feature/${a.id}`);
    const links = page.locator('.fd-card', { has: page.locator('.fd-card-title', { hasText: /^Links/ }) });
    const item = links.locator('.fd-linked-item', { hasText: 'beta' });
    await expect(item.locator('.fd-linked-project')).toHaveText('beta');
    await expect(item).toContainText('POST /login');
    await expect(item).toContainText('hands the session on');
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/p/beta#/feature/${b.id}$`));
    // beta's page shows the link back to alpha.
    const back = page.locator('.fd-card', { has: page.locator('.fd-card-title', { hasText: /^Links/ }) }).locator('.fd-linked-item', { hasText: 'alpha' });
    await expect(back.locator('.fd-linked-project')).toHaveText('alpha');
  } finally {
    await request.patch(`/api/projects/alpha/features/${a.id}`, { data: { linkedFeatures: before } });
  }
});

test('the link picker offers other projects\' features, and linking one saves it', async ({ page, request }) => {
  const a = await login(request, 'alpha');
  const b = await login(request, 'beta');
  const before = a.linkedFeatures;
  try {
    await page.goto(`/p/alpha#/feature/${a.id}`);
    await page.locator('.fd-card', { has: page.locator('.fd-card-title', { hasText: /^Links/ }) }).getByRole('button', { name: 'Edit' }).click();
    await page.locator('.link-manage-search-input').fill('login');
    const other = page.locator('.link-manage-result-card', { has: page.locator('.link-manage-result-project', { hasText: 'beta' }) });
    await expect(other.first()).toBeVisible();
    await other.first().click();
    await expect.poll(async () => (await features(request, 'beta')).find((f) => f.id === b.id)!.linkedFeatures.map((l) => l.id)).toContain(`alpha:${a.id}`);
  } finally {
    await request.patch(`/api/projects/alpha/features/${a.id}`, { data: { linkedFeatures: before } });
  }
});

test('a finding that affects another project\'s feature is listed on that feature\'s page', async ({ page, request }) => {
  const b = await login(request, 'beta');
  const [f0] = await (await request.get('/api/projects/alpha/findings')).json() as { anchor: unknown }[];
  const f = await (await request.post('/api/projects/alpha/findings', {
    data: { anchor: f0.anchor, severity: 'high', title: 'cross-project session reuse', description: 'x', status: 'open', source: 'manual', features: [`beta:${b.id}`] },
  })).json() as { id: string };
  try {
    await page.goto(`/p/beta#/feature/${b.id}`);
    const card = page.locator('.fd-findings-card');
    const row = card.locator('.fd-finding-row', { hasText: 'cross-project session reuse' });
    await expect(row.locator('.fd-linked-project')).toHaveText('alpha');
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/p/alpha#/finding/${f.id}$`));
    // And the finding's own page lists the feature, labelled with its project.
    const item = page.locator('.fd-linked-item', { hasText: 'POST /login' });
    await expect(item.locator('.fd-linked-project')).toHaveText('beta');
  } finally {
    await request.delete(`/api/projects/alpha/findings/${f.id}`);
  }
});
