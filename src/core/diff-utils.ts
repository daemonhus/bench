/**
 * Returns the empty-state message for the diff view, or null if DiffView should render.
 */
export function getDiffEmptyMessage(opts: {
  changesCount: number;
  selectedFilePath: string | null;
  diffLoading: boolean;
  compareFrom: string;
  compareTo: string;
}): string | null {
  if (opts.changesCount > 0) return null;
  if (!opts.selectedFilePath) return 'Select a file from the tree first.';
  if (opts.diffLoading) return 'Loading diff...';
  if (!opts.compareFrom || !opts.compareTo) return 'Select commits from the left panel to compare.';
  return 'No changes in this file between the selected commits.';
}
