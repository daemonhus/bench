import { describe, it, expect } from 'vitest';
import { searchAll, summarise, countByKind, searchPath, parseSearch, excerpt, type Hit } from './searchModel';
import type { Project } from './api';

const project = (slug: string): Project => ({ id: slug, name: slug, slug, repoPath: `/r/${slug}`, createdAt: '', tags: [], owner: '' });
const finding = (id: string, title: string) => ({ id, title, severity: 'high', status: 'open', anchor: { fileId: 'a.go', commitId: 'c' } });
const hit = (kind: Hit['kind'], n: number): Hit => ({ key: `${kind}${n}`, kind, score: 1 - n / 100, title: `${kind} ${n}`, sub: '', slug: 's' });

describe('searchAll', () => {
  it('ranks across projects and kinds, best first', () => {
    const data = {
      alpha: { findings: [finding('f1', 'alpha finding'), finding('f2', 'unrelated')], features: [] },
    } as never;
    const hits = searchAll('alpha', [project('alpha'), project('beta')], data, null);
    expect(hits.map((h) => h.title)).toEqual(['alpha', 'alpha finding']);
    expect(hits[1].hash).toBe('#/finding/f1');
  });
  it('an empty query finds nothing', () => {
    expect(searchAll('  ', [project('alpha')], {}, null)).toEqual([]);
  });
});

describe('summarise', () => {
  it('leads with the best three, then three per kind, and counts what it leaves out', () => {
    const hits = [hit('finding', 1), hit('finding', 2), hit('project', 3), ...[4, 5, 6, 7, 8].map((n) => hit('finding', n)), hit('comment', 9)];
    const s = summarise(hits);
    expect(s.top.map((h) => h.key)).toEqual(['finding1', 'finding2', 'project3']);
    const findings = s.sections.find((x) => x.kind === 'finding')!;
    expect(findings.hits.map((h) => h.key)).toEqual(['finding4', 'finding5', 'finding6']);
    expect(findings.total).toBe(7);
    expect(findings.more).toBe(2);
    expect(s.sections.map((x) => x.kind)).toEqual(['finding', 'comment']); // the project already led
    expect(s.sections.find((x) => x.kind === 'comment')!.more).toBe(0);
  });
  it('counts by kind', () => {
    expect(countByKind([hit('finding', 1), hit('comment', 2), hit('finding', 3)])).toEqual({ project: 0, finding: 2, feature: 0, comment: 1 });
  });
});

describe('search address', () => {
  it('round-trips the query, kind and project', () => {
    expect(searchPath('a b', 'finding', 'alpha')).toBe('/search?q=a+b&kind=finding&project=alpha');
    expect(parseSearch('?q=a+b&kind=finding&project=alpha')).toEqual({ q: 'a b', kind: 'finding', project: 'alpha' });
    expect(parseSearch('?q=x&kind=nonsense')).toEqual({ q: 'x' });
    expect(searchPath('')).toBe('/search');
  });
});

describe('excerpt', () => {
  it('centres on the match in long text', () => {
    const text = `${'lorem '.repeat(40)}zebra key ${'ipsum '.repeat(40)}`;
    const e = excerpt(text, 'zebra', 60);
    expect(e).toContain('zebra key');
    expect(e.startsWith('…')).toBe(true);
    expect(e.endsWith('…')).toBe(true);
  });
});
