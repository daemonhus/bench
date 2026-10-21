import { isOpenFinding } from '@bench/core/finding-categories';
import type { Comment, Feature } from '@bench/core/types';
import type { Finding, Project } from './api';
import { SLA_DAYS, type Sev } from './projectInsight';
import type { SearchData } from './searchModel';

// The activity feed: what happened across every project, newest first. A finding or a feature
// recorded, and an open finding passing its fix deadline (its SLA), each with the last comment
// on it. Built in the browser from the same index search uses.

export type ActivityKind = 'finding' | 'feature' | 'sla';
export const ACTIVITY_KINDS: ActivityKind[] = ['finding', 'feature', 'sla'];
export const ACTIVITY_LABEL: Record<ActivityKind, string> = { finding: 'New findings', feature: 'New features', sla: 'Past SLA' };

export type Since = '7d' | '30d' | '90d' | 'all';
export const SINCE: { value: Since; label: string; days: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: 'all', label: 'All time', days: Infinity },
];

export interface ActivityItem {
  key: string;
  kind: ActivityKind;
  /** When it happened: recorded, or (past SLA) when the deadline passed. */
  at: string;
  slug: string;
  finding?: Finding;
  feature?: Feature;
  /** The newest comment on it (replies included). */
  lastComment?: Comment;
  /** Past SLA: the deadline in days, and days over it now. */
  sla?: { days: number; over: number };
}

const DAY = 86_400_000;
const time = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

export function buildFeed(projects: Project[], data: Record<string, SearchData | undefined>, comments: Record<string, Comment[]> | null, now = Date.now()): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const p of projects) {
    const d = data[p.slug];
    if (!d) continue;
    // The newest comment on each finding and feature.
    const last = new Map<string, Comment>();
    for (const c of comments?.[p.slug] ?? []) {
      for (const k of [c.findingId && `f:${c.findingId}`, c.featureId && `x:${c.featureId}`]) {
        if (!k) continue;
        const prev = last.get(k);
        if (!prev || time(c.timestamp) > time(prev.timestamp)) last.set(k, c);
      }
    }
    for (const f of d.findings) {
      const created = time(f.createdAt);
      if (Number.isNaN(created)) continue;
      const lastComment = last.get(`f:${f.id}`);
      items.push({ key: `finding:${p.slug}:${f.id}`, kind: 'finding', at: f.createdAt!, slug: p.slug, finding: f, lastComment });
      const days = SLA_DAYS[f.severity as Sev];
      const due = created + days * DAY;
      if (isOpenFinding(f) && Number.isFinite(days) && due < now) {
        items.push({ key: `sla:${p.slug}:${f.id}`, kind: 'sla', at: new Date(due).toISOString(), slug: p.slug, finding: f, lastComment, sla: { days, over: Math.floor((now - due) / DAY) } });
      }
    }
    for (const f of d.features) {
      if (Number.isNaN(time(f.createdAt))) continue;
      items.push({ key: `feature:${p.slug}:${f.id}`, kind: 'feature', at: f.createdAt!, slug: p.slug, feature: f, lastComment: last.get(`x:${f.id}`) });
    }
  }
  return items.sort((a, b) => time(b.at) - time(a.at) || a.key.localeCompare(b.key));
}

export interface ActivityFilter {
  kinds: ActivityKind[];
  /** Projects to show; null for all. */
  projects: string[] | null;
  /** Severities of findings (and past-SLA items) to show; features aren't narrowed by it. */
  severity: Sev[];
  since: Since;
  q: string;
}

export function filterFeed(items: ActivityItem[], f: ActivityFilter, now = Date.now()): ActivityItem[] {
  const days = SINCE.find((s) => s.value === f.since)?.days ?? Infinity;
  const from = now - days * DAY;
  const q = f.q.trim().toLowerCase();
  return items.filter((it) => {
    if (!f.kinds.includes(it.kind)) return false;
    if (f.projects && !f.projects.includes(it.slug)) return false;
    if (it.finding && !f.severity.includes(it.finding.severity as Sev)) return false;
    if (time(it.at) < from) return false;
    if (q) {
      const e = it.finding ?? it.feature!;
      const text = `${e.title} ${e.description ?? ''} ${it.feature?.operation ?? ''}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
}

/** Items grouped by local day, newest first: "Today", "Yesterday", then the date. */
export function groupByDay(items: ActivityItem[], now = Date.now()): { label: string; items: ActivityItem[] }[] {
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = day(now);
  const yesterday = day(today - DAY / 2); // half a day back from midnight: safe across clock changes
  const groups: { label: string; items: ActivityItem[] }[] = [];
  let current = NaN;
  for (const it of items) {
    const d = day(time(it.at));
    if (d !== current) {
      current = d;
      const label = d === today ? 'Today'
        : d === yesterday ? 'Yesterday'
        : new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(new Date(d).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(it);
  }
  return groups;
}
