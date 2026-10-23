import { useEffect, useState } from 'react';
import { gitApi, getApiBase } from './api';
import type { BlameLine } from './types';

/** What the blame column shows beside one line. */
export interface BlameCell {
  commit: string;
  author: string;
  date: Date;
  /** The first line of a run from the same commit: the row that carries the label. */
  start: boolean;
}

/** Blame lines as cells indexed by line number - 1, each run of one commit labelled once. */
export function blameCells(lines: BlameLine[]): (BlameCell | null)[] {
  const out: (BlameCell | null)[] = [];
  let prev: BlameLine | null = null;
  for (const l of lines) {
    while (out.length < l.line - 1) out.push(null);
    out.push({
      commit: l.commit,
      author: l.author,
      date: new Date(Number(l.date) * 1000),
      start: prev === null || prev.commit !== l.commit || prev.line !== l.line - 1,
    });
    prev = l;
  }
  return out;
}

/** A short age for the narrow column: 40m, 5h, 12d, 3mo, 2y. */
export function blameAge(date: Date, now = Date.now()): string {
  const m = Math.max(0, (now - date.getTime()) / 60_000);
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30.44)}mo`;
  return `${Math.round(d / 365.25)}y`;
}

// A commit's blame never changes: keep the last few files' results.
const MAX_CACHED = 20;
const blameCache = new Map<string, Promise<BlameLine[]>>();
const subjectCache = new Map<string, Promise<string>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = load();
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** The blame of a file at a commit, fetched while `enabled`. */
export function useBlame(commit: string | null, path: string | null, enabled: boolean) {
  const key = enabled && commit && path ? `${getApiBase()} ${commit} ${path}` : null;
  const [state, setState] = useState<{ key: string; cells: (BlameCell | null)[] | null; failed: boolean } | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    cached(blameCache, key, () => gitApi.blame(commit!, path!)).then(
      (lines) => { if (live) setState({ key, cells: blameCells(lines), failed: false }); },
      () => { if (live) setState({ key, cells: null, failed: true }); },
    );
    return () => { live = false; };
  }, [key, commit, path]);

  const current = state && state.key === key ? state : null;
  return { cells: current?.cells ?? null, failed: current?.failed ?? false, loading: !!key && !current };
}

/** A commit's subject line, for the blame label's tooltip. */
export function commitSubject(hash: string): Promise<string> {
  return cached(subjectCache, `${getApiBase()} ${hash}`, () =>
    gitApi.resolveCommit(hash).then((c) => c?.subject ?? ''));
}
