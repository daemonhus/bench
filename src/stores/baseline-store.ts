import { create } from 'zustand';
import type { Baseline, BaselineDelta } from '../core/types';
import { baselinesApi } from '../core/api';

interface BaselineState {
  latestBaseline: Baseline | null;
  delta: BaselineDelta | null;
  pastBaselines: Baseline[];
  isLoading: boolean;

  fetchLatest: () => Promise<void>;
  fetchDelta: () => Promise<void>;
  fetchPastBaselines: () => Promise<void>;
  refreshAll: () => Promise<void>;
  setBaseline: (reviewer?: string, summary?: string, commitId?: string) => Promise<Baseline>;
  deleteBaseline: (id: string) => Promise<void>;
}

export const useBaselineStore = create<BaselineState>((set, get) => ({
  latestBaseline: null,
  delta: null,
  pastBaselines: [],
  isLoading: false,

  fetchLatest: async () => {
    const latest = await baselinesApi.latest();
    set({ latestBaseline: latest });
  },

  fetchDelta: async () => {
    const delta = await baselinesApi.delta();
    set({ delta });
  },

  fetchPastBaselines: async () => {
    const all = await baselinesApi.list().catch(() => []);
    set({ pastBaselines: all });
  },

  refreshAll: async () => {
    const [latest, delta, all] = await Promise.all([
      baselinesApi.latest(),
      baselinesApi.delta(),
      baselinesApi.list().catch(() => [] as Baseline[]),
    ]);
    set({ latestBaseline: latest, delta, pastBaselines: all });
  },

  setBaseline: async (reviewer?: string, summary?: string, commitId?: string) => {
    set({ isLoading: true });
    try {
      const baseline = await baselinesApi.create(reviewer, summary, commitId);
      set({ latestBaseline: baseline, isLoading: false });
      get().fetchDelta();
      get().fetchPastBaselines();
      return baseline;
    } catch (err) {
      set({ isLoading: false });
      throw err;
    }
  },

  deleteBaseline: async (id: string) => {
    set({ isLoading: true });
    try {
      await baselinesApi.delete(id);
      set({ isLoading: false });
      get().refreshAll();
    } catch (err) {
      set({ isLoading: false });
      throw err;
    }
  },
}));
