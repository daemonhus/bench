import { describe, it, expect } from 'vitest';
import { blameCells, blameAge } from '../core/blame';

const line = (n: number, commit: string, date = '1700000000') => ({ commit, author: 'A', date, line: n, text: '' });

describe('blameCells', () => {
  it('labels the first line of each run from one commit', () => {
    const cells = blameCells([line(1, 'aaa'), line(2, 'aaa'), line(3, 'bbb'), line(4, 'aaa')]);
    expect(cells.map((c) => c?.start)).toEqual([true, false, true, true]);
    expect(cells[0]?.date.getTime()).toBe(1_700_000_000_000);
  });

  it('indexes by line number and restarts a run after a gap', () => {
    const cells = blameCells([line(2, 'aaa'), line(4, 'aaa')]);
    expect(cells[0]).toBeNull();
    expect(cells[1]?.start).toBe(true);
    expect(cells[2]).toBeNull();
    expect(cells[3]?.start).toBe(true);
  });
});

describe('blameAge', () => {
  const now = Date.UTC(2026, 9, 23);
  const ago = (ms: number) => blameAge(new Date(now - ms), now);
  it('shortens to the largest whole unit', () => {
    expect(ago(10_000)).toBe('1m');
    expect(ago(40 * 60_000)).toBe('40m');
    expect(ago(5 * 3_600_000)).toBe('5h');
    expect(ago(12 * 86_400_000)).toBe('12d');
    expect(ago(92 * 86_400_000)).toBe('3mo');
    expect(ago(800 * 86_400_000)).toBe('2y');
  });
});
