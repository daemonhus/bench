import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDiffStore } from '../stores/diff-store';
import { getDiffEmptyMessage } from '../core/diff-utils';

// ---- diff-store tests (mocked fetch) ----

describe('diff-store', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useDiffStore.setState({ hunks: [], changes: [] });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('loadDiffFromApi populates hunks and changes from valid diff', async () => {
    const rawDiff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old line',
      '+new line',
      ' line3',
    ].join('\n');

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ raw: rawDiff, fullContent: '' }),
    });

    await useDiffStore.getState().loadDiffFromApi('abc', 'def', 'file.ts');

    const { hunks, changes } = useDiffStore.getState();
    expect(hunks).toHaveLength(1);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.map((c) => c.type)).toContain('delete');
    expect(changes.map((c) => c.type)).toContain('insert');
  });

  it('loadDiffFromApi results in empty changes for empty diff', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ raw: '', fullContent: '' }),
    });

    await useDiffStore.getState().loadDiffFromApi('abc', 'def', 'file.ts');

    const { hunks, changes } = useDiffStore.getState();
    expect(hunks).toHaveLength(0);
    expect(changes).toHaveLength(0);
  });

  it('loadDiffFromApi rejects on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(
      useDiffStore.getState().loadDiffFromApi('abc', 'def', 'file.ts'),
    ).rejects.toThrow();

    // changes should remain empty (set was never called)
    expect(useDiffStore.getState().changes).toHaveLength(0);
  });

  it('clear resets state', () => {
    useDiffStore.setState({
      hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, changes: [] }],
      changes: [{ id: '1', type: 'normal', content: 'x', oldLine: 1, newLine: 1 }],
    });

    useDiffStore.getState().clear();

    const state = useDiffStore.getState();
    expect(state.hunks).toHaveLength(0);
    expect(state.changes).toHaveLength(0);
  });
});

// ---- Auto-compare condition logic ----

describe('auto-compare conditions', () => {
  // This mirrors the guard in the useEffect in App.tsx
  function shouldAutoCompare(
    viewMode: string,
    compareFrom: string,
    compareTo: string,
    selectedFilePath: string | null,
  ): boolean {
    return viewMode === 'diff' && !!compareFrom && !!compareTo && !!selectedFilePath;
  }

  it('triggers when all conditions are met', () => {
    expect(shouldAutoCompare('diff', 'abc', 'def', 'file.ts')).toBe(true);
  });

  it('does not trigger in browse mode', () => {
    expect(shouldAutoCompare('browse', 'abc', 'def', 'file.ts')).toBe(false);
  });

  it('does not trigger without from commit', () => {
    expect(shouldAutoCompare('diff', '', 'def', 'file.ts')).toBe(false);
  });

  it('does not trigger without to commit', () => {
    expect(shouldAutoCompare('diff', 'abc', '', 'file.ts')).toBe(false);
  });

  it('does not trigger without selected file', () => {
    expect(shouldAutoCompare('diff', 'abc', 'def', null)).toBe(false);
  });
});

// ---- Diff empty-state message logic ----
// Tests the actual function imported by App.tsx

describe('getDiffEmptyMessage', () => {
  it('returns null (show DiffView) when there are changes', () => {
    expect(getDiffEmptyMessage({
      changesCount: 3,
      selectedFilePath: 'file.ts',
      diffLoading: false,
      compareFrom: 'abc',
      compareTo: 'def',
    })).toBeNull();
  });

  it('prompts for file when none selected', () => {
    expect(getDiffEmptyMessage({
      changesCount: 0,
      selectedFilePath: null,
      diffLoading: false,
      compareFrom: 'abc',
      compareTo: 'def',
    })).toBe('Select a file from the tree first.');
  });

  it('shows loading when diff is loading', () => {
    expect(getDiffEmptyMessage({
      changesCount: 0,
      selectedFilePath: 'file.ts',
      diffLoading: true,
      compareFrom: 'abc',
      compareTo: 'def',
    })).toBe('Loading diff...');
  });

  it('prompts for commits when from is missing', () => {
    expect(getDiffEmptyMessage({
      changesCount: 0,
      selectedFilePath: 'file.ts',
      diffLoading: false,
      compareFrom: '',
      compareTo: 'def',
    })).toBe('Select commits from the left panel to compare.');
  });

  it('prompts for commits when to is missing', () => {
    expect(getDiffEmptyMessage({
      changesCount: 0,
      selectedFilePath: 'file.ts',
      diffLoading: false,
      compareFrom: 'abc',
      compareTo: '',
    })).toBe('Select commits from the left panel to compare.');
  });

  it('shows no-changes when both commits set but diff is empty', () => {
    expect(getDiffEmptyMessage({
      changesCount: 0,
      selectedFilePath: 'file.ts',
      diffLoading: false,
      compareFrom: 'abc',
      compareTo: 'def',
    })).toBe('No changes in this file between the selected commits.');
  });
});
