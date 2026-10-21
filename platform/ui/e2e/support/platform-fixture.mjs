// Isolated platform backend for e2e: temp data dir, two registered projects
// backed by throwaway git repos, seeded features/findings, flows (one branched,
// one cross-project) and a saved view. Stays alive until killed.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRepo, sh } from '../../../../e2e/support/fixture-repo.mjs';

const PORT = process.env.E2E_PLATFORM_PORT ?? '8092';
const API = `http://localhost:${PORT}`;
const here = dirname(fileURLToPath(import.meta.url));
const backendDir = join(here, '..', '..', '..', '..', 'backend');

const work = mkdtempSync(join(tmpdir(), 'platform-e2e-'));
const alpha = createFixtureRepo(work, 'alpha');
const beta = createFixtureRepo(work, 'beta');

// The server embeds internal/server/dist at compile time; a clean checkout has none.
const embedDir = join(backendDir, 'internal', 'server', 'dist');
if (!existsSync(embedDir)) {
  mkdirSync(embedDir, { recursive: true });
  writeFileSync(join(embedDir, '.keep'), '');
}

const bin = join(work, 'platform-e2e');
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
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

// ── projects + per-project seed ─────────────────────────────────────────────
const projects = [['alpha', alpha], ['beta', beta]];
const featureIds = {};
for (const [name, fx] of projects) {
  await call('POST', '/api/projects', { name, repoPath: fx.repo });
  const base = `/api/projects/${name}`;
  await call('PATCH', `${base}/profile`, {}); // open the write gate
  const anchor = (fileId, line) => ({ fileId, commitId: fx.head, lineRange: { start: line, end: line } });
  const kinds = [['interface', 'POST /login', 'src/api.go'], ['source', 'sqlite://users.db (read)', 'src/store/db.go'], ['sink', 'sqlite://users.db (write)', 'src/store/db.go'], ['externality', 'session reaper', 'src/auth/session.go']];
  featureIds[name] = [];
  for (let i = 0; i < kinds.length; i++) {
    const f = await call('POST', `${base}/features`, { anchor: anchor(kinds[i][2], 10 + i), kind: kinds[i][0], title: kinds[i][1], status: 'active', source: 'manual' });
    featureIds[name].push(f.id);
  }
  for (let i = 0; i < 3; i++) {
    await call('POST', `${base}/findings`, { anchor: anchor('src/auth/login.go', 3 + i), severity: ['high', 'medium', 'low'][i], title: `${name} finding ${i + 1}`, description: 'seeded', status: 'open', source: 'manual' });
  }
  await call('PATCH', `/api/projects/${name}`, { name, tags: [name === 'alpha' ? 'core' : 'edge'], owner: 'e2e' });
}

// ── flows ───────────────────────────────────────────────────────────────────
const step = (clientId, parentClientId, project, idx, note, branchCondition = '') =>
  ({ clientId, parentClientId, branchCondition, projectSlug: project, featureId: featureIds[project][idx], note });

const login = await call('POST', '/api/flows', { name: 'Login path', description: 'Branched request flow', status: 'active', owner: 'e2e', tags: ['auth', 'core'] });
await call('PUT', `/api/flows/${login.id}/steps`, {
  steps: [
    step('a', '', 'alpha', 0, 'entry'),
    step('b', 'a', 'alpha', 1, 'lookup', 'user exists'),
    step('c', 'b', 'alpha', 2, 'write session'),
    step('d', 'a', 'alpha', 3, 'cleanup', 'user missing'),
  ],
  links: [],
});
// The graph form, created in one call: alpha calls beta across a trust boundary, beta reads its store.
const ref = (clientId, project, idx, note, extra = {}) => ({ clientId, projectSlug: project, featureId: featureIds[project][idx], note, ...extra });
await call('POST', '/api/flows', {
  name: 'Cross project', description: 'Spans alpha and beta', status: 'draft', owner: 'e2e', tags: ['edge'],
  steps: [ref('a', 'alpha', 0, 'alpha entry', { actor: 'anonymous' }), ref('b', 'beta', 0, 'beta entry', { controls: ['authn:jwt'] }), ref('c', 'beta', 1, 'beta read')],
  edges: [
    { from: 'a', to: 'b', kind: 'call', protocol: 'http', auth: 'user', trustBoundary: true, data: 'credentials', tainted: true },
    { from: 'b', to: 'c', kind: 'read', protocol: 'sql' },
  ],
});
await call('POST', '/api/flows', { name: 'Empty flow', description: '', status: 'draft', owner: '', tags: [] });
await call('POST', '/api/flow-views', { name: 'Drafts', query: 'status:draft', owner: 'e2e', isShared: false });

console.log(`[platform-fixture] ready on ${API}`);
await new Promise(() => {});
