// Maps raw reconciler error strings to human-readable explanations.
// The raw error stays available via `raw` for the "show details" affordance.

export interface ReconcileErrorView {
  message: string;
  raw: string;
}

const PREFIX_MAP: Array<{ match: (raw: string) => boolean; message: string }> = [
  {
    match: (r) => r.includes('ancestry check') && r.includes('invalid git ref'),
    message:
      'The target commit could not be found. One or more annotations are anchored to an empty or unknown commit. Re-anchoring those entries should clear this.',
  },
  {
    match: (r) => r.includes('ancestry check'),
    message:
      'Could not establish a git ancestry path between the annotation commit and the current HEAD. The repository may have been rewritten or the ref deleted.',
  },
  {
    match: (r) => r.toLowerCase().includes('not a git repository'),
    message: 'The mounted path is not a git repository. Check the bench container mount.',
  },
  {
    match: (r) => r.toLowerCase().includes('detached head'),
    message: 'The repository is in a detached HEAD state. Check out a branch or pass an explicit target commit.',
  },
];

export function explainReconcileError(raw: string | undefined | null): ReconcileErrorView {
  const r = (raw ?? '').trim();
  if (!r) return { message: 'Reconciliation failed for an unknown reason.', raw: '' };
  for (const { match, message } of PREFIX_MAP) {
    if (match(r)) return { message, raw: r };
  }
  return { message: r, raw: r };
}
