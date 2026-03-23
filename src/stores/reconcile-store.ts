import { create } from 'zustand';
import type { ReconciledHead, JobSnapshot } from '../core/types';
import { reconcileApi } from '../core/api';

interface ReconcileState {
  head: ReconciledHead | null;
  activeJob: JobSnapshot | null;
  loading: boolean;
  error: string | null;

  fetchHead: () => Promise<void>;
  startReconcile: (targetCommit: string, filePaths?: string[]) => Promise<void>;
  pollJob: (jobId: string) => void;
  stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useReconcileStore = create<ReconcileState>((set, get) => ({
  head: null,
  activeJob: null,
  loading: false,
  error: null,

  fetchHead: async () => {
    try {
      const head = await reconcileApi.head();
      set({ head });
    } catch (err) {
      console.error('Failed to fetch reconciled head:', err);
    }
  },

  startReconcile: async (targetCommit, filePaths) => {
    set({ loading: true, error: null });
    try {
      const job = await reconcileApi.start(targetCommit, filePaths);
      set({ activeJob: job, loading: false });
      if (job.status === 'pending' || job.status === 'running') {
        get().pollJob(job.jobId);
      }
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  pollJob: (jobId) => {
    get().stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const job = await reconcileApi.jobStatus(jobId);
        set({ activeJob: job });
        if (job.status === 'done' || job.status === 'failed') {
          get().stopPolling();
          // Refresh head after job completes
          get().fetchHead();
        }
      } catch {
        get().stopPolling();
      }
    }, 1000);
  },

  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));
