import { test, expect } from '@playwright/test';
import { api, appUrl } from './helpers/input';

// Changes shows a merge as the pull request it landed: its number (linking to the host), title
// and source branch, over the commits it brought in. The fixture repo has no merges, so the
// graph is rewritten here: HEAD becomes the merge of one branch commit, itself a squashed PR.

const BRANCH_COMMIT = 'f'.repeat(40);

test('a merged pull request shows its number, title and branch, over the commits it brought in', async ({ page, request }) => {
  // A baseline at the first commit, so HEAD is in the stream whatever earlier specs set.
  const graph = await (await request.get(api('/api/git/graph?limit=1000'))).json() as { hash: string; parents?: string[] }[];
  const root = graph.find((c) => !c.parents?.length)!;
  const baseline = await (await request.post(api('/api/baselines'), { data: { commitId: root.hash, summary: 'pull-requests spec' } })).json() as { id: string };
  try {
    await checkMergeCard(page);
  } finally {
    await request.delete(api(`/api/baselines/${baseline.id}`));
  }
});

async function checkMergeCard(page: import('@playwright/test').Page) {
  await page.route(/\/git\/graph\b/, async (route) => {
    const graph = await (await route.fetch()).json();
    const head = graph.find((c: { refs?: string[] }) => c.refs?.includes('HEAD')) ?? graph[0];
    graph.push({
      hash: BRANCH_COMMIT, shortHash: BRANCH_COMMIT.slice(0, 7), author: 'E2E', date: head.date,
      subject: 'Tidy the guide (#41)', parents: head.parents.slice(0, 1), refs: [],
      pullRequest: { kind: 'pull', number: 41, title: 'Tidy the guide', squashed: true, url: 'https://github.com/acme/app/pull/41' },
    });
    head.parents = [...head.parents.slice(0, 1), BRANCH_COMMIT];
    head.pullRequest = { kind: 'pull', number: 42, title: 'Rewrite the guide', branch: 'docs/guide', url: 'https://github.com/acme/app/pull/42' };
    await route.fulfill({ json: graph });
  });
  await page.goto(appUrl('/#/delta'));

  const item = page.locator('.activity-item-wrap', { has: page.locator('.overview-merge-card') });
  await expect(item).toHaveCount(1);
  const ref = item.locator('.activity-event-label .overview-pr-ref');
  await expect(ref).toHaveText('pull request #42');
  await expect(ref).toHaveAttribute('href', 'https://github.com/acme/app/pull/42');
  await expect(item.locator('.overview-merge-subject')).toHaveText('Rewrite the guide');
  await expect(item.locator('.overview-merge-pr-branch')).toHaveText('docs/guide');

  // Its commits: the squashed PR among them carries its own number.
  await item.locator('.overview-merge-branch-toggle').click();
  const row = item.locator('.overview-merge-branch-commits .overview-commit-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.overview-pr-ref')).toHaveText('#41');
  await expect(row.locator('.overview-pr-ref')).toHaveAttribute('title', '#41: Tidy the guide');
}
