import { test, expect } from './helpers/input';
import type { APIRequestContext } from '@playwright/test';

// Activity (rail → Activity): new findings and features from every project and findings past
// their fix deadline, newest first, grouped by day, each with the last comment on it. The
// filters live in the address.

const feed = (page: import('@playwright/test').Page) => page.locator('.activity-page');
const card = (page: import('@playwright/test').Page, title: string) => page.locator('.activity-card', { has: page.locator('.search-card-title', { hasText: title }) });

async function seed(request: APIRequestContext) {
  const [f0] = await (await request.get('/api/projects/alpha/findings')).json() as { anchor: unknown }[];
  const fresh = await (await request.post('/api/projects/alpha/findings', {
    data: { anchor: f0.anchor, severity: 'high', title: 'zircon token replay', description: 'The **refresh token** can be replayed.', status: 'open', source: 'manual' },
  })).json() as { id: string };
  // A critical finding opened ten days ago is three days past its 7-day deadline.
  const old = await (await request.post('/api/projects/beta/findings', {
    data: { anchor: (await (await request.get('/api/projects/beta/findings')).json())[0].anchor, severity: 'critical', title: 'zircon admin bypass', description: 'old', status: 'open', source: 'manual', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() },
  })).json() as { id: string };
  const c = await (await request.post('/api/projects/alpha/comments', {
    data: { anchor: f0.anchor, author: 'e2e', text: 'zircon: rotating keys now', findingId: fresh.id },
  })).json() as { id: string };
  return {
    fresh, old,
    cleanup: async () => {
      await request.delete(`/api/projects/alpha/comments/${c.id}`);
      await request.delete(`/api/projects/alpha/findings/${fresh.id}`);
      await request.delete(`/api/projects/beta/findings/${old.id}`);
    },
  };
}

test('the rail opens Activity, above Projects', async ({ page }) => {
  await page.goto('/');
  const rail = page.getByRole('navigation', { name: 'Sections' });
  const names = await rail.locator('.platform-rail-group').first().locator('.platform-rail-btn').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  expect(names.slice(0, 2)).toEqual(['Activity', 'Projects']);
  await rail.getByRole('button', { name: /Activity/ }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(page.getByRole('heading', { name: 'Activity', level: 2 })).toBeVisible();
  await expect(rail.getByRole('button', { name: /Activity/ })).toHaveAttribute('aria-current', 'page');
});

test('a new finding shows its severity, status, description and last comment, under Today', async ({ page, request }) => {
  const s = await seed(request);
  try {
    await page.goto('/activity?q=zircon');
    const today = feed(page).getByRole('region', { name: 'Today' });
    const fresh = today.locator('.activity-card', { has: page.locator('.search-card-title', { hasText: 'zircon token replay' }) });
    await expect(fresh.locator('.activity-card-what')).toHaveText('New finding');
    await expect(fresh.locator('.activity-card-project')).toHaveText('alpha');
    await expect(fresh.locator('.select-tinted')).toHaveText(['High', 'Open']);
    await expect(fresh.locator('.search-card-text')).toHaveText('The refresh token can be replayed.');
    await expect(fresh.locator('.activity-card-comment')).toContainText('e2e');
    await expect(fresh.locator('.activity-card-comment')).toContainText('zircon: rotating keys now');
    await fresh.locator('.search-card-title').click();
    await expect(page).toHaveURL(new RegExp(`/p/alpha#/finding/${s.fresh.id}$`));
  } finally { await s.cleanup(); }
});

test('a finding past its deadline is an item of its own, dated when the deadline passed', async ({ page, request }) => {
  const s = await seed(request);
  try {
    await page.goto('/activity?kinds=sla&q=zircon');
    const sla = card(page, 'zircon admin bypass');
    await expect(sla.locator('.activity-card-what')).toHaveText('Past SLA');
    await expect(sla.locator('.search-card-flag')).toHaveText('3 days over');
    await expect(sla.locator('.search-card-meta')).toContainText('fix within 7');
    await expect(card(page, 'zircon token replay')).toHaveCount(0);
  } finally { await s.cleanup(); }
});

test('filters narrow the feed and live in the address', async ({ page, request }) => {
  const s = await seed(request);
  try {
    await page.goto('/activity?q=zircon');
    await expect(card(page, 'zircon token replay')).toBeVisible();
    // Only critical: the high finding goes, the critical one (new, and past SLA) stays.
    await page.getByRole('button', { name: 'Severity' }).click();
    await page.getByRole('button', { name: 'Only Critical' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/severity=critical/);
    await expect(card(page, 'zircon token replay')).toHaveCount(0);
    await expect(card(page, 'zircon admin bypass')).toHaveCount(2);
    // Hide new findings: just the breach is left.
    await page.getByRole('button', { name: /^New findings/ }).click();
    await expect(page).toHaveURL(/kinds=feature,sla/);
    await expect(card(page, 'zircon admin bypass')).toHaveCount(1);
    await page.reload();
    await expect(card(page, 'zircon admin bypass')).toHaveCount(1);
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page).toHaveURL(/\/activity\?q=zircon$/);
    await expect(card(page, 'zircon token replay')).toBeVisible();
  } finally { await s.cleanup(); }
});
