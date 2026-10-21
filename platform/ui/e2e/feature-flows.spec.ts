import { test, expect } from './helpers/input';

// The workbench feature page, inside the platform, lists the documented flows that walk through
// the feature ("Used in flows", a host-supplied card under Provenance).

test('a feature page lists its flows with the step number and role, and links to the flow', async ({ page, request }) => {
  const flows = (await (await request.get('/api/flows?limit=200')).json()).items as
    { id: string; name: string; shape: { id: string; position: number; projectSlug: string; featureId: string }[]; shapeEdges: [string, string][] }[];
  const login = flows.find((f) => f.name === 'Login path')!;
  const root = login.shape.find((n) => !login.shapeEdges.some(([, to]) => to === n.id))!; // step 1, the entry point
  const users = flows.filter((f) => f.shape.some((n) => n.projectSlug === root.projectSlug && n.featureId === root.featureId));

  await page.goto(`/p/${root.projectSlug}#/feature/${root.featureId}`);
  const card = page.locator('.fd-side .ff-card');
  await expect(card.locator('.fd-card-title')).toContainText('Used in flows');
  await expect(card.locator('.fd-count')).toHaveText(String(users.length));
  // It sits under Provenance.
  const titles = await page.locator('.fd-side .fd-card-title').allTextContents();
  expect(titles[0]).toMatch(/Provenance/);
  expect(titles[1]).toMatch(/Used in flows/);

  const row = card.locator('.ff-row', { hasText: 'Login path' });
  await expect(row.locator('.ff-name')).toHaveText('Login path, step 1');
  await expect(row.locator('.ff-meta')).toContainText(`of ${login.shape.length}`);
  await expect(row.locator('.ff-meta')).toContainText('entry point');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/flows/${login.id}$`));
});

test('a feature no flow uses says so', async ({ page, request }) => {
  const flows = (await (await request.get('/api/flows?limit=200')).json()).items as { shape: { projectSlug: string; featureId: string }[] }[];
  const used = new Set(flows.flatMap((f) => f.shape.map((n) => `${n.projectSlug}:${n.featureId}`)));
  const feats = (await (await request.get('/api/projects/beta/features')).json()) as { id: string }[];
  const unused = feats.find((f) => !used.has(`beta:${f.id}`));
  test.skip(!unused, 'every beta feature is on a flow in this fixture');
  await page.goto(`/p/beta#/feature/${unused!.id}`);
  await expect(page.locator('.ff-card')).toContainText('Not on any documented flow yet.');
});
