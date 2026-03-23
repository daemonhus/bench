import { useMemo } from 'react';
import { useRepoStore } from '../stores/repo-store';

/**
 * Returns a map of full commit hash → local branch names.
 * Resolves the short hashes returned by the branches API to full hashes
 * using the commit list so lookups against full hashes always work.
 */
export function useBranchMap(): Map<string, string[]> {
  const branches = useRepoStore((s) => s.branches);
  const commits = useRepoStore((s) => s.commits);
  return useMemo(() => {
    const m = new Map<string, string[]>();
    for (const b of branches) {
      if (b.isRemote) continue; // remote tracking refs shown in picker but not as badges
      const commit = commits.find(c => c.shortHash === b.head || c.hash.startsWith(b.head));
      const key = commit?.hash ?? b.head;
      const existing = m.get(key) ?? [];
      if (!existing.includes(b.name)) existing.push(b.name);
      m.set(key, existing);
    }
    return m;
  }, [branches, commits]);
}
