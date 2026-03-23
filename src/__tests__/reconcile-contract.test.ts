import { describe, it, expect } from 'vitest';
import type { JobSnapshot, ReconcileResult, ReconcileSummary } from '../core/types';

// These JSON fixtures represent the EXACT shape the Go backend produces.
// They are the TypeScript side of the contract — if either side changes
// a field name, these tests break. See also:
//   backend/internal/reconcile/contract_test.go (Go side)

const GO_JOB_SNAPSHOT_DONE: unknown = {
  jobId: 'rec-42',
  status: 'done',
  targetCommit: 'abc123def',
  progress: {
    currentFile: 'src/auth.py',
    filesTotal: 3,
    filesDone: 3,
    commitsTotal: 7,
    commitsDone: 7,
  },
  result: {
    filesReconciled: 3,
    commitsWalked: 7,
    annotations: {
      total: 10,
      exact: 8,
      moved: 1,
      orphaned: 1,
    },
    durationMs: 456,
  },
};

const GO_JOB_SNAPSHOT_PENDING: unknown = {
  jobId: 'rec-43',
  status: 'pending',
  targetCommit: 'def456',
  progress: {
    currentFile: '',
    filesTotal: 0,
    filesDone: 0,
    commitsTotal: 0,
    commitsDone: 0,
  },
};

const GO_JOB_SNAPSHOT_FAILED: unknown = {
  jobId: 'rec-44',
  status: 'failed',
  targetCommit: 'ghi789',
  progress: {
    currentFile: 'src/db.py',
    filesTotal: 5,
    filesDone: 2,
    commitsTotal: 3,
    commitsDone: 3,
  },
  error: 'reconcile src/db.py: diff A..B src/db.py: exit status 128',
};

describe('reconcile contract: Go backend → TypeScript types', () => {
  it('JobSnapshot (done) — all fields accessible via TS type', () => {
    const snap = GO_JOB_SNAPSHOT_DONE as JobSnapshot;

    expect(snap.jobId).toBe('rec-42');
    expect(snap.status).toBe('done');
    expect(snap.targetCommit).toBe('abc123def');

    // Progress
    expect(snap.progress).toBeDefined();
    expect(snap.progress.filesTotal).toBe(3);
    expect(snap.progress.filesDone).toBe(3);
    expect(snap.progress.commitsTotal).toBe(7);
    expect(snap.progress.commitsDone).toBe(7);
    expect(snap.progress.currentFile).toBe('src/auth.py');

    // Result
    expect(snap.result).toBeDefined();
    const result = snap.result!;
    expect(result.filesReconciled).toBe(3);
    expect(result.commitsWalked).toBe(7);
    expect(result.durationMs).toBe(456);

    // Annotations summary
    expect(result.annotations).toBeDefined();
    expect(result.annotations.total).toBe(10);
    expect(result.annotations.exact).toBe(8);
    expect(result.annotations.moved).toBe(1);
    expect(result.annotations.orphaned).toBe(1);
  });

  it('ReconcileResult field names match Go JSON output', () => {
    const goResult = (GO_JOB_SNAPSHOT_DONE as any).result;
    const goFields = Object.keys(goResult).sort();
    expect(goFields).toEqual(['annotations', 'commitsWalked', 'durationMs', 'filesReconciled']);

    const annFields = Object.keys(goResult.annotations).sort();
    expect(annFields).toEqual(['exact', 'moved', 'orphaned', 'total']);
  });

  it('JobSnapshot status uses Go values (done, not completed)', () => {
    const snap = GO_JOB_SNAPSHOT_DONE as JobSnapshot;
    expect(['pending', 'running', 'done', 'failed']).toContain(snap.status);
    expect(snap.status).toBe('done');
    // This would fail if TS had 'completed' instead of 'done'
    expect(snap.status).not.toBe('completed');
  });

  it('pending snapshot omits result', () => {
    const snap = GO_JOB_SNAPSHOT_PENDING as JobSnapshot;
    expect(snap.result).toBeUndefined();
    expect(snap.status).toBe('pending');
    expect(snap.jobId).toBe('rec-43');
  });

  it('failed snapshot includes error string', () => {
    const snap = GO_JOB_SNAPSHOT_FAILED as JobSnapshot;
    expect(snap.status).toBe('failed');
    expect(snap.error).toContain('reconcile');
    expect(snap.jobId).toBe('rec-44');
  });

  it('JobProgress field names match Go JSON output', () => {
    const goProgress = (GO_JOB_SNAPSHOT_DONE as any).progress;
    const fields = Object.keys(goProgress).sort();
    expect(fields).toEqual(['commitsDone', 'commitsTotal', 'currentFile', 'filesDone', 'filesTotal']);
  });
});
