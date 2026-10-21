// Display helpers for a project's repository: a browsable URL for its remote, a short label for its path.

/** Convert a git remote URL (SSH or HTTPS) to an HTTP browse URL. */
export function remoteToHttp(raw: string): string | null {
  if (!raw) return null;
  // SSH: git@github.com:org/repo.git
  const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  // ssh://git@host/org/repo.git
  const sshProto = raw.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshProto) return `https://${sshProto[1]}/${sshProto[2]}`;
  // HTTPS: https://github.com/org/repo.git
  if (raw.startsWith('http')) return raw.replace(/\.git$/, '');
  return null;
}

/** Show the repository's own name (and its parent) rather than a long absolute path; the full path is in the tooltip. */
export function repoLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : path;
}
