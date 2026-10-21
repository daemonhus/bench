import { describe, it, expect } from 'vitest';
import type { Comment, Feature } from '@bench/core/types';
import type { Finding, Project } from './api';
import { buildFeed, filterFeed, groupByDay, ACTIVITY_KINDS, type ActivityFilter } from './activityModel';

const NOW = new Date('2026-10-21T12:00:00Z').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const project = (slug: string) => ({ slug, name: slug }) as Project;
const finding = (id: string, severity: string, status: string, created: string) =>
  ({ id, title: `finding ${id}`, description: `about ${id}`, severity, status, createdAt: created, anchor: { fileId: 'a.go', commitId: 'c' } }) as unknown as Finding;
const feature = (id: string, created: string) =>
  ({ id, title: `POST /${id}`, kind: 'interface', status: 'active', createdAt: created, anchor: { fileId: 'b.go', commitId: 'c' } }) as unknown as Feature;
const comment = (id: string, at: string, on: { findingId?: string; featureId?: string }) =>
  ({ id, threadId: id, author: 'rev', text: `note ${id}`, timestamp: at, ...on }) as unknown as Comment;

const ALL: ActivityFilter = { kinds: ACTIVITY_KINDS, projects: null, severity: ['critical', 'high', 'medium', 'low', 'info'], since: 'all', q: '' };

describe('buildFeed', () => {
  const data = {
    alpha: {
      findings: [
        finding('crit', 'critical', 'open', daysAgo(10)), // past its 7-day SLA 3 days ago
        finding('fixed', 'critical', 'closed', daysAgo(20)), // closed: never past SLA
        finding('fresh', 'high', 'open', daysAgo(1)),
      ],
      features: [feature('login', daysAgo(2))],
    },
  };
  const comments = { alpha: [comment('c1', daysAgo(5), { findingId: 'crit' }), comment('c2', daysAgo(4), { findingId: 'crit' }), comment('c3', daysAgo(1), { featureId: 'login' })] };
  const feed = buildFeed([project('alpha')], data, comments, NOW);

  it('lists findings, features and SLA breaches, newest first', () => {
    expect(feed.map((i) => i.key)).toEqual([
      'finding:alpha:fresh', 'feature:alpha:login', 'sla:alpha:crit', 'finding:alpha:crit', 'finding:alpha:fixed',
    ]);
  });

  it('a breach happens when the deadline passes, and says how far over it is', () => {
    const sla = feed.find((i) => i.kind === 'sla')!;
    expect(sla.at).toBe(daysAgo(3));
    expect(sla.sla).toEqual({ days: 7, over: 3 });
  });

  it('carries the newest comment on each finding and feature', () => {
    expect(feed.find((i) => i.key === 'finding:alpha:crit')!.lastComment!.id).toBe('c2');
    expect(feed.find((i) => i.key === 'sla:alpha:crit')!.lastComment!.id).toBe('c2');
    expect(feed.find((i) => i.kind === 'feature')!.lastComment!.id).toBe('c3');
    expect(feed.find((i) => i.key === 'finding:alpha:fresh')!.lastComment).toBeUndefined();
  });

  it('filters by kind, project, severity (findings only), period and text', () => {
    const keys = (f: Partial<ActivityFilter>) => filterFeed(feed, { ...ALL, ...f }, NOW).map((i) => i.key);
    expect(keys({ kinds: ['sla'] })).toEqual(['sla:alpha:crit']);
    expect(keys({ projects: ['beta'] })).toEqual([]);
    expect(keys({ severity: ['high'] })).toEqual(['finding:alpha:fresh', 'feature:alpha:login']);
    expect(keys({ since: '7d' })).toEqual(['finding:alpha:fresh', 'feature:alpha:login', 'sla:alpha:crit']);
    expect(keys({ q: 'login' })).toEqual(['feature:alpha:login']);
  });
});

describe('groupByDay', () => {
  it('labels today and yesterday, then dates', () => {
    const feed = buildFeed([project('alpha')], { alpha: { findings: [finding('a', 'low', 'open', daysAgo(0)), finding('b', 'low', 'open', daysAgo(1)), finding('c', 'low', 'open', daysAgo(6))], features: [] } }, null, NOW);
    const groups = groupByDay(feed, NOW);
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(groups).toHaveLength(3);
    expect(groups[2].label).not.toMatch(/Today|Yesterday/);
  });
});
