import { test, expect, openView } from './helpers/input';

// A finding's own page (#/finding/{id}), laid out like the feature detail page: reached from a
// card's title (the card's one link to it, no separate button), and by a deep link.

test('clicking a finding card\'s title opens its detail page, under the Findings tab', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  const card = page.locator('[data-finding-id]').first();
  const id = await card.getAttribute('data-finding-id');
  const title = (await card.locator('.finding-title-link').textContent())!.trim();
  await card.locator('.finding-title-link').click();
  await expect(page).toHaveURL(new RegExp(`#/finding/${id}$`));
  await expect(page.locator('.fd-title')).toHaveText(title);
  await expect(page.locator('.tab-bar-tab', { hasText: 'Findings' })).toHaveClass(/tab-bar-tab-active/);
  // The same sections as a feature's page.
  for (const heading of ['Reconciliation', 'Comments', 'Provenance']) {
    await expect(page.locator('.fd-card-title', { hasText: heading })).toBeVisible();
  }
  await page.locator('.fd-back').click();
  await expect(page).toHaveURL(/#\/findings$/);
});

test('cards have no separate detail button; a deep link lands on the page directly', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  const card = page.locator('[data-finding-id]').first();
  const id = await card.getAttribute('data-finding-id');
  await expect(page.locator('button[title="Open detail page"]')).toHaveCount(0);
  await page.goto(`/#/finding/${id}`);
  await expect(page.locator('.fd-title')).toBeVisible();
  // The hero carries severity and status (as dropdowns), and the file it is anchored to.
  await expect(page.getByRole('button', { name: /^Severity: / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Status: / })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'File' })).not.toBeEmpty();
});

test('a feature card\'s title opens the feature\'s page, under the Features tab', async ({ page }) => {
  await openView(page, '/#/features', '[data-nav-area="features-list"]');
  const card = page.locator('[data-feature-id]').first();
  const id = await card.getAttribute('data-feature-id');
  await expect(page.locator('button[title="Open detail page"]')).toHaveCount(0);
  await card.locator('.feature-title-link').first().click();
  await expect(page).toHaveURL(new RegExp(`#/feature/${id}$`));
  await expect(page.locator('.feature-detail .fd-title')).toBeVisible();
  await expect(page.locator('.tab-bar-tab', { hasText: 'Features' })).toHaveClass(/tab-bar-tab-active/);
});

test('an unknown finding id says so, with a way back', async ({ page }) => {
  await page.goto('/#/finding/does-not-exist');
  await expect(page.locator('.feature-detail .empty-state')).toContainText(/not found/i);
  await expect(page.locator('.fd-back')).toHaveText('← Findings');
});

// Like the flow page: every field is editable in place and saves when left; a reload shows it.
test('the finding page is editable in place and saves as you go', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  const id = await page.locator('[data-finding-id]').first().getAttribute('data-finding-id');
  const original = await (await page.request.get(`/api/findings/${id}`)).json();
  await page.goto(`/#/finding/${id}`);
  await expect(page.locator('.fd-title')).toBeVisible();

  // Title: click, type, Enter.
  await page.getByRole('textbox', { name: 'Title' }).click();
  const title = page.locator('.fd-title input');
  await title.fill('Edited finding title');
  await title.press('Enter');
  await expect(page.locator('.save-indicator--saved')).toBeVisible();

  // Severity through the dropdown; CWE inline; description multi-line (saved on blur).
  await page.getByRole('button', { name: /^Severity: / }).click();
  await page.getByRole('option', { name: 'Low' }).click();
  await page.getByRole('textbox', { name: 'CWE' }).click();
  await page.locator('input[aria-label="CWE"]').fill('CWE-79');
  await page.locator('input[aria-label="CWE"]').press('Enter');
  await page.getByRole('textbox', { name: 'Description' }).click();
  await page.locator('textarea[aria-label="Description"]').fill('Edited on the detail page.');
  await page.locator('.fd-title').click(); // blur saves
  await expect(page.locator('.save-indicator--saved')).toBeVisible();

  await page.reload();
  await expect(page.locator('.fd-title')).toHaveText('Edited finding title');
  await expect(page.getByRole('button', { name: /^Severity: / })).toHaveText(/Low/);
  await expect(page.getByRole('textbox', { name: 'CWE' })).toHaveText('CWE-79');
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveText('Edited on the detail page.');
  // Leave the shared fixture as it was.
  await page.request.patch(`/api/findings/${id}`, { data: { title: original.title, severity: original.severity, cwe: original.cwe, description: original.description } });
});

test('the feature page is editable in place: title, kind, tags and parameters', async ({ page }) => {
  await openView(page, '/#/features', '[data-nav-area="features-list"]');
  const id = await page.locator('[data-feature-id]').first().getAttribute('data-feature-id');
  const original = await (await page.request.get(`/api/features/${id}`)).json();
  await page.goto(`/#/feature/${id}`);
  await expect(page.locator('.fd-title')).toBeVisible();

  await page.getByRole('textbox', { name: 'Title' }).click();
  await page.locator('.fd-title input').fill('Edited feature title');
  await page.locator('.fd-title input').press('Enter');
  await page.getByRole('button', { name: /^Kind: / }).click();
  await page.getByRole('option', { name: 'Interface' }).click();
  // An interface's method is the coloured badge before the title, as on the list card.
  await page.getByRole('textbox', { name: 'Method' }).click();
  await page.locator('input[aria-label="Method"]').fill('post');
  await page.locator('input[aria-label="Method"]').press('Enter');
  await expect(page.locator('.fd-title-row .feature-method-badge')).toHaveText('POST');
  // Interfaces have parameters: add one and name it.
  await page.locator('.fd-card-title', { hasText: 'Parameters' }).getByRole('button', { name: '+ Add' }).click();
  await page.getByRole('textbox', { name: 'Parameter name' }).last().click();
  await page.locator('input[aria-label="Parameter name"]').fill('token');
  await page.locator('input[aria-label="Parameter name"]').press('Enter');
  await expect(page.locator('.save-indicator--saved')).toBeVisible();

  await page.reload();
  await expect(page.locator('.fd-title')).toHaveText('Edited feature title');
  await expect(page.getByRole('button', { name: /^Kind: / })).toHaveText(/Interface/);
  await expect(page.locator('.fd-title-row .feature-method-badge')).toHaveText('POST');
  await expect(page.getByRole('textbox', { name: 'Parameter name' }).first()).toHaveText('token');
  // Leave the shared fixture as it was.
  await page.request.patch(`/api/features/${id}`, { data: { title: original.title, kind: original.kind, operation: original.operation ?? '', parameters: original.parameters ?? [] } });
});

test('a comment can be added from the finding page, and it stays', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  // The last finding: other specs open the first card's latest comment.
  const id = await page.locator('[data-finding-id]').last().getAttribute('data-finding-id');
  await page.goto(`/#/finding/${id}`);
  const box = page.getByRole('textbox', { name: 'Reply' });
  await box.fill('Replying from the detail page');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.locator('.finding-comment-text', { hasText: 'Replying from the detail page' })).toBeVisible();
  await expect(box).toHaveValue('');
  await page.reload();
  await expect(page.locator('.finding-comment-text', { hasText: 'Replying from the detail page' })).toBeVisible();
  // Leave the shared fixture as it was.
  const comments = await (await page.request.get(`/api/comments?findingId=${id}`)).json() as { id: string; text: string }[];
  for (const c of comments.filter((x) => x.text === 'Replying from the detail page')) await page.request.delete(`/api/comments/${c.id}`);
});
