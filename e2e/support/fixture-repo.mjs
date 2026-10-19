// Deterministic throwaway git repo shared by the bench and platform e2e fixtures.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, stdio: 'pipe' }).toString().trim();
const lines = (name, n) => Array.from({ length: n }, (_, i) => `// ${name} line ${i + 1}`).join('\n') + '\n';

export const FIXTURE_FILES = ['src/api.go', 'src/auth/login.go', 'src/auth/session.go', 'src/store/db.go'];

/**
 * Creates <work>/<name> with folders to expand and one commit.
 * Returns { repo, head, laterCommits } - call laterCommits() to add two more
 * commits (so a baseline taken at `head` has a delta to show).
 */
export function createFixtureRepo(work, name = 'repo') {
  const repo = join(work, name);
  mkdirSync(join(repo, 'src', 'auth'), { recursive: true });
  mkdirSync(join(repo, 'src', 'store'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  sh(work, 'git', 'init', '-q', '-b', 'main', repo);
  sh(repo, 'git', 'config', 'user.email', 'e2e@example.com');
  sh(repo, 'git', 'config', 'user.name', 'E2E');
  const files = {
    'README.md': '# fixture\n',
    // First file in the tree (case-sensitive sort), so it is what Browse tests open:
    // long enough to scroll.
    'CLAUDE.md': '# Fixture agent guide\n\nA small repo used by the e2e suites.\n' + lines('guide', 120),
    'src/api.go': lines('api', 60),
    'src/auth/login.go': lines('login', 40),
    'src/auth/session.go': lines('session', 40),
    'src/store/db.go': lines('db', 50),
    'docs/notes.md': '# notes\n',
  };
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  sh(repo, 'git', 'add', '.');
  sh(repo, 'git', 'commit', '-q', '-m', 'initial');
  const head = sh(repo, 'git', 'rev-parse', 'HEAD');
  const laterCommits = () => {
    writeFileSync(join(repo, 'src/api.go'), lines('api', 60) + '// added\n');
    sh(repo, 'git', 'commit', '-q', '-am', 'touch api');
    writeFileSync(join(repo, 'src/store/db.go'), lines('db', 50) + '// added\n');
    sh(repo, 'git', 'commit', '-q', '-am', 'touch db');
    // Rewrite CLAUDE.md below its first 3 lines: annotations anchored there lose
    // their code and become orphaned at the next reconcile.
    writeFileSync(join(repo, 'CLAUDE.md'), '# Fixture agent guide\n\nA small repo used by the e2e suites.\n' + lines('rewritten', 120));
    sh(repo, 'git', 'commit', '-q', '-am', 'rewrite guide');
  };
  return { repo, head, laterCommits };
}
