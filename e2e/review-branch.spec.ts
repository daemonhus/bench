import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, api, appUrl, PROJECT } from './helpers/input';

// The review branch: the chip beside the project name shows it and picks another, for the whole
// project; Browse, Changes and Findings follow it; a link can name another (?branch=).
// The fixture repo gets a branch off its first commit with one commit and one finding of its
// own, all removed again at the end (the project is this worker's for the other specs too).

const BRANCH = 'feature/rework';

async function repoPath(request: APIRequestContext): Promise<string> {
  const projects = await (await request.get('/api/projects')).json() as { slug: string; repoPath: string }[];
  return projects.find((p) => p.slug === PROJECT)!.repoPath;
}

test.describe.configure({ mode: 'serial' });

let repo = '';
let branchTip = '';
let findingId = '';

test.beforeAll(async ({ request }) => {
  repo = await repoPath(request);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
  const first = git('rev-list', '--max-parents=0', 'HEAD');
  git('branch', BRANCH, first);
  git('checkout', '-q', BRANCH);
  appendFileSync(join(repo, 'src/auth/login.go'), '// reworked\n');
  git('commit', '-q', '-am', 'rework login');
  branchTip = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');

  const res = await request.post(api('/api/findings'), {
    data: {
      title: 'Rework bypass', severity: 'high', status: 'open', source: 'manual',
      anchor: { fileId: 'src/auth/login.go', commitId: branchTip, lineRange: { start: 41, end: 41 } },
    },
  });
  findingId = (await res.json()).id;
});

test.afterAll(async ({ request }) => {
  await request.put(api('/api/review-branch'), { data: { branch: '' } });
  if (findingId) await request.delete(api(`/api/findings/${findingId}`));
  execFileSync('git', ['branch', '-D', BRANCH], { cwd: repo });
});

test('the chip picks the review branch for the project, and the pages follow it', async ({ page, request }) => {
  await page.goto(appUrl('/#/findings'));
  const chip = page.locator('.review-branch-trigger:visible');
  await expect(chip).toHaveText(/^main/);

  // On main, the branch's finding is counted, not listed.
  const note = page.locator('.findings-branch-note');
  await expect(note).toContainText('1 finding is on other branches, not main');
  await expect(page.getByText('Rework bypass')).toHaveCount(0);
  // …and shown, marked, on asking.
  await note.getByRole('button', { name: 'Show them' }).click();
  await expect(page).toHaveURL(/others=1/);
  const card = page.locator('.finding-card', { hasText: 'Rework bypass' });
  await expect(card).toContainText('Not on main');
  await note.getByRole('button', { name: 'Hide them' }).click();
  await expect(card).toHaveCount(0);

  // Keyboard: open (the list takes the keys), down to the branch, Enter.
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.review-branch-list')).toBeFocused();
  await expect(page.locator('.review-branch-option--selected')).toContainText('main');
  await expect(page.locator('.review-branch-option', { hasText: 'main' })).toContainText('default');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.review-branch-option--active')).toContainText(BRANCH);
  await page.keyboard.press('Enter');

  // Saved for the project; the workbench starts again on it, focus back on the chip.
  await expect(chip).toHaveText(new RegExp(`^${BRANCH}`));
  await expect(chip).toBeFocused();
  const saved = await (await request.get(api('/api/review-branch'))).json();
  expect(saved.saved).toBe(BRANCH);
  await expect(page.getByText('Rework bypass')).toBeVisible();
  await expect(note).toContainText(`on other branches, not ${BRANCH}`);

  // Changes: up to the branch's head, its commit and finding.
  await page.goto(appUrl('/#/delta'));
  await expect(page.locator('.delta-view')).toContainText(branchTip.slice(0, 7));
  await expect(page.locator('.delta-view')).toContainText('rework login');

  // Browse opens at the branch's head.
  await page.goto(appUrl('/#/browse'));
  await expect(page.locator('.commit-button-hash')).toHaveText(branchTip.slice(0, 7));

  // Back to the default branch: saved as "the default".
  await chip.click();
  await page.locator('.review-branch-option', { hasText: 'main' }).click();
  await expect(chip).toHaveText(/^main/);
  expect((await (await request.get(api('/api/review-branch'))).json()).saved).toBe('');
});

test('a link names another branch for whoever opens it, and says so', async ({ page, request }) => {
  await page.goto(`/p/${PROJECT}?branch=${encodeURIComponent(BRANCH)}#/browse`);
  const chip = page.locator('.review-branch-trigger:visible');
  await expect(chip).toHaveText(new RegExp(`^${BRANCH}\\s*link`));
  await expect(page.locator('.commit-button-hash')).toHaveText(branchTip.slice(0, 7));
  // The project's branch is unchanged.
  expect((await (await request.get(api('/api/review-branch'))).json()).name).toBe('main');

  await chip.click();
  const popover = page.locator('.review-branch-popover');
  await expect(popover).toContainText(`This link shows ${BRANCH}; the project reviews main.`);
  await popover.getByRole('button', { name: 'Back to main' }).click();
  await expect(chip).toHaveText(/^main/);
  await expect(page).not.toHaveURL(/branch=/);
  expect((await (await request.get(api('/api/review-branch'))).json()).saved).toBe('');
});
