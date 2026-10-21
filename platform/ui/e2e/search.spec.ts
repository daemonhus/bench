import { test, expect } from './helpers/input';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Page } from '@playwright/test';

// Search everything, past the dropdown's three-per-kind: "See all N …" under a kind, a closing
// "See all results", and Enter (nothing picked) open the search page (/search), which lists
// every hit with kind tabs and a project filter.
// Each test adds twelve "quartz" findings (six per project) and removes them after.

const box = (page: Page) => page.getByRole('combobox', { name: 'Search everything' });
const dropdown = (page: Page) => page.locator('#home-search-results');
const pageBox = (page: Page) => page.locator('.search-page-box input');
const tab = (page: Page, name: RegExp) => page.locator('.search-page-tab', { hasText: name });

async function withQuartz(request: APIRequestContext, fn: () => Promise<void>) {
  const made: [string, string][] = [];
  try {
    for (const slug of ['alpha', 'beta']) {
      const [f0] = await (await request.get(`/api/projects/${slug}/findings`)).json() as { anchor: unknown }[];
      for (let i = 1; i <= 6; i++) {
        const f = await (await request.post(`/api/projects/${slug}/findings`, {
          data: { anchor: f0.anchor, severity: 'low', title: `quartz leak ${slug} ${i}`, description: 'seeded for search', status: 'open', source: 'manual' },
        })).json() as { id: string };
        made.push([slug, f.id]);
      }
    }
    await fn();
  } finally {
    for (const [slug, id] of made) await request.delete(`/api/projects/${slug}/findings/${id}`);
  }
}

async function homeReady(page: Page) {
  await page.goto('/');
  await expect(page.locator('.home-action').first()).toBeVisible(); // data loaded
}

test('a kind with more than the dropdown shows offers "See all N"; it opens that kind on the search page', async ({ page, request }) => {
  await withQuartz(request, async () => {
    await homeReady(page);
    await box(page).fill('quartz');
    const options = dropdown(page).getByRole('option');
    // Three lead, three more under Findings, then "See all 12 findings" and the closing row.
    await expect(options).toHaveCount(8);
    const more = dropdown(page).locator('.home-search-more-row--more');
    await expect(more).toHaveText(/See all 12 findings/);
    await expect(dropdown(page).locator('.home-search-more-row--all')).toHaveText(/See all 12 results for “quartz”/);
    // Arrows reach it like any row.
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown');
    await expect(more).toHaveAttribute('aria-selected', 'true');
    await more.click();
    await expect(page).toHaveURL(/\/search\?q=quartz&kind=finding$/);
    await expect(tab(page, /^Findings/)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.search-page-list .search-page-row')).toHaveCount(12);
    await expect(page.locator('.search-page-summary')).toHaveText('12 findings for “quartz”');
  });
});

test('Enter with nothing picked opens every result; Back returns home', async ({ page, request }) => {
  await withQuartz(request, async () => {
    await homeReady(page);
    await box(page).fill('quartz');
    await expect(dropdown(page).getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=quartz$/);
    await expect(pageBox(page)).toBeFocused();
    await expect(pageBox(page)).toHaveValue('quartz');
    await expect(tab(page, /^All/)).toHaveAttribute('aria-pressed', 'true');
    await expect(tab(page, /^All/).locator('.search-page-count')).toHaveText('12');
    // "All" holds ten per kind and offers the rest.
    const findings = page.locator('.search-page-section', { has: page.locator('h3', { hasText: 'Findings' }) });
    await expect(findings.locator('.search-page-row')).toHaveCount(10);
    await findings.getByRole('button', { name: /See all 12 findings/ }).click();
    await expect(page).toHaveURL(/kind=finding/);
    await expect(page.locator('.search-page-row')).toHaveCount(12);
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=quartz$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });
});

test('the search page: typing follows in the address, tabs count, the project filter narrows, a hit opens', async ({ page, request }) => {
  await withQuartz(request, async () => {
    await page.goto('/search?q=alpha');
    // Opened directly, the page loads every project's findings, features and flows first.
    await expect(page.locator('.search-page-summary')).toContainText('for “alpha”', { timeout: 15_000 });
    await pageBox(page).fill('quartz');
    await expect(page).toHaveURL(/\/search\?q=quartz$/);
    await expect(tab(page, /^Findings/).locator('.search-page-count')).toHaveText('12');
    await expect(tab(page, /^Projects/).locator('.search-page-count')).toHaveText('0');

    await page.locator('.search-page-project').click();
    await page.getByRole('option', { name: 'alpha', exact: true }).click();
    await expect(page).toHaveURL(/project=alpha/);
    await expect(page.locator('.search-page-summary')).toHaveText('6 results for “quartz” in alpha');
    await expect(page.locator('.search-card-meta').first()).toContainText('alpha');

    // Down from the box walks the results; Enter opens one.
    await pageBox(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.search-page-row').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.search-page-row').nth(1)).toBeFocused();
    const title = (await page.locator('.search-page-row').nth(1).locator('.home-search-label').textContent())!;
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/alpha#\/finding\//);
    await expect(page.locator('.fd-title')).toHaveText(title);
  });
});

test('cards give context: a finding\'s severity, status, place and age, and the features it affects', async ({ page, request }) => {
  const [login] = (await (await request.get('/api/projects/alpha/features')).json() as { id: string; title: string }[]).filter((f) => f.title === 'POST /login');
  const [f0] = await (await request.get('/api/projects/alpha/findings')).json() as { anchor: unknown }[];
  const f = await (await request.post('/api/projects/alpha/findings', {
    data: { anchor: f0.anchor, severity: 'critical', title: 'quartz session fixation', description: 'The **session id** survives login.', status: 'open', source: 'manual', cwe: 'CWE-384', category: 'authentication', features: [login.id] },
  })).json() as { id: string };
  try {
    await page.goto('/search?q=quartz+session&kind=finding');
    const card = page.locator('.search-card', { hasText: 'quartz session fixation' });
    await expect(card.locator('.select-tinted')).toHaveText(['Critical', 'Open']);
    const meta = card.locator('.search-card-meta');
    await expect(meta).toContainText('alpha');
    await expect(meta).toContainText('CWE-384');
    await expect(meta).toContainText('src/auth/login.go:3');
    await expect(meta).toContainText('opened today');
    // Markdown marks are dropped from the excerpt.
    await expect(card.locator('.search-card-text')).toHaveText('The session id survives login.');
    await expect(card.locator('.search-card-links-label')).toHaveText('Affects');
    await card.getByRole('button', { name: 'Feature POST /login' }).click();
    await expect(page).toHaveURL(new RegExp(`/p/alpha#/feature/${login.id}$`));
  } finally {
    await request.delete(`/api/projects/alpha/findings/${f.id}`);
  }
});

test('cards give context: the flows a feature is on, and what a comment is about', async ({ page, request }) => {
  await page.goto('/search?q=login&kind=feature&project=alpha');
  const feature = page.locator('.search-card', { has: page.locator('.search-card-title', { hasText: 'POST /login' }) });
  await expect(feature.locator('.feature-method-badge')).toHaveText('POST');
  await expect(feature.locator('.select-tinted')).toHaveText(['Interface']);
  await expect(feature.locator('.search-card-meta')).toContainText('src/api.go:10');
  await expect(feature.locator('.search-card-links-label')).toHaveText('On flows');
  await expect(feature.locator('.search-card-link')).toHaveText(['Login path', 'Cross project'], { useInnerText: true });
  const flows = (await (await request.get('/api/flows?limit=50')).json()).items as { id: string; name: string }[];
  await feature.getByRole('button', { name: 'Flow Login path' }).click();
  await expect(page).toHaveURL(new RegExp(`/flows/${flows.find((f) => f.name === 'Login path')!.id}$`));

  const findings = await (await request.get('/api/projects/alpha/findings')).json() as { id: string; title: string; anchor: unknown }[];
  const c = await (await request.post('/api/projects/alpha/comments', {
    data: { anchor: findings[0].anchor, author: 'e2e', text: 'Quartz note: rotate the signing key', findingId: findings[0].id },
  })).json() as { id: string };
  try {
    await page.goto('/search?q=quartz+note&kind=comment');
    const card = page.locator('.search-card', { hasText: 'Quartz note' });
    await expect(card.locator('.search-card-meta')).toContainText('e2e');
    await expect(card.locator('.search-card-links-label')).toHaveText('On finding');
    await expect(card.locator('.search-card-link')).toHaveText(findings[0].title);
    await card.locator('.search-card-link').click();
    await expect(page).toHaveURL(new RegExp(`/p/alpha#/finding/${findings[0].id}$`));
  } finally {
    await request.delete(`/api/projects/alpha/comments/${c.id}`);
  }
});

test('a project\'s card: its repository, recent activity and open findings', async ({ page }) => {
  await page.goto('/search?q=alpha&kind=project');
  const card = page.locator('.search-card').first();
  await expect(card.locator('.search-card-title')).toHaveText('alpha');
  await expect(card.locator('.search-card-meta')).toContainText('/alpha');
  await expect(card.locator('.search-card-meta')).toContainText('baseline today');
  await expect(card.locator('.search-card-stats')).toContainText('3 open findings');
  await expect(card.locator('.search-card-sev')).toHaveText(['1 high', '1 medium', '1 low']);
  await card.locator('.search-card-meta').click(); // anywhere on the card opens it
  await expect(page).toHaveURL(/\/p\/alpha/);
});

test('the search page: empty and no-match states', async ({ page }) => {
  await page.goto('/search');
  await expect(page.locator('.search-page-empty')).toContainText('Type to search');
  await pageBox(page).fill('qqqzzz');
  await expect(page.locator('.search-page-summary')).toHaveText(/No matches for “qqqzzz”/);
});

test('axe: search page', async ({ page, request }) => {
  await withQuartz(request, async () => {
    await page.goto('/search?q=quartz');
    await expect(page.locator('.search-page-row').first()).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
