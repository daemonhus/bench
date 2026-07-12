import type { Finding } from './types';

// ---------------------------------------------------------------------------
// Findings timeline: how the open set moved over time. Each bucket carries the
// findings raised in it, the ones that left the open set in it (fixed, accepted,
// or dismissed), and the resulting backlog at the end of the bucket.
//
// A removal is dated by resolvedAt, which the backend stamps whenever a finding
// reaches a terminal status. Findings that reached one before that stamping
// existed carry no date and cannot be placed in a bucket - they are counted in
// `undated` so the caller can say so rather than silently dropping them.
// ---------------------------------------------------------------------------

export const TIMELINE_SCALES = ['week', 'month', 'year'] as const;
export type TimelineScale = (typeof TIMELINE_SCALES)[number];

export interface FindingsBucket {
  /** Bucket start, ISO yyyy-mm-dd (UTC). */
  start: string;
  label: string;
  added: number;
  removed: number;
  /** Findings still open at the end of this bucket. */
  open: number;
}

export interface FindingsTimeline {
  buckets: FindingsBucket[];
  /** Removed findings with no resolvedAt - cannot be bucketed. */
  undated: number;
}

const TERMINAL = new Set(['closed', 'accepted', 'false-positive']);

/** A finding is out of the open set once it reaches a terminal status or
 *  carries a resolving commit. Mirrors isTerminalStatus in the backend. */
export function isRemoved(f: Finding): boolean {
  return TERMINAL.has(f.status) || !!f.resolvedCommit;
}

export function parseDate(s?: string): Date | null {
  if (!s) return null;
  // SQLite hands back "2026-07-12 15:03:51" (UTC, no zone marker).
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** Start of the period containing d, in UTC. Weeks start Monday. */
export function bucketStart(d: Date, scale: TimelineScale): Date {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (scale === 'year') return new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  if (scale === 'month') return new Date(Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), 1));
  const dow = (u.getUTCDay() + 6) % 7; // Monday = 0
  u.setUTCDate(u.getUTCDate() - dow);
  return u;
}

function nextBucket(d: Date, scale: TimelineScale): Date {
  if (scale === 'year') return new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
  if (scale === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return new Date(d.getTime() + 7 * 86_400_000);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function timelineLabel(start: string, scale: TimelineScale): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (scale === 'year') return String(d.getUTCFullYear());
  if (scale === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Bucket findings by when they were raised and when they left the open set.
 * Buckets run contiguously from the first event to `now`, so gaps show as gaps.
 * `open` is cumulative across the whole series, not just the visible window.
 */
export function buildFindingsTimeline(
  findings: Finding[],
  scale: TimelineScale,
  now: Date = new Date(),
): FindingsTimeline {
  const addedAt = new Map<string, number>();
  const removedAt = new Map<string, number>();
  let undated = 0;
  let earliest: Date | null = null;

  const note = (map: Map<string, number>, d: Date) => {
    const key = iso(bucketStart(d, scale));
    map.set(key, (map.get(key) ?? 0) + 1);
    if (!earliest || d < earliest) earliest = d;
  };

  for (const f of findings) {
    const created = parseDate(f.createdAt);
    if (created) note(addedAt, created);
    if (isRemoved(f)) {
      const resolved = parseDate(f.resolvedAt);
      if (resolved) note(removedAt, resolved);
      else undated++;
    }
  }

  if (!earliest) return { buckets: [], undated };

  const buckets: FindingsBucket[] = [];
  let cursor = bucketStart(earliest, scale);
  const end = bucketStart(now, scale);
  let open = 0;
  // Guard against a clock-skewed createdAt in the future producing an endless
  // loop: the series never runs past the bucket containing `now`.
  while (cursor <= end && buckets.length < 600) {
    const key = iso(cursor);
    const added = addedAt.get(key) ?? 0;
    const removed = removedAt.get(key) ?? 0;
    open += added - removed;
    buckets.push({ start: key, label: timelineLabel(key, scale), added, removed, open });
    cursor = nextBucket(cursor, scale);
  }
  return { buckets, undated };
}
