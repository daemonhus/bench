import { create } from 'zustand';
import type { ReconciledHead, JobSnapshot } from '../core/types';
import { reconcileApi } from '../core/api';

interface ReconcileState {
  head: ReconciledHead | null;
  activeJob: JobSnapshot | null;
  loading: boolean;
  error: string | null;
  // Last commit for which we auto-triggered a reconcile. The auto-trigger
  // effect skips when this matches the current commit. Cleared by retry()
  // so a failed run can be re-armed without remounting.
  lastReconciledHead: string | null;

  fetchHead: () => Promise<void>;
  startReconcile: (targetCommit: string, filePaths?: string[]) => Promise<void>;
  retry: (targetCommit: string) => Promise<void>;
  pollJob: (jobId: string) => void;
  stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useReconcileStore = create<ReconcileState>((set, get) => ({
  head: null,
  activeJob: null,
  loading: false,
  error: null,
  lastReconciledHead: null,

  fetchHead: async () => {
    try {
      const head = await reconcileApi.head();
      set({ head });
    } catch (err) {
      console.error('Failed to fetch reconciled head:', err);
    }
  },

  startReconcile: async (targetCommit, filePaths) => {
    set({ loading: true, error: null, lastReconciledHead: targetCommit });
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

  retry: async (targetCommit) => {
    // Clear the auto-trigger guard so the effect re-arms after a failed run,
    // then kick off a fresh reconcile for the same commit.
    set({ lastReconciledHead: null, activeJob: null, error: null });
    await get().startReconcile(targetCommit);
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
