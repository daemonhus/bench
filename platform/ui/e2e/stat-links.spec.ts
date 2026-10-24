import { test, expect } from './helpers/input';
import type { APIRequestContext } from '@playwright/test';

// The home page's Past SLA and Unreviewed change stats open where their numbers come from: one
// project's own page when only that project contributes, else the view across projects.

const stat = (page: import('@playwright/test').Page, label: string) =>
  page.locator('.home-stat', { has: page.locator('.home-metric-label', { hasText: label }) });

/** A critical finding opened ten days ago: three days past its 7-day SLA. */
async function overdue(request: APIRequestContext, slug: string, title: string) {
  const [f0] = await (await request.get(`/api/projects/${slug}/findings`)).json() as { anchor: unknown }[];
  const f = await (await request.post(`/api/projects/${slug}/findings`, {
    data: { anchor: f0.anchor, severity: 'critical', title, description: 'old', status: 'open', source: 'manual', createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() },
  })).json() as { id: string };
  return () => request.delete(`/api/projects/${slug}/findings/${f.id}`);
}

test("Past SLA in one project opens that project's findings, filtered to the overdue ones", async ({ page, request }) => {
  const cleanup = await overdue(request, 'beta', 'quartz admin bypass');
  try {
    await page.goto('/');
    await expect(stat(page, 'Past SLA').locator('.home-stat-value')).toHaveText('1');
    await expect(stat(page, 'Past SLA')).toHaveAttribute('href', '/p/beta#/findings?overdue=1');
    await stat(page, 'Past SLA').click();
    await expect(page).toHaveURL(/\/p\/beta#\/findings\?overdue=1$/);
    await expect(page.locator('[data-finding-id]')).toHaveCount(1);
    await expect(page.locator('[data-finding-id]')).toContainText('quartz admin bypass');

    // The chip names the filter; clearing it brings back the other open findings.
    const chip = page.locator('.findings-feature-chip--sla');
    await expect(chip).toContainText('Past SLA');
    await chip.getByRole('button', { name: 'Clear Past SLA filter' }).click();
    await expect(page).not.toHaveURL(/overdue/);
    expect(await page.locator('[data-finding-id]').count()).toBeGreaterThan(1);
  } finally { await cleanup(); }
});

test('Past SLA across projects opens Activity on SLA breaches, of any age', async ({ page, request }) => {
  const done = [await overdue(request, 'alpha', 'quartz replay'), await overdue(request, 'beta', 'quartz admin bypass')];
  try {
    await page.goto('/');
    await expect(stat(page, 'Past SLA').locator('.home-stat-value')).toHaveText('2');
    await stat(page, 'Past SLA').click();
    await expect(page).toHaveURL(/\/activity\?kinds=sla&since=all$/);
    await expect(page.locator('.activity-card')).toHaveCount(2);
  } finally { for (const d of done) await d(); }
});

test('Unreviewed change opens Projects, or the one project with unreviewed commits', async ({ page }) => {
  await page.goto('/');
  const link = stat(page, 'Unreviewed change');
  await expect(link).toHaveAttribute('href', /^\/projects$|^\/p\/[\w-]+#\/delta$/);
  const href = (await link.getAttribute('href'))!;
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${href.replace(/[?#]/g, '\\$&')}$`));
});
