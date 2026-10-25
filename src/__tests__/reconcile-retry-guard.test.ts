import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useReconcileStore, reconcileTarget } from '../stores/reconcile-store';
import type { ReconciledHead, JobSnapshot } from '../core/types';

const head = (over: Partial<ReconciledHead>): ReconciledHead => ({
  reconciledHead: 'old',
  gitHead: 'checked-out',
  tip: 'tip1',
  isFullyReconciled: false,
  unreconciled: [{ fileId: 'src/x.py', lastReconciledCommit: 'old', commitsAhead: 2 }],
  ...over,
});

describe('reconcileTarget', () => {
  it("reconciles to the review branch's head, not the checked-out one", () => {
    expect(reconcileTarget(head({}), null)).toBe('tip1');
  });

  it('does not try the same head again (a failed run must not loop)', () => {
    expect(reconcileTarget(head({}), 'tip1')).toBeNull();
  });

  it('tries again when the head moves (a new commit, another branch)', () => {
    expect(reconcileTarget(head({ tip: 'tip2' }), 'tip1')).toBe('tip2');
  });

  it('does nothing when already fully reconciled', () => {
    expect(reconcileTarget(head({ isFullyReconciled: true, unreconciled: [] }), null)).toBeNull();
  });

  it('does nothing while the head is loading', () => {
    expect(reconcileTarget(null, null)).toBeNull();
  });
});

describe('reconcile store integration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useReconcileStore.setState({
      head: null,
      activeJob: null,
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useReconcileStore.getState().stopPolling();
  });

  it('startReconcile sets activeJob from API response', async () => {
    const jobResponse: JobSnapshot = {
      jobId: 'rec-1',
      status: 'running',
      targetCommit: 'abc123',
      progress: { filesTotal: 0, filesDone: 0, commitsTotal: 0, commitsDone: 0, currentFile: '' },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: () => Promise.resolve(jobResponse),
    });

    await useReconcileStore.getState().startReconcile('abc123');
    const state = useReconcileStore.getState();
    state.stopPolling(); // stop before assertions to prevent timer leaks

    expect(state.activeJob).not.toBeNull();
    expect(state.activeJob!.jobId).toBe('rec-1');
    expect(state.activeJob!.status).toBe('running');
  });

  it('startReconcile sets error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network error'));

    await useReconcileStore.getState().startReconcile('abc123');
    const state = useReconcileStore.getState();

    expect(state.error).toContain('network error');
    expect(state.loading).toBe(false);
    expect(state.activeJob).toBeNull();
  });
});
