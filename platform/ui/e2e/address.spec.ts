import { test, expect } from './helpers/input';

// Filters, options and searches live in the address (bench's query-state.ts): a link opens the
// page as it was, changes show in the address at once, a reload keeps them, and a bare address
// takes the page's remembered choices.

test('the service map: a link sets every filter and option; changes go back into the address', async ({ page }) => {
  await page.goto('/map?hide=beta&connections=call,next&show=all&fields=protocol&q=login');
  await expect(page.locator('.smap-card[data-service="alpha"]')).toBeVisible();
  await expect(page.locator('.smap-card[data-service="beta"]')).toHaveCount(0);
  const filters = page.getByRole('group', { name: 'Service map filters' });
  await expect(filters.getByRole('button', { name: 'Services (1)' })).toBeVisible();
  await expect(filters.getByRole('button', { name: 'Connections (2)' })).toBeVisible();
  await expect(filters.getByRole('button', { name: 'Features shown' })).toHaveText(/All features/);
  await expect(page.getByRole('searchbox', { name: 'Find a feature or service' })).toHaveValue('login');
  await page.getByRole('button', { name: 'Display' }).click();
  await expect(page.getByLabel('Protocol')).toBeChecked();
  await expect(page.getByLabel('Operation (method and path)')).not.toBeChecked();
  await page.keyboard.press('Escape');

  // Reset clears the filters (not the search or the display options), and the address follows.
  await filters.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page).toHaveURL(/\/map\?fields=protocol&q=login$/);
  await expect(page.locator('.smap-card[data-service="beta"]')).toBeVisible();
});

test('the service map: a bare /map takes the last filters, and shows them in the address', async ({ page }) => {
  await page.goto('/map');
  await page.getByRole('group', { name: 'Service map filters' }).getByRole('button', { name: 'Services' }).click();
  await page.getByRole('option', { name: 'beta', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/map\?hide=beta$/);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /Projects/ }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /Map/ }).click();
  await expect(page).toHaveURL(/\/map\?hide=beta$/);
  await expect(page.locator('.smap-card[data-service="beta"]')).toHaveCount(0);
  // A link is the whole state: one that names any filter doesn't pick up the remembered ones.
  await page.goto('/map?show=all');
  await expect(page.locator('.smap-card[data-service="beta"]')).toBeVisible();
  await page.goto('/map?hide=');
  await expect(page.locator('.smap-card[data-service="beta"]')).toBeVisible();
});

test('flows: the search, filters, sort and layout are in the address', async ({ page }) => {
  await page.goto('/flows?q=status:active&sort=name&order=asc&layout=table');
  await expect(page.locator('.flows-table-row').first()).toBeVisible();
  await expect(page.locator('.flows-search input')).toHaveValue('status:active');
  await expect(page.getByRole('button', { name: 'Name, ascending' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/flows\?q=status:active&sort=name&order=asc$/);
  await page.locator('.flows-search input').fill('login');
  await expect(page).toHaveURL(/\/flows\?q=login&sort=name&order=asc$/);
  await page.reload();
  await expect(page.locator('.flows-search input')).toHaveValue('login');
});

test('projects: the sort is in the address', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\?sort=findings&order=desc$/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Findings, descending' })).toHaveAttribute('aria-pressed', 'true');
});

test('the workbench: the findings filters and search ride after the hash route', async ({ page }) => {
  await page.goto('/p/alpha#/findings?severity=high');
  const cards = page.locator('[data-finding-id]');
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Severity \(1\)/ })).toBeVisible();

  // The old path form still lands, rewritten to the query.
  await page.goto('/p/alpha#/findings/severity/medium');
  await expect(page).toHaveURL(/#\/findings\?severity=medium$/);
  await expect(cards).toHaveCount(1);

  await page.locator('.findings-view .annotation-search-input').fill('zzz-nothing');
  await expect(page).toHaveURL(/#\/findings\?severity=medium&q=zzz-nothing$/);
  await expect(cards).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.findings-view .annotation-search-input')).toHaveValue('zzz-nothing');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page).toHaveURL(/#\/findings$/);
  await expect(cards).toHaveCount(3);
});

test('the workbench: the features tab and sort are in the address; the activity filters too', async ({ page }) => {
  await page.goto('/p/alpha#/features?tab=dataflows');
  const tab = (name: string) => page.locator('.features-view .activity-kind-toggle', { hasText: name });
  await expect(tab('Data Flows')).toHaveClass(/activity-kind-toggle-active/);
  await tab('Interfaces').click();
  await expect(page).toHaveURL(/#\/features$/);
  await page.locator('.features-sort-btn', { hasText: 'File' }).click();
  await expect(page).toHaveURL(/#\/features\?sort=file$/);

  await page.goto('/p/alpha#/delta?kinds=comment');
  const kind = (name: string) => page.locator('.activity-kind-toggle', { hasText: name });
  await expect(kind('Comments')).toHaveClass(/activity-kind-toggle-active/);
  await expect(kind('Git Events')).not.toHaveClass(/activity-kind-toggle-active/);
  await kind('Git Events').click();
  await expect(page).toHaveURL(/#\/delta\?kinds=comment,merge$/);
});
