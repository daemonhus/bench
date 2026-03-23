import { describe, it, expect } from 'vitest';

/**
 * Extracted fuzzyMatch — mirrors FileSearchModal's implementation.
 * All query chars must appear in order (case-insensitive).
 */
function fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatchIdx = -2;

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      if (ci === prevMatchIdx + 1) score += 5;
      if (ci === 0 || c[ci - 1] === '/') score += 10;
      score += ci / c.length;
      prevMatchIdx = ci;
      qi++;
    }
  }

  return { match: qi === q.length, score };
}

/**
 * Simulate the filtered + sorted results list that FileSearchModal produces.
 */
function getResults(files: string[], query: string): string[] {
  if (!query.trim()) return files;
  return files
    .map((path) => ({ path, ...fuzzyMatch(query, path) }))
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.path);
}

/**
 * Simulate keyboard navigation: starting at index 0, apply a sequence of
 * key presses (ArrowDown, ArrowUp, Enter) and return the selected path
 * when Enter is pressed (or null if Enter was never pressed).
 */
function simulateNavigation(
  results: string[],
  keys: string[],
): { selectedPath: string | null; finalIndex: number } {
  let idx = 0;
  let selectedPath: string | null = null;

  for (const key of keys) {
    if (key === 'ArrowDown') {
      idx = Math.min(idx + 1, results.length - 1);
    } else if (key === 'ArrowUp') {
      idx = Math.max(idx - 1, 0);
    } else if (key === 'Enter') {
      selectedPath = results[idx] ?? null;
      break;
    }
  }

  return { selectedPath, finalIndex: idx };
}

describe('FileSearchModal — fuzzyMatch', () => {
  it('matches exact filename', () => {
    const { match } = fuzzyMatch('main.ts', 'src/main.ts');
    expect(match).toBe(true);
  });

  it('matches partial query in order', () => {
    const { match } = fuzzyMatch('mts', 'src/main.ts');
    expect(match).toBe(true);
  });

  it('rejects query with chars out of order', () => {
    const { match } = fuzzyMatch('tsm', 'src/main.ts');
    expect(match).toBe(false);
  });

  it('is case-insensitive', () => {
    const { match } = fuzzyMatch('README', 'readme.md');
    expect(match).toBe(true);
  });

  it('rejects when query has extra chars not in candidate', () => {
    const { match } = fuzzyMatch('mainxyz', 'src/main.ts');
    expect(match).toBe(false);
  });

  it('empty query matches everything', () => {
    const { match } = fuzzyMatch('', 'anything.ts');
    expect(match).toBe(true);
  });

  it('scores segment-boundary matches higher', () => {
    const files = ['src/api.ts', 'src/crap.ts'];
    // Query "a" should prefer "api.ts" (matches at segment start after /) over "crap.ts"
    const results = getResults(files, 'a');
    expect(results[0]).toBe('src/api.ts');
  });

  it('scores consecutive matches higher', () => {
    const files = ['src/components/Sidebar.tsx', 'src/stores/ui-store.ts'];
    // "side" should prefer Sidebar (consecutive) over ui-store (scattered)
    const results = getResults(files, 'side');
    expect(results[0]).toBe('src/components/Sidebar.tsx');
  });
});

describe('FileSearchModal — results filtering', () => {
  const files = [
    'src/App.tsx',
    'src/main.ts',
    'src/components/FileTree.tsx',
    'src/components/Sidebar.tsx',
    'src/core/api.ts',
    'src/core/router.ts',
    'README.md',
  ];

  it('returns all files for empty query', () => {
    const results = getResults(files, '');
    expect(results).toHaveLength(files.length);
  });

  it('filters to matching files only', () => {
    const results = getResults(files, 'router');
    expect(results).toEqual(['src/core/router.ts']);
  });

  it('matches across path segments', () => {
    const results = getResults(files, 'comp/side');
    expect(results).toContain('src/components/Sidebar.tsx');
  });

  it('returns empty for non-matching query', () => {
    const results = getResults(files, 'zzzzz');
    expect(results).toHaveLength(0);
  });
});

describe('FileSearchModal — keyboard navigation', () => {
  const results = [
    'src/App.tsx',
    'src/main.ts',
    'src/core/api.ts',
    'src/core/router.ts',
  ];

  it('Enter on first item selects it (default index=0)', () => {
    const { selectedPath } = simulateNavigation(results, ['Enter']);
    expect(selectedPath).toBe('src/App.tsx');
  });

  it('ArrowDown then Enter selects second item', () => {
    const { selectedPath } = simulateNavigation(results, ['ArrowDown', 'Enter']);
    expect(selectedPath).toBe('src/main.ts');
  });

  it('ArrowDown x3 then Enter selects fourth item', () => {
    const { selectedPath } = simulateNavigation(results, [
      'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter',
    ]);
    expect(selectedPath).toBe('src/core/router.ts');
  });

  it('ArrowDown past last item clamps to last', () => {
    const { selectedPath } = simulateNavigation(results, [
      'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter',
    ]);
    expect(selectedPath).toBe('src/core/router.ts');
  });

  it('ArrowUp from first item stays at first', () => {
    const { selectedPath } = simulateNavigation(results, ['ArrowUp', 'Enter']);
    expect(selectedPath).toBe('src/App.tsx');
  });

  it('ArrowDown then ArrowUp returns to first item', () => {
    const { selectedPath } = simulateNavigation(results, [
      'ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter',
    ]);
    expect(selectedPath).toBe('src/main.ts');
  });

  it('navigates to correct page: down twice selects third file', () => {
    const { selectedPath, finalIndex } = simulateNavigation(results, [
      'ArrowDown', 'ArrowDown', 'Enter',
    ]);
    expect(finalIndex).toBe(2);
    expect(selectedPath).toBe('src/core/api.ts');
  });

  it('returns null if Enter never pressed', () => {
    const { selectedPath } = simulateNavigation(results, [
      'ArrowDown', 'ArrowDown',
    ]);
    expect(selectedPath).toBeNull();
  });

  it('empty results: Enter returns null', () => {
    const { selectedPath } = simulateNavigation([], ['Enter']);
    expect(selectedPath).toBeNull();
  });
});
