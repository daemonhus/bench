import { create } from 'zustand';
import type { DiffHunk, DiffChange } from '../core/types';
import { parseDiff } from '../core/diff-parser';
import { gitApi } from '../core/api';

interface DiffState {
  hunks: DiffHunk[];
  changes: DiffChange[];
  loadDiffFromApi: (from: string, to: string, path: string) => Promise<void>;
  clear: () => void;
}

export const useDiffStore = create<DiffState>((set) => ({
  hunks: [],
  changes: [],
  loadDiffFromApi: async (from, to, path) => {
    const result = await gitApi.getDiff(from, to, path);
    const hunks = parseDiff(result.raw);
    const changes = hunks.flatMap((h) => h.changes);
    set({ hunks, changes });
  },
  clear: () => set({ hunks: [], changes: [] }),
}));
