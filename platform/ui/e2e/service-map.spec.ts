import { test, expect } from './helpers/input';

// The service map (rail → Map): services from the projects, the connections the seeded
// "Cross project" flow records between them (alpha calls beta across a trust boundary), the
// filter dropdowns, the Display menu, the key, and the detail panel.

// Start each test from the default filters (once: a reload within the test keeps them).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('smap-reset')) { localStorage.removeItem('service-map-query'); sessionStorage.setItem('smap-reset', '1'); }
    } catch { /* storage unavailable */ }
  });
});

test('the rail opens the service map, with each project as a service', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /Map/ }).click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole('heading', { name: 'Service map', level: 2 })).toBeVisible();
  await expect(page.locator('.smap-card[data-service="alpha"]')).toBeVisible();
  await expect(page.locator('.smap-card[data-service="beta"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /Map/ })).toHaveAttribute('aria-current', 'page');
});

test('the cross-project call is drawn feature to feature', async ({ page }) => {
  await page.goto('/map');
  const link = page.locator('.smap-link[data-connection^="alpha:"][data-connection*=">beta:"][data-connection*=":call:"]');
  await expect(link).toHaveCount(1);
  // The key names what's drawn.
  await expect(page.getByLabel('Key')).toContainText('Call');
  await expect(page.getByLabel('Key')).toContainText('Trust boundary');
  // beta's internal read is hidden until asked for.
  await expect(page.locator('.smap-link[data-connection*=":read:"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByLabel('Connections within a service').check();
  await expect(page.locator('.smap-link[data-connection*=":read:"]')).toHaveCount(1);
});

test('filters hide connection kinds, services and feature kinds, and are remembered', async ({ page }) => {
  await page.goto('/map');
  const call = page.locator('.smap-link[data-connection*=":call:"]');
  await expect(call).toHaveCount(1);
  const filters = page.getByRole('group', { name: 'Service map filters' });
  const reset = filters.getByRole('button', { name: 'Reset filters' });
  await filters.getByRole('button', { name: 'Connections' }).click();
  const callOption = page.getByRole('option', { name: /^Call/ });
  await callOption.click();
  await expect(callOption).toHaveAttribute('aria-selected', 'false');
  await expect(filters.getByRole('button', { name: 'Connections (5)' })).toBeVisible();
  await expect(call).toHaveCount(0);
  await callOption.click();
  await expect(call).toHaveCount(1);
  await page.keyboard.press('Escape');

  await filters.getByRole('button', { name: 'Services' }).click();
  await page.getByRole('option', { name: 'beta', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.smap-card[data-service="beta"]')).toHaveCount(0);
  await expect(call).toHaveCount(0);
  await expect(reset).toHaveClass(/activity-filter-clear-visible/);

  // Remembered across a reload.
  await page.reload();
  await expect(page.locator('.smap-card[data-service="alpha"]')).toBeVisible();
  await expect(page.locator('.smap-card[data-service="beta"]')).toHaveCount(0);
  await filters.getByRole('button', { name: /^Services \(\d\)/ }).click();
  await expect(page.getByRole('option', { name: 'beta', exact: true })).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Escape');

  // Reset brings everything back.
  await reset.click();
  await expect(page.locator('.smap-card[data-service="beta"]')).toBeVisible();
  await expect(call).toHaveCount(1);
});

test('features shown: on flows by default, all on request; fields can be turned off', async ({ page }) => {
  await page.goto('/map');
  // beta has four features, two of them on a flow.
  const betaRows = page.locator('.smap-card[data-service="beta"] .smap-feature');
  await expect(betaRows).toHaveCount(2);
  await page.getByRole('button', { name: /Features shown/ }).click();
  await page.getByRole('option', { name: 'All features' }).click();
  await expect(betaRows).toHaveCount(4);
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByLabel('Operation (method and path)').uncheck();
  await expect(page.locator('.smap-card[data-service="alpha"] .smap-feature', { hasText: 'POST /login' })).toBeVisible();
});

test('clicking a feature previews it: badges, description, connections, flows; a flow opens', async ({ page }) => {
  await page.goto('/map');
  await page.locator('.smap-feature[data-feature^="beta:"]', { hasText: '/login' }).first().click();
  const panel = page.getByRole('complementary', { name: /login/ });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.smap-p-title .feature-method-badge')).toHaveText('POST');
  await expect(panel.locator('.smap-p-head .select-tinted')).toHaveText(['Interface']);
  // The connection is a row naming the feature at the other end; it selects that connection.
  const row = panel.getByRole('button', { name: /call from alpha POST \/login/ });
  await expect(row).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Flow Cross project' })).toBeVisible();
  await panel.getByRole('button', { name: 'Flow Cross project' }).click();
  await expect(page).toHaveURL(/\/flows\//);
  await expect(page.getByRole('textbox', { name: 'Flow name' })).toHaveText('Cross project');
});

test('a connection shows what it carries', async ({ page }) => {
  await page.goto('/map');
  // Under load the map may still be laying out: wait for the line, then click it.
  const hit = page.locator('.smap-link[data-connection*=":call:"] path[role="button"]');
  await expect(hit).toHaveCount(1);
  await hit.click({ force: true });
  await expect(page.getByRole('complementary', { name: 'Connection' })).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Connection' });
  await expect(panel.locator('.smap-p-title')).toContainText('Call');
  await expect(panel.locator('.search-card-tag', { hasText: 'user' })).toBeVisible();
  await expect(panel.locator('.smap-p-flag', { hasText: 'crosses a trust boundary' })).toBeVisible();
  await expect(panel.locator('.smap-p-flag', { hasText: 'tainted data' })).toBeVisible();
  // Each end is a row that selects its feature.
  await panel.getByRole('button', { name: /^beta / }).click();
  await expect(page.getByRole('complementary', { name: /login/ })).toBeVisible();
});

test('a feature\'s open findings are listed in its panel, and open the finding', async ({ page, request }) => {
  const features = await (await request.get('/api/projects/beta/features')).json() as { id: string; title: string }[];
  const login = features.find((f) => f.title.includes('/login'))!;
  const [f0] = await (await request.get('/api/projects/beta/findings')).json() as { anchor: unknown }[];
  const f = await (await request.post('/api/projects/beta/findings', {
    data: { anchor: f0.anchor, severity: 'high', title: 'map panel finding', description: 'x', status: 'open', source: 'manual', features: [login.id] },
  })).json() as { id: string };
  try {
    await page.goto('/map');
    await page.locator(`.smap-feature[data-feature="beta:${login.id}"]`).click();
    const panel = page.getByRole('complementary', { name: /login/ });
    await expect(panel.locator('.smap-p-head .search-card-flag')).toHaveText(/open finding/);
    const item = panel.getByRole('button', { name: 'Finding map panel finding' });
    await expect(item).toBeVisible();
    await expect(item.locator('.select-tinted')).toHaveText('High');
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/p/beta#/finding/${f.id}$`));
  } finally {
    await request.delete(`/api/projects/beta/findings/${f.id}`);
  }
});

test('a service with many features lists a dozen, and "+N more" opens the rest', async ({ page }) => {
  // The map draws whatever the server sends: forty features on one service is enough to fold.
  await page.route('**/api/service-map*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const beta = body.services.find((s: { slug: string }) => s.slug === 'beta');
    beta.features = [...beta.features, ...Array.from({ length: 40 }, (_, i) => ({ id: `extra${i}`, kind: 'interface', title: `/extra/${i}`, tags: [], openFindings: 0, flowCount: 1, flows: [] }))];
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/map');
  const card = page.locator('.smap-card[data-service="beta"]');
  await expect(card.locator('.smap-feature')).toHaveCount(12);
  const more = card.getByRole('button', { name: /^Show \d+ more features of beta$/ });
  await more.click();
  await expect(card.locator('.smap-feature').first()).toBeVisible();
  expect(await card.locator('.smap-feature').count()).toBeGreaterThan(40);
  // Expanded, the row sits below the visible canvas (panned, not scrolled): activate it in place.
  await card.getByRole('button', { name: 'Show fewer features of beta' }).dispatchEvent('click');
  await expect(card.locator('.smap-feature')).toHaveCount(12);
});
