import { test, expect } from '@playwright/test';
import { api, appUrl } from './helpers/input';

// The overview lists the local branches as links that browse each one (#/browse?at=<branch>).
// The fixture repo has only main, so more branches are added here: one at the first commit,
// which the server is also taught to resolve, and four more to fill the "+N more" toggle.

const OLD = 'feature/search';

test('branch chips link to browsing that branch, and leaving its commit drops it from the address', async ({ page, request }) => {
  const commits = await (await request.get(api('/api/git/commits?limit=100'))).json() as { hash: string; shortHash: string }[];
  const first = commits[commits.length - 1];
  await page.route(/\/git\/branches\b/, async (route) => {
    const branches = await (await route.fetch()).json();
    const extra = [OLD, 'a', 'b', 'c', 'd'].map((name) => ({ name, head: first.shortHash, isCurrent: false, isRemote: false }));
    await route.fulfill({ json: [...extra, ...branches] });
  });
  await page.route(/\/git\/commits\?.*to_commit=feature(%2F|\/)search/, (route) =>
    route.fulfill({ json: [commits[commits.length - 1]] }));

  await page.goto(appUrl('/#/overview'));
  const chips = page.locator('.ovp-branch-chip');
  // The review branch comes first, whatever order the server lists them in.
  await expect(chips.first()).toHaveClass(/ovp-branch-chip--review/);
  await expect(chips.first()).toContainText('main');
  await expect(chips).toHaveCount(4);

  const more = page.locator('.ovp-branch-more');
  await expect(more).toHaveText('+2 more');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(chips).toHaveCount(6);
  await expect(more).toHaveText('Show fewer');
  await expect(more).toHaveAttribute('aria-expanded', 'true');

  const old = chips.filter({ hasText: OLD });
  await expect(old).toHaveAttribute('href', `#/browse?at=${OLD}`);
  await expect(old.locator('.ovp-branch-chip-hash')).toHaveText(first.shortHash);

  // Browse opens at the branch's commit: the commit button says so.
  await old.click();
  await expect(page).toHaveURL(/#\/browse\?at=feature\/search$/);
  await expect(page.locator('.commit-button-hash')).toHaveText(first.shortHash);
  await expect(page.locator('.commit-button')).toContainText(OLD);

  // The address is a link: loaded cold, it lands on the same commit.
  await page.reload();
  await expect(page.locator('.commit-button-hash')).toHaveText(first.shortHash);

  // Moving to another commit drops ?at=, so the address never names a commit you've left.
  await page.locator('.commit-button').click();
  const row = page.locator('.git-tree-row').filter({ hasNot: page.locator('.git-tree-hash', { hasText: first.shortHash }) }).first();
  const picked = await row.locator('.git-tree-hash').innerText();
  await row.click();
  await expect(page.locator('.commit-button-hash')).toHaveText(picked);
  await expect(page).toHaveURL(/#\/browse$/);
});
