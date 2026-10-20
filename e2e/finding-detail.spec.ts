import { test, expect, openView, api, appUrl } from './helpers/input';

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
  await page.goto(appUrl(`/#/finding/${id}`));
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
  await page.goto(appUrl('/#/finding/does-not-exist'));
  await expect(page.locator('.feature-detail .empty-state')).toContainText(/not found/i);
  await expect(page.locator('.fd-back')).toHaveText('← Findings');
});

// Like the flow page: every field is editable in place and saves when left; a reload shows it.
test('the finding page is editable in place and saves as you go', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  const id = await page.locator('[data-finding-id]').first().getAttribute('data-finding-id');
  const original = await (await page.request.get(api(`/api/findings/${id}`))).json();
  await page.goto(appUrl(`/#/finding/${id}`));
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
  await page.request.patch(api(`/api/findings/${id}`), { data: { title: original.title, severity: original.severity, cwe: original.cwe, description: original.description } });
});

test('the feature page is editable in place: title, kind, tags and parameters', async ({ page }) => {
  await openView(page, '/#/features', '[data-nav-area="features-list"]');
  const id = await page.locator('[data-feature-id]').first().getAttribute('data-feature-id');
  const original = await (await page.request.get(api(`/api/features/${id}`))).json();
  await page.goto(appUrl(`/#/feature/${id}`));
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
  await page.request.patch(api(`/api/features/${id}`), { data: { title: original.title, kind: original.kind, operation: original.operation ?? '', parameters: original.parameters ?? [] } });
});

test('a comment can be added from the finding page, and it stays', async ({ page }) => {
  await openView(page, '/#/findings', '[data-nav-area="findings-list"]');
  // The last finding: other specs open the first card's latest comment.
  const id = await page.locator('[data-finding-id]').last().getAttribute('data-finding-id');
  await page.goto(appUrl(`/#/finding/${id}`));
  const box = page.getByRole('textbox', { name: 'Reply' });
  await box.fill('Replying from the detail page');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.locator('.finding-comment-text', { hasText: 'Replying from the detail page' })).toBeVisible();
  await expect(box).toHaveValue('');
  await page.reload();
  await expect(page.locator('.finding-comment-text', { hasText: 'Replying from the detail page' })).toBeVisible();
  // Leave the shared fixture as it was.
  const comments = await (await page.request.get(api(`/api/comments?findingId=${id}`))).json() as { id: string; text: string }[];
  for (const c of comments.filter((x) => x.text === 'Replying from the detail page')) await page.request.delete(api(`/api/comments/${c.id}`));
});

test('reconciliation sits at the foot of the right-hand column on finding and feature pages', async ({ page }) => {
  for (const [list, item, link] of [
    ['/#/findings', '[data-finding-id]', '.finding-title-link'],
    ['/#/features', '[data-feature-id]', '.feature-title-link'],
  ] as const) {
    await openView(page, list, `[data-nav-area="${list.slice(3)}-list"]`);
    await page.locator(item).first().locator(link).click();
    await expect(page.locator('.fd-title')).toBeVisible();
    // Main column: comments (and a feature's parameters); the side column ends with reconciliation.
    await expect(page.locator('.fd-main .fd-card-title', { hasText: 'Reconciliation' })).toHaveCount(0);
    // (The platform shell adds its own "Used in flows" card to this column; the workbench's cards keep their order.)
    const side = (await page.locator('.fd-side > .fd-card > .fd-card-title').allTextContents()).filter((t) => !/^Used in flows/.test(t));
    expect(side[0]).toMatch(/^Provenance/);
    expect(side[side.length - 1]).toMatch(/^Reconciliation/);
    // Its rows fit the narrower column: nothing spills out of the card.
    const card = page.locator('.fd-side > .fd-card', { has: page.locator('.fd-card-title', { hasText: 'Reconciliation' }) });
    const spill = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(spill).toBeLessThanOrEqual(0);
  }
});

test('the header controls sit under the description, each with a small grey caption beside it', async ({ page }) => {
  for (const [list, item, link, labels] of [
    ['/#/findings', '[data-finding-id]', '.finding-title-link', ['Severity', 'Status', 'Category', 'Source']],
    ['/#/features', '[data-feature-id]', '.feature-title-link', ['Kind', 'Status', 'Direction']],
  ] as const) {
    await openView(page, list, `[data-nav-area="${list.slice(3)}-list"]`);
    await page.locator(item).first().locator(link).click();
    // The row sits under the description (and above a feature's tags), not above the title.
    const top = async (sel: string) => (await page.locator(`.fd-hero ${sel}`).first().boundingBox())!.y;
    expect(await top('.fd-hero-controls')).toBeGreaterThan(await top('.fd-description'));
    expect(await top('.fd-hero-controls')).toBeGreaterThan(await top('.fd-title'));
    expect(await top('.fd-hero-controls')).toBeLessThan(await top(list.includes('features') ? '.fd-tags' : '.fd-footer'));
    const fields = page.locator('.fd-hero-controls .labelled-field');
    await expect(fields.locator('.labelled-field-label')).toHaveText([...labels]);
    for (let i = 0; i < labels.length; i++) {
      const field = fields.nth(i);
      // Caption, then its control, on one line.
      const cap = (await field.locator('.labelled-field-label').boundingBox())!;
      const ctl = (await field.locator('button').first().boundingBox())!;
      expect(cap.x + cap.width).toBeLessThanOrEqual(ctl.x);
      expect(Math.abs((cap.y + cap.height / 2) - (ctl.y + ctl.height / 2))).toBeLessThan(4);
      // The control keeps its own name; the caption isn't read twice.
      await expect(field.locator('button').first()).toHaveAttribute('aria-label', new RegExp(`^${labels[i]}: `));
    }
  }
});

test('a feature\'s page lists its linked findings in the side column: open first, closed dimmed', async ({ page }) => {
  await openView(page, '/#/features', '[data-nav-area="features-list"]');
  const featureId = (await page.locator('[data-feature-id]').first().getAttribute('data-feature-id'))!;
  const feature = await (await page.request.get(api(`/api/features/${featureId}`))).json();
  const make = async (title: string, severity: string, status: string) =>
    (await (await page.request.post(api('/api/findings'), { data: { title, severity, status, anchor: feature.anchor, features: [featureId] } })).json()).id as string;
  const closedId = await make('Linked closed finding', 'critical', 'closed');
  const openId = await make('Linked open finding', 'low', 'open');
  try {
    await page.goto(appUrl(`/#/feature/${featureId}`));
    const card = page.locator('.fd-side .fd-findings-card');
    await expect(card.locator('.fd-card-title')).toContainText('Findings');
    const rows = card.locator('.fd-finding-row');
    // Created over the API with the page open: the card picks them up from the live refresh.
    await expect(rows.filter({ hasText: 'Linked closed finding' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Linked open finding' })).toHaveCount(1);
    const titles = await rows.locator('.fd-finding-title').allTextContents();
    // Open before closed, even though the closed one is more severe; closed is dimmed.
    expect(titles.indexOf('Linked open finding')).toBeLessThan(titles.indexOf('Linked closed finding'));
    const closed = rows.filter({ hasText: 'Linked closed finding' });
    await expect(closed).toHaveClass(/fd-finding-row--closed/);
    await expect(closed.locator('.select-tinted')).toHaveText('Closed');
    expect(Number(await closed.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
    // It sits under Provenance, before origin and links; the side column is 410px wide.
    // (The platform shell adds its own "Used in flows" card to this column; the workbench's cards keep their order.)
    const side = (await page.locator('.fd-side > .fd-card > .fd-card-title').allTextContents()).filter((t) => !/^Used in flows/.test(t));
    expect(side[0]).toMatch(/^Provenance/);
    expect(side[1]).toMatch(/^Findings/);
    const width = (await page.locator('.fd-side').boundingBox())!.width;
    if ((page.viewportSize()?.width ?? 0) > 940) expect(Math.round(width)).toBe(410);
    // The count's link opens the filtered list; a row opens the finding.
    await expect(card.locator('a.fd-card-action')).toHaveAttribute('href', `#/findings/feature/${featureId}`);
    await rows.filter({ hasText: 'Linked open finding' }).click();
    await expect(page).toHaveURL(new RegExp(`#/finding/${openId}$`));
    await expect(page.locator('.fd-title')).toHaveText('Linked open finding');
  } finally {
    await page.request.delete(api(`/api/findings/${openId}`));
    await page.request.delete(api(`/api/findings/${closedId}`));
  }
});
