// Starts an isolated benchd for e2e: a throwaway data dir and E2E_PROJECTS identical projects
// ("e2e-0", "e2e-1", ...: one per Playwright worker, see PROJECT in helpers/input.ts), each on its
// own throwaway git repo with the same deterministic seed data, so workers never share state.
// Stays alive until killed.
// Used as a Playwright webServer (see playwright.e2e.config.ts).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRepo, sh } from './fixture-repo.mjs';

const PORT = process.env.E2E_API_PORT ?? '8091';
// E2E_FRESH: no seed data and the profile write gate left ON (profile.spec needs an unconfigured DB).
const FRESH = !!process.env.E2E_FRESH;
const API = `http://localhost:${PORT}`;
const COUNT = Math.max(1, Number(process.env.E2E_PROJECTS ?? 1));
const here = dirname(fileURLToPath(import.meta.url));
const backendDir = join(here, '..', '..', 'backend');

const work = mkdtempSync(join(tmpdir(), 'bench-e2e-'));

// ── build + start benchd ─────────────────────────────────────────────────────
// benchd embeds the platform UI build from internal/server/dist (a clean checkout has only .gitkeep).
// E2E_PROD: embed the PRODUCTION UI build (what users run) and have benchd serve it, instead of
// the Vite dev server. Same suite, different bundle.
const embedDir = join(backendDir, 'internal', 'server', 'dist');
if (process.env.E2E_PROD) {
  const root = join(here, '..', '..');
  const ui = join(root, 'platform', 'ui');
  const marker = join(embedDir, '.e2e-built');
  if (process.env.E2E_FRESH) {
    // The primary server builds + embeds the frontend once; wait for it.
    for (let i = 0; i < 1200 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 250));
  } else {
    rmSync(marker, { force: true }); // a stale marker from an earlier run must not release the other server early
    sh(ui, 'npm', 'run', 'build');
    // Replace the built assets but keep the tracked dist/.gitkeep (go:embed needs the dir to exist).
    for (const f of readdirSync(embedDir)) if (f !== '.gitkeep') rmSync(join(embedDir, f), { recursive: true, force: true });
    for (const f of readdirSync(join(ui, 'dist'))) cpSync(join(ui, 'dist', f), join(embedDir, f), { recursive: true });
    writeFileSync(marker, 'built');
  }
} else if (!existsSync(embedDir)) {
  mkdirSync(embedDir, { recursive: true });
  writeFileSync(join(embedDir, '.gitkeep'), '');
}
const bin = join(work, 'benchd-e2e');
sh(backendDir, 'go', 'build', '-o', bin, './cmd/benchd');
const server = spawn(bin, ['-data', join(work, 'data'), '-addr', `:${PORT}`], { stdio: process.env.E2E_VERBOSE ? 'inherit' : 'ignore' });
const stop = () => { server.kill(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop); server.on('exit', () => process.exit(1));

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${API}/api/projects`)).ok) break; } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 200));
}

const call = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

// ── one project: its own fixture repo, registered, then seeded ───────────────
async function setUpProject(slug, n) {
  const { repo, head, laterCommits } = createFixtureRepo(work, `repo-${n}`);
  const P = `/api/projects/${slug}`;
  await call('POST', '/api/projects', { name: slug, repoPath: repo });

  if (!FRESH) {
    await call('PATCH', `${P}/profile`, {}); // open the write gate
    // ── seed ────────────────────────────────────────────────────────────────────
    const post = (path, body) => call('POST', `${P}${path.replace(/^\/api/, '')}`, body);
    const anchor = (fileId, start) => ({ fileId, commitId: head, lineRange: { start, end: start } });
    const severities = ['critical', 'high', 'medium', 'low', 'info', 'high', 'medium', 'low'];
    const findingFiles = ['src/api.go', 'src/auth/login.go', 'src/auth/session.go', 'src/store/db.go'];
    for (let i = 0; i < 8; i++) {
      await post('/api/findings', {
        anchor: anchor(findingFiles[i % 4], 3 + i), severity: severities[i],
        title: `Finding ${i + 1}`, description: `Seeded finding ${i + 1}`, status: 'open', source: 'manual',
      });
    }
    const kinds = [['interface', 'POST /login'], ['interface', 'GET /users'], ['source', 'sqlite://app.db (read)'], ['sink', 'sqlite://app.db (write)'], ['dependency', 'billing-svc'], ['externality', 'cache prune']];
    for (let i = 0; i < kinds.length; i++) {
      await post('/api/features', { anchor: anchor(findingFiles[i % 4], 10 + i), kind: kinds[i][0], title: kinds[i][1], status: 'active', source: 'manual' });
    }
    for (let i = 0; i < 3; i++) {
      await post('/api/comments', {
        id: `c${i}`, author: 'e2e', text: `comment ${i}`, threadId: `t${i}`, timestamp: '2026-01-01T00:00:00Z',
        anchor: anchor('src/api.go', 20 + i),
      });
    }
    // Annotations on CLAUDE.md (first file in the tree) so Browse has inline cards.
    const guide = await post('/api/findings', { anchor: anchor('CLAUDE.md', 1), severity: 'medium', title: 'Guide finding', description: 'inline card in Browse', status: 'open', source: 'manual' });
    // A comment attached to a finding: its card shows the comment with a refs button.
    await post('/api/comments', { id: 'c-on-finding', author: 'e2e', text: 'comment on the guide finding', threadId: 't-on-finding', timestamp: '2026-01-01T00:00:00Z', findingId: guide.id, anchor: anchor('CLAUDE.md', 1) });
    // Anchored mid-CLAUDE.md, which a later commit rewrites -> orphaned by the reconcile at the end.
    // (A finding there would be auto-closed as resolved; features keep an `orphaned` status.)
    await post('/api/features', { anchor: anchor('CLAUDE.md', 50), kind: 'interface', title: 'GET /legacy', status: 'active', source: 'manual' });
    await post('/api/comments', { id: 'c-guide', author: 'e2e', text: 'guide comment', threadId: 't-guide', timestamp: '2026-01-01T00:00:00Z', anchor: anchor('CLAUDE.md', 1) });

    // Baseline at the first commit, then move the repo so Changes has a delta to show.
    await post('/api/baselines', { reviewer: 'e2e', summary: 'fixture baseline' });
    laterCommits();
    // Timestamps have 1s resolution and the delta uses a strict `>` cutoff.
    await new Promise(r => setTimeout(r, 1200));
    // Activity after the baseline gives the Changes view several items to navigate.
    const newHead = sh(repo, 'git', 'rev-parse', 'HEAD');
    const later = (fileId, line) => ({ fileId, commitId: newHead, lineRange: { start: line, end: line } });
    for (let i = 0; i < 3; i++) {
      await post('/api/findings', { anchor: later('src/api.go', 5 + i), severity: 'high', title: `New finding ${i + 1}`, description: 'after baseline', status: 'open', source: 'manual' });
    }
    await post('/api/comments', { id: 'c-new', author: 'e2e', text: 'after baseline', threadId: 't-new', timestamp: '2026-02-01T00:00:00Z', anchor: later('src/api.go', 9) });
    // Reconcile to HEAD so the deleted file's finding becomes orphaned (drives the orphan badge).
    await post('/api/reconcile', { targetCommit: 'HEAD' });
    await new Promise(r => setTimeout(r, 1500));
  }
}
const slugs = Array.from({ length: COUNT }, (_, i) => `e2e-${i}`);
await Promise.all(slugs.map(setUpProject));
console.log(`[fixture] ready on ${API} projects=${slugs.join(',')}`);
await new Promise(() => {});
