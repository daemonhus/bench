import { describe, it, expect } from 'vitest';
import { buildFindingsTimeline, bucketStart, isRemoved } from '../core/findings-timeline';
import type { Finding, FindingStatus } from '../core/types';

let seq = 0;
function find(createdAt: string, status: FindingStatus = 'open', resolvedAt?: string): Finding {
  return {
    id: `f-${seq++}`,
    anchor: { fileId: 'a.go', commitId: 'c1' },
    severity: 'medium',
    title: 't',
    description: '',
    cwe: '', cve: '', vector: '', score: 0,
    status,
    source: 'manual',
    createdAt,
    resolvedAt,
  };
}

const NOW = new Date('2026-01-29T12:00:00Z'); // a Thursday

describe('bucketStart', () => {
  it('snaps weeks back to Monday in UTC', () => {
    expect(bucketStart(new Date('2026-01-29T12:00:00Z'), 'week').toISOString().slice(0, 10)).toBe('2026-01-26');
    // Sunday belongs to the week that started the previous Monday.
    expect(bucketStart(new Date('2026-02-01T23:00:00Z'), 'week').toISOString().slice(0, 10)).toBe('2026-01-26');
  });

  it('snaps months and years', () => {
    expect(bucketStart(new Date('2026-01-29T12:00:00Z'), 'month').toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(bucketStart(new Date('2026-07-29T12:00:00Z'), 'year').toISOString().slice(0, 10)).toBe('2026-01-01');
  });
});

describe('isRemoved', () => {
  it('counts every terminal status, not just closed', () => {
    expect(isRemoved(find('2026-01-01', 'closed'))).toBe(true);
    expect(isRemoved(find('2026-01-01', 'accepted'))).toBe(true);
    expect(isRemoved(find('2026-01-01', 'false-positive'))).toBe(true);
    expect(isRemoved(find('2026-01-01', 'open'))).toBe(false);
    expect(isRemoved(find('2026-01-01', 'in-progress'))).toBe(false);
    expect(isRemoved(find('2026-01-01', 'draft'))).toBe(false);
  });

  it('counts a resolving commit as removal even without a terminal status', () => {
    const f = { ...find('2026-01-01', 'open'), resolvedCommit: 'abc123' };
    expect(isRemoved(f)).toBe(true);
  });
});

describe('buildFindingsTimeline', () => {
  it('tracks added, removed, and the resulting backlog per bucket', () => {
    const findings = [
      // Week of Jan 5: three raised.
      find('2026-01-05T10:00:00Z'),
      find('2026-01-06T10:00:00Z'),
      find('2026-01-07T10:00:00Z'),
      // Week of Jan 12: one raised, two removed (one closed, one accepted).
      find('2026-01-12T10:00:00Z'),
      find('2026-01-05T10:00:00Z', 'closed', '2026-01-13T10:00:00Z'),
      find('2026-01-05T10:00:00Z', 'accepted', '2026-01-14T10:00:00Z'),
    ];
    const { buckets, undated } = buildFindingsTimeline(findings, 'week', NOW);
    expect(undated).toBe(0);

    const by = new Map(buckets.map((b) => [b.start, b]));
    expect(by.get('2026-01-05')).toMatchObject({ added: 5, removed: 0, open: 5 });
    expect(by.get('2026-01-12')).toMatchObject({ added: 1, removed: 2, open: 4 });
    // Backlog carries forward through quiet buckets.
    expect(by.get('2026-01-19')).toMatchObject({ added: 0, removed: 0, open: 4 });
    expect(by.get('2026-01-26')).toMatchObject({ added: 0, removed: 0, open: 4 });
  });

  it('runs contiguously from the first event to now, so gaps show as gaps', () => {
    const { buckets } = buildFindingsTimeline([find('2026-01-05T10:00:00Z')], 'week', NOW);
    expect(buckets.map((b) => b.start)).toEqual([
      '2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26',
    ]);
  });

  it('counts removals with no resolvedAt as undated rather than dropping them', () => {
    // Pre-existing accepted findings have a NULL resolved_at.
    const findings = [
      find('2026-01-05T10:00:00Z'),
      find('2026-01-05T10:00:00Z', 'accepted'),
    ];
    const { buckets, undated } = buildFindingsTimeline(findings, 'week', NOW);
    expect(undated).toBe(1);
    // The undated removal never lands in a bucket, so the backlog does not dip.
    expect(buckets[0]).toMatchObject({ added: 2, removed: 0, open: 2 });
  });

  it('buckets by month and by year', () => {
    const findings = [find('2026-01-05T10:00:00Z'), find('2026-01-20T10:00:00Z')];
    const month = buildFindingsTimeline(findings, 'month', NOW);
    expect(month.buckets).toHaveLength(1);
    expect(month.buckets[0]).toMatchObject({ start: '2026-01-01', added: 2, open: 2 });

    const year = buildFindingsTimeline(findings, 'year', NOW);
    expect(year.buckets).toHaveLength(1);
    expect(year.buckets[0]).toMatchObject({ start: '2026-01-01', added: 2, open: 2 });
  });

  it('returns nothing for no findings', () => {
    expect(buildFindingsTimeline([], 'week', NOW)).toEqual({ buckets: [], undated: 0 });
  });
});
