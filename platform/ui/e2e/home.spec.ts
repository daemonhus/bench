import { test, expect } from './helpers/input';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// The Bench (home) dashboard, for whoever owns security across the projects.
// Fixture: projects alpha and beta, three open findings each (high, medium, low), a baseline
// each; three flows. Findings were created just now, so none is past its SLA.

const panel = (page: Page, title: string) =>
  page.locator('.ovp-panel', { has: page.locator('.ovp-panel-title', { hasText: title }) });
const stat = (page: Page, label: string) =>
  page.locator('.home-stat', { has: page.locator('.home-metric-label', { hasText: label }) });

test('"/" is the Bench home; the logo leads there and is marked current', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-header h1')).toHaveText('Bench');
  await expect(page.getByRole('button', { name: 'Bench' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/projects');
  await expect(page.locator('.project-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'Bench' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('posture: risk gauge, findings trend (found/fixed bars, open line) and the four headline numbers', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-gauge')).toHaveAttribute('aria-label', /Portfolio risk \d+ out of 100/);
  const chart = panel(page, 'Posture').locator('.home-chart');
  await expect(chart).toHaveAttribute('aria-label', /now 6 open/);
  // Found and fixed are weekly bars; the open count is a line on its own (right) axis.
  await expect(panel(page, 'Posture')).toContainText('Found 6');
  await expect(panel(page, 'Posture')).toContainText('Open now 6');
  const bars = await chart.locator('.recharts-bar-rectangle').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).length);
  expect(bars).toBeGreaterThan(0);
  await expect(chart.locator('.recharts-line-curve')).toHaveCount(1);
  await expect(chart.locator('.recharts-yAxis')).toHaveCount(2);
  // Axes carry measurements, and hovering shows the week's found, fixed and open counts.
  await expect(chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick').first()).toBeVisible();
  await expect(chart.locator('.recharts-yAxis .recharts-cartesian-axis-tick').first()).toBeVisible();
  const box = (await chart.locator('.recharts-surface').boundingBox())!;
  await page.mouse.move(box.x + box.width - 60, box.y + box.height / 2); // the latest week: ends now
  const tip = chart.locator('.home-chart-tip');
  await expect(tip).toContainText('Week ending');
  await expect(tip.locator('.home-chart-tip-row', { hasText: 'Open' }).locator('b')).toHaveText('6');
  await expect(tip.locator('.home-chart-tip-row', { hasText: 'Found' }).locator('b')).toHaveText('6');
  await expect(tip).not.toContainText('Total'); // the series aren't parts of one whole
  await expect(stat(page, 'Past SLA').locator('.home-stat-value')).toHaveText('0');
  await expect(stat(page, 'Past SLA')).toHaveClass(/home-tone-ok/);
  for (const label of ['Median time to fix', 'Unreviewed change', 'Review coverage']) await expect(stat(page, label)).toBeVisible();
});

test('next actions are ranked and open the right place', async ({ page }) => {
  await page.goto('/');
  const actions = panel(page, 'Next actions').locator('.home-action');
  await expect(actions.first()).toBeVisible();
  // No SLA breaches in the fixture; the missing service profiles are called out.
  await expect(panel(page, 'Next actions')).toContainText('without a service profile');
  // Each action leads with an icon for its kind (labelled for assistive tech), not a coloured side bar.
  const edges = await actions.evaluateAll((els) => els.map((e) => {
    const c = getComputedStyle(e);
    return { shadow: c.boxShadow, left: c.borderLeftWidth, right: c.borderRightWidth, icon: !!e.querySelector('svg.home-action-icon[aria-label]') };
  }));
  for (const e of edges) expect(e).toEqual({ shadow: 'none', left: e.right, right: e.right, icon: true });
  // The missing-profile action is a configuration one: the wrench.
  await expect(panel(page, 'Next actions').locator('.home-action', { hasText: 'service profile' }).locator('.home-action-icon'))
    .toHaveAttribute('aria-label', /Configuration/);
  await panel(page, 'Next actions').locator('.home-action', { hasText: 'service profile' }).click();
  await expect(page).toHaveURL(/\/p\/\w+#\/profile/);
});

test('SLA & ageing, weaknesses and attack surface', async ({ page }) => {
  await page.goto('/');
  const sla = panel(page, 'SLA & ageing');
  await expect(sla.locator('.home-ageing-row', { hasText: 'High' }).locator('.home-ageing-count')).toHaveText('2');
  await expect(sla.locator('.home-ageing-row', { hasText: 'High' }).locator('.home-age-lt7')).toHaveCount(1); // all just created
  await expect(panel(page, 'Top weaknesses').locator('.home-weak-row').first()).toBeVisible();
  const surface = panel(page, 'Mapped attack surface');
  await expect(surface.locator('.home-surface-row')).toHaveCount(2);
  await expect(panel(page, 'Found and fixed')).toHaveCount(0); // folded into the Posture trend
  // The attack surface over time: the fixture's 8 features (4 per project), mapped this week.
  await expect(panel(page, 'Attack surface over time')).toContainText('Mapped now 8');
  // Left column: findings (SLA, weaknesses); right: the attack surface (over time, then as it stands).
  const col = (title: string) => panel(page, title).evaluate((e) => Array.from(e.parentElement!.parentElement!.children).indexOf(e.parentElement!));
  const left = await page.locator('.home-col').first().locator(':scope > .ovp-panel > .ovp-panel-title').allTextContents();
  expect(left.map((t) => t.split(',')[0])).toEqual(['SLA & ageing of open findings', 'Top weaknesses']);
  expect(await col('Attack surface over time')).toBe(1);
  expect(await col('Mapped attack surface')).toBe(1);
});

test('attack surface: share of features on a documented flow, one square each with bench\'s hover card', async ({ page, request }) => {
  const flows = (await (await request.get('/api/flows?limit=200')).json()).items as { shape: { projectSlug: string; featureId: string }[] }[];
  const onFlow = new Set(flows.flatMap((f) => f.shape.map((n) => `${n.projectSlug}:${n.featureId}`)));
  const expected: Record<string, { total: number; on: number }> = {};
  for (const slug of ['alpha', 'beta']) {
    const fs = (await (await request.get(`/api/projects/${slug}/features`)).json()) as { id: string }[];
    expected[slug] = { total: fs.length, on: fs.filter((f) => onFlow.has(`${slug}:${f.id}`)).length };
  }
  await page.goto('/');
  const surface = panel(page, 'Mapped attack surface');
  for (const slug of ['alpha', 'beta']) {
    const row = surface.locator('.home-surface-row', { hasText: slug });
    const e = expected[slug];
    await expect(row.locator('.ovp-kind-square')).toHaveCount(e.total);
    await expect(row.locator('.ovp-kind-square.home-square-off')).toHaveCount(e.total - e.on);
    await expect(row.locator('.home-surface-share')).toHaveText(`${e.total ? Math.round((e.on / e.total) * 100) : 0}%`);
  }
  // The headline is the plain average of the project shares (a project with nothing mapped is 0%).
  const shares = Object.values(expected).map((e) => (e.total ? e.on / e.total : 0));
  await expect(surface.locator('.home-surface-pct')).toHaveText(`${Math.round((shares.reduce((a, b) => a + b, 0) / shares.length) * 100)}%`);
  // Hover a square: bench's feature mini card; its title opens the feature in its project.
  const square = surface.locator('.home-surface-row', { hasText: 'alpha' }).locator('.ovp-kind-square').first();
  await square.hover();
  const card = surface.locator('.ovp-map-card');
  await expect(card).toBeVisible();
  await card.locator('.ovp-map-card-title').click();
  await expect(page).toHaveURL(/\/p\/alpha#\/feature\//); // the feature's own page
  await expect(page.locator('.fd-title')).toBeVisible();
});

test('the header is the title and search: no subtitle, no Projects control (the rail has Projects)', async ({ page }) => {
  await page.goto('/');
  await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible();
  await expect(page.locator('.home-header h1')).toHaveText('Bench');
  await expect(page.locator('.home-header > *')).toHaveCount(2); // the title, then search
  await expect(page.locator('.home-header > .home-search')).toBeVisible();
  await expect(page.locator('.home-header button')).toHaveCount(0);
  // Search sits top right, level with the title.
  const title = (await page.locator('.home-header h1').boundingBox())!;
  const search = (await page.locator('.home-search').boundingBox())!;
  expect(search.x).toBeGreaterThan(title.x + title.width);
  expect(Math.abs((search.y + search.height / 2) - (title.y + title.height / 2))).toBeLessThan(8);
});

test('axe: overview', async ({ page }) => {
  await page.goto('/');
  await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible();
  const r = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('one column, nothing scrolls sideways (the matrix scrolls inside its panel)', async ({ page }) => {
    await page.goto('/');
    await expect(panel(page, 'Next actions')).toBeVisible();
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    const lefts = await page.locator('.home-hero > .ovp-panel, .home-grid > .ovp-panel').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))]);
    expect(lefts).toHaveLength(1);
  });

  test('the bottom bar includes Bench', async ({ page }) => {
    await page.goto('/flows');
    const home = page.getByRole('button', { name: 'Bench' });
    await expect(home).toBeVisible();
    expect((await home.boundingBox())!.y).toBeGreaterThan(700);
    await home.click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test('Projects: the top-projects risk bars fill to their score', async ({ page }) => {
  await page.goto('/projects');
  const fill = page.locator('.risk-bar-fill').first();
  await expect(fill).toBeVisible();
  expect((await fill.boundingBox())!.width).toBeGreaterThan(10);
});

test('opening a project from Projects lands on its Overview, every time', async ({ page }) => {
  await page.goto('/projects');
  await page.locator('.project-card-open', { hasText: 'alpha' }).click();
  await expect(page).toHaveURL(/\/p\/alpha#\/overview$/);
  await page.evaluate(() => { window.location.hash = '#/findings'; });
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.locator('.project-card-open', { hasText: 'alpha' }).click();
  await expect(page).toHaveURL(/\/p\/alpha#\/overview$/);
});

test('a finding listed on the home page opens its detail page in the project', async ({ page }) => {
  await page.goto('/');
  const weak = panel(page, 'Top weaknesses');
  await weak.locator('.home-weak-row button').first().click();
  const item = weak.locator('.home-weak-finding').first();
  const title = (await item.locator('.home-weak-finding-title').textContent())!.trim();
  await item.click();
  await expect(page).toHaveURL(/\/p\/\w+#\/finding\//);
  await expect(page.locator('.fd-title')).toHaveText(title);
});

test('the home page has no per-project risk table: that lives on the project cards', async ({ page }) => {
  await page.goto('/');
  await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible();
  await expect(page.locator('.ovp-panel-title', { hasText: 'Risk by project' })).toHaveCount(0);
});

test.describe('search everything (top right)', () => {
  const box = (page: Page) => page.getByRole('combobox', { name: 'Search everything' });
  const results = (page: Page) => page.locator('#home-search-results');
  const sections = (page: Page) => results(page).locator('.home-search-section').allTextContents();

  test('"/" focuses it; the three best hits lead, then up to three per kind, empty kinds skipped', async ({ page }) => {
    await page.goto('/');
    await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible(); // data loaded
    // Bigger than the toolbar searches, with a magnifying glass that focuses it.
    const wrap = page.locator('.home-search-box');
    expect((await wrap.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await wrap.boundingBox())!.width).toBeGreaterThanOrEqual(480);
    await wrap.locator('.annotation-search-icon').click();
    await expect(box(page)).toBeFocused();
    await box(page).blur();
    await page.keyboard.press('/');
    await expect(box(page)).toBeFocused();
    await page.keyboard.type('alpha');
    // The project named exactly "alpha" beats findings that start with it; ties go alphabetically.
    const top = results(page).locator('[role="group"]').first().getByRole('option');
    await expect(top).toHaveCount(3);
    await expect(top.nth(0).locator('.home-search-label')).toHaveText('alpha');
    await expect(top.nth(1).locator('.home-search-label')).toHaveText('alpha finding 1');
    await expect(top.nth(2).locator('.home-search-label')).toHaveText('alpha finding 2');
    // What the top three didn't show: the third finding. Nothing else matches, so no other kinds.
    expect(await sections(page)).toEqual(['Top results', 'Findings']);
    await expect(results(page).getByRole('option')).toHaveCount(4);
    await expect(top.nth(0).locator('.home-search-mark')).toHaveText('alpha');
    expect((await new AxeBuilder({ page }).include('.home-search').analyze()).violations).toEqual([]);
  });

  test('fuzzy: letters in order still find a feature; each kind holds at most three', async ({ page }) => {
    await page.goto('/');
    await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible();
    await box(page).fill('sesion');
    await expect(results(page).getByRole('option').first().locator('.home-search-label')).toHaveText('session reaper');
    await expect(results(page).getByRole('option')).toHaveCount(2); // one per project
    await box(page).fill('finding');
    // Six findings match: three lead, three more under Findings, the rest left out.
    expect(await sections(page)).toEqual(['Top results', 'Findings']);
    await expect(results(page).getByRole('option')).toHaveCount(6);
    await box(page).fill('qqqzzz');
    await expect(page.locator('.home-search-empty')).toHaveText(/No matches/);
  });

  test('keyboard: arrows move, Enter opens the hit in its project, Escape closes', async ({ page }) => {
    await page.goto('/');
    await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible();
    await box(page).fill('beta finding');
    const options = results(page).getByRole('option');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(box(page)).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
    await page.keyboard.press('Escape');
    await expect(results(page)).toHaveCount(0);
    await expect(box(page)).toHaveValue('beta finding');
    await page.keyboard.press('ArrowDown'); // reopens
    await expect(options.first()).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const title = (await options.nth(1).locator('.home-search-label').textContent())!;
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/beta#\/finding\//);
    await expect(page.locator('.fd-title')).toHaveText(title);
  });

  test('comments are searched too, and open where they live', async ({ page, request }) => {
    const findings = await (await request.get('/api/projects/alpha/findings')).json() as { id: string; anchor: unknown }[];
    const c = await (await request.post('/api/projects/alpha/comments', {
      data: { anchor: findings[0].anchor, author: 'e2e', text: 'Rotate the zebra signing key before release', findingId: findings[0].id },
    })).json() as { id: string };
    try {
      await page.goto('/');
      await expect(panel(page, 'Next actions').locator('.home-action').first()).toBeVisible();
      await box(page).fill('zebra');
      const hit = results(page).getByRole('option');
      await expect(hit).toHaveCount(1);
      await expect(hit.locator('.home-search-label')).toContainText('zebra signing key');
      await expect(hit.locator('.home-search-sub')).toHaveText('alpha · e2e');
      expect(await sections(page)).toEqual(['Top results']); // a kind already shown in full isn't repeated
      await hit.click();
      await expect(page).toHaveURL(new RegExp(`/p/alpha#/finding/${findings[0].id}$`));
    } finally {
      await request.delete(`/api/projects/alpha/comments/${c.id}`);
    }
  });
});
