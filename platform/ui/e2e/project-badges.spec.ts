import { test, expect } from './helpers/input';
import type { Locator } from '@playwright/test';

// Each step shows its project as a badge in the project's colour, the same colour on the flow's
// map and in the flows list. The seeded "Cross project" flow runs alpha → beta → beta; alpha and
// beta hash to the same hue, so this also checks that two projects never end up sharing one.

const hue = (l: Locator) => l.getAttribute('data-hue');

test('a step shows its project in that project\'s colour, the same on the map and in the list', async ({ page, request }) => {
  const flows = (await (await request.get('/api/flows')).json()).items as { id: string; name: string }[];
  const flow = flows.find((f) => f.name === 'Cross project')!;

  await page.goto(`/flows/${flow.id}`);
  const badges = page.locator('.flow-step-header .project-badge');
  await expect(badges).toHaveText(['alpha', 'beta', 'beta']);
  // Until the project list loads, each badge has its own hashed hue: alpha's and beta's are one.
  await expect.poll(async () => (await hue(badges.nth(0))) !== (await hue(badges.nth(1)))).toBe(true);
  const [alpha, beta, beta2] = [await hue(badges.nth(0)), await hue(badges.nth(1)), await hue(badges.nth(2))];
  expect(beta2).toBe(beta);
  expect(alpha).not.toBe(beta);
  // The text is in a shade of the colour, not the page's.
  const color = await badges.first().evaluate((el) => getComputedStyle(el).color);
  const body = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(color).not.toBe(body);

  // The map: each node's project name is in the same colour as its badge, alpha's apart from beta's.
  await page.locator('.tab-bar-tab', { hasText: /^Map$/ }).click();
  const ink = (i: number) => page.locator('.flow-graph-node').nth(i).locator('rect[width="7"]').getAttribute('fill');
  await expect(page.locator('.flow-graph-node')).toHaveCount(3);
  const inks = await Promise.all([0, 1, 2].map(ink));
  expect(new Set(inks).size).toBe(2);
  for (const fill of inks) expect(fill).toMatch(new RegExp(`^hsl\\((${alpha}|${beta}) `));

  // The flows list: the project avatars carry the same hues.
  await page.goto('/flows');
  const card = page.locator('.flow-card', { hasText: 'Cross project' });
  await expect(card.locator('.ft-project-avatar')).toHaveCount(2);
  await expect(card.locator('.ft-project-avatar[title="alpha"]')).toHaveAttribute('data-hue', alpha!);
  await expect(card.locator('.ft-project-avatar[title="beta"]')).toHaveAttribute('data-hue', beta!);
});

test('a step\'s project badge opens the flows that include that project', async ({ page, request }) => {
  const flows = (await (await request.get('/api/flows')).json()).items as { id: string; name: string }[];
  const flow = flows.find((f) => f.name === 'Cross project')!;

  await page.goto(`/flows/${flow.id}`);
  const badge = page.locator('.flow-step-header .project-badge').first();
  await expect(badge).toHaveAttribute('href', '/flows?q=project:alpha');
  await badge.click();
  await expect(page).toHaveURL(/\/flows\?q=project:alpha$/);
  await expect(page.locator('.flows-search input, input.flows-search').first()).toHaveValue('project:alpha');
  // Only flows with a step in alpha: each card carries alpha's avatar.
  const cards = page.locator('.flow-card');
  await expect(cards.filter({ hasText: 'Cross project' })).toBeVisible();
  await expect(cards.filter({ hasNot: page.locator('.ft-project-avatar[title="alpha"]') })).toHaveCount(0);
  // Back returns to the flow.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/flows/${flow.id}$`));
});
