import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useReconcileStore } from '../stores/reconcile-store';
import type { ReconciledHead, JobSnapshot } from '../core/types';

// Extract the useEffect guard logic from App.tsx into a pure function.
// This mirrors the effect at App.tsx lines ~342-350 (reconcile trigger).
// Testing a pure function is more reliable than testing useEffect directly.

interface ReconcileGuard {
  reconciledForCommit: string | null;
}

function shouldStartReconcile(
  guard: ReconcileGuard,
  currentCommit: string | null,
  reconciledHead: ReconciledHead | null,
): { start: boolean; newGuardValue: string | null } {
  if (!currentCommit) return { start: false, newGuardValue: guard.reconciledForCommit };
  if (guard.reconciledForCommit === currentCommit) return { start: false, newGuardValue: guard.reconciledForCommit };
  if (reconciledHead && !reconciledHead.isFullyReconciled) {
    return { start: true, newGuardValue: currentCommit };
  }
  return { start: false, newGuardValue: guard.reconciledForCommit };
}

describe('reconcile retry guard (pure function)', () => {
  it('starts reconcile on first call for a commit', () => {
    const guard: ReconcileGuard = { reconciledForCommit: null };
    const head: ReconciledHead = {
      reconciledHead: 'old-commit',
      gitHead: 'abc123',
      isFullyReconciled: false,
      unreconciled: [],
    };

    const result = shouldStartReconcile(guard, 'abc123', head);
    expect(result.start).toBe(true);
    expect(result.newGuardValue).toBe('abc123');
  });

  it('does NOT re-start reconcile for the same commit (prevents infinite loop)', () => {
    // Simulate: first call starts reconcile
    const guard: ReconcileGuard = { reconciledForCommit: null };
    const head: ReconciledHead = {
      reconciledHead: 'old',
      gitHead: 'abc123',
      isFullyReconciled: false,
      unreconciled: [{ fileId: 'src/x.py', lastReconciledCommit: 'old', commitsAhead: 2 }],
    };

    const r1 = shouldStartReconcile(guard, 'abc123', head);
    expect(r1.start).toBe(true);
    guard.reconciledForCommit = r1.newGuardValue;

    // Simulate: reconcile fails, fetchHead() runs, reconciledHead object updates
    // (but still not fully reconciled — this caused the infinite loop)
    const headAfterFail: ReconciledHead = {
      reconciledHead: 'old',
      gitHead: 'abc123',
      isFullyReconciled: false,
      unreconciled: [{ fileId: 'src/x.py', lastReconciledCommit: 'old', commitsAhead: 2 }],
    };

    const r2 = shouldStartReconcile(guard, 'abc123', headAfterFail);
    expect(r2.start).toBe(false); // KEY: guard prevents retry
  });

  it('starts reconcile when switching to a NEW commit', () => {
    const guard: ReconcileGuard = { reconciledForCommit: 'abc123' };
    const head: ReconciledHead = {
      reconciledHead: 'abc123',
      gitHead: 'def456',
      isFullyReconciled: false,
      unreconciled: [],
    };

    const result = shouldStartReconcile(guard, 'def456', head);
    expect(result.start).toBe(true);
    expect(result.newGuardValue).toBe('def456');
  });

  it('does not start reconcile when already fully reconciled', () => {
    const guard: ReconcileGuard = { reconciledForCommit: null };
    const head: ReconciledHead = {
      reconciledHead: 'abc123',
      gitHead: 'abc123',
      isFullyReconciled: true,
      unreconciled: [],
    };

    const result = shouldStartReconcile(guard, 'abc123', head);
    expect(result.start).toBe(false);
  });

  it('does not start reconcile when currentCommit is null', () => {
    const guard: ReconcileGuard = { reconciledForCommit: null };
    const head: ReconciledHead = {
      reconciledHead: null,
      gitHead: 'abc123',
      isFullyReconciled: false,
      unreconciled: [],
    };

    const result = shouldStartReconcile(guard, null, head);
    expect(result.start).toBe(false);
  });

  it('does not start reconcile when head is null (still loading)', () => {
    const guard: ReconcileGuard = { reconciledForCommit: null };
    const result = shouldStartReconcile(guard, 'abc123', null);
    expect(result.start).toBe(false);
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
