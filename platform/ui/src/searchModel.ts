import { matchText } from '@bench/core/fuzzy';
import { categoryMeta } from '@bench/core/finding-categories';
import { HTTP_METHODS } from '@bench/core/status-options';
import type { Comment, Feature } from '@bench/core/types';
import type { Finding, Project } from './api';
import { remoteToHttp, repoLabel } from './repoLinks';

// Search everything: projects, findings, features and comments across every project,
// fuzzy-matched and ranked. The home page's dropdown shows a few hits of each kind; the search
// page (/search) shows them all.

export type Kind = 'project' | 'finding' | 'feature' | 'comment';
export const KINDS: Kind[] = ['project', 'finding', 'feature', 'comment'];
export const SECTION_TITLE: Record<Kind, string> = { project: 'Projects', finding: 'Findings', feature: 'Features', comment: 'Comments' };
export const KIND_NOUN: Record<Kind, [string, string]> = {
  project: ['project', 'projects'], finding: ['finding', 'findings'], feature: ['feature', 'features'], comment: ['comment', 'comments'],
};

export interface Hit {
  key: string;
  kind: Kind;
  score: number;
  title: string;
  /** Muted second line: the project, and what kind of thing this is within it. */
  sub: string;
  /** A longer excerpt for the search page: a description, or the comment around the match. */
  detail?: string;
  slug: string;
  hash?: string;
  /** Leading marker: a severity, an HTTP method or a feature kind. */
  severity?: string;
  method?: string;
  featureKind?: string;
  /** What was matched, for the search page's cards to describe. */
  ref?: HitRef;
}

export type HitRef =
  | { type: 'project'; project: Project }
  | { type: 'finding'; finding: Finding }
  | { type: 'feature'; feature: Feature }
  | { type: 'comment'; comment: Comment };

/** Markdown's emphasis and heading marks read as noise in a one-paragraph excerpt. */
const plain = (text: string) => text.replace(/\*\*|__|^#+\s*/gm, '');

export interface SearchData { findings: Finding[]; features: Feature[] }

/** Best of each field's match, weighted by how much that field says about the item. */
const best = (q: string, fields: [string | undefined | null, number][]) =>
  Math.max(0, ...fields.map(([text, w]) => matchText(q, text) * w));

/** An HTTP interface's method: its operation, or the title's first word ("POST /login"). */
export const methodOf = (f: Pick<Feature, 'kind' | 'operation' | 'title'>) => {
  if (f.kind !== 'interface') return undefined;
  const op = f.operation?.toUpperCase();
  if (op && HTTP_METHODS.includes(op)) return op;
  return HTTP_METHODS.find((m) => f.title.toUpperCase().startsWith(`${m} `));
};

/** Text around the first match, so a hit shows why it matched. */
export function excerpt(text: string, q: string, width = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q.trim().toLowerCase().split(/\s+/)[0] ?? '');
  if (flat.length <= width) return flat;
  if (at < 0) return `${flat.slice(0, width - 1)}…`;
  const start = Math.max(0, Math.min(at - 24, flat.length - width));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width).trim()}${start + width < flat.length ? '…' : ''}`;
}

/** Every hit for q, best first; on a tie, the kind listed first, then alphabetical. */
export function searchAll(
  q: string,
  projects: Project[],
  data: Record<string, SearchData | undefined>,
  comments: Record<string, Comment[]> | null,
): Hit[] {
  q = q.trim();
  if (!q) return [];
  const hits: Hit[] = [];
  for (const p of projects) {
    const score = best(q, [[p.name, 1], [p.slug, 0.9], [p.owner, 0.6], [p.remoteUrl, 0.5], [p.repoPath, 0.5], ...(p.tags ?? []).map((t): [string, number] => [t, 0.6])]);
    if (score > 0) hits.push({ key: `p:${p.slug}`, kind: 'project', score, title: p.name, sub: remoteToHttp(p.remoteUrl ?? '')?.replace(/^https?:\/\//, '') || repoLabel(p.repoPath), detail: [p.owner, ...(p.tags ?? [])].filter(Boolean).join(' · ') || undefined, slug: p.slug, ref: { type: 'project', project: p } });
    const d = data[p.slug];
    for (const f of d?.findings ?? []) {
      const s = best(q, [[f.title, 1], [f.externalId, 0.8], [f.cwe, 0.8], [f.cve, 0.8], [f.category && categoryMeta(f.category).label, 0.6], [f.description, 0.5], [f.anchor?.fileId, 0.5]]);
      if (s > 0) hits.push({ key: `f:${p.slug}:${f.id}`, kind: 'finding', score: s, title: f.title, sub: `${p.name} · ${f.severity} · ${f.status}`, detail: f.description ? excerpt(plain(f.description), q, 280) : undefined, slug: p.slug, hash: `#/finding/${f.id}`, severity: f.severity, ref: { type: 'finding', finding: f } });
    }
    for (const f of d?.features ?? []) {
      const s = best(q, [[f.title, 1], [f.operation, 0.7], [f.description, 0.5], [f.anchor?.fileId, 0.5], ...(f.tags ?? []).map((t): [string, number] => [t, 0.6])]);
      if (s > 0) hits.push({ key: `x:${p.slug}:${f.id}`, kind: 'feature', score: s, title: f.title, sub: `${p.name} · ${f.kind}`, detail: f.description ? excerpt(plain(f.description), q, 280) : undefined, slug: p.slug, hash: `#/feature/${f.id}`, method: methodOf(f), featureKind: f.kind, ref: { type: 'feature', feature: f } });
    }
    for (const c of comments?.[p.slug] ?? []) {
      const s = best(q, [[c.text, 0.9], [c.author, 0.5]]);
      if (s <= 0) continue;
      // A comment opens where it lives: its finding, its feature, or its file.
      const hash = c.findingId ? `#/finding/${c.findingId}` : c.featureId ? `#/feature/${c.featureId}` : `#/browse/${c.anchor.fileId}`;
      const long = excerpt(plain(c.text), q, 400);
      hits.push({ key: `c:${p.slug}:${c.id}`, kind: 'comment', score: s, title: excerpt(c.text, q), sub: `${p.name} · ${c.author || 'comment'}`, detail: long.length > 90 ? long : undefined, slug: p.slug, hash, ref: { type: 'comment', comment: c } });
    }
  }
  return hits.sort((a, b) => b.score - a.score || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.title.localeCompare(b.title));
}

/** The dropdown: the TOP best hits of any kind lead; then up to perSection more of each kind,
 *  in KINDS order, skipping kinds with nothing left to show. `more` counts each kind's hits the
 *  dropdown leaves out, so it can offer the rest on the search page. */
export function summarise(hits: Hit[], top = 3, perSection = 3) {
  const lead = hits.slice(0, top);
  const shown = new Set(lead.map((h) => h.key));
  const totals = countByKind(hits);
  const sections = KINDS
    .map((kind) => {
      const rest = hits.filter((h) => h.kind === kind && !shown.has(h.key)).slice(0, perSection);
      const inLead = lead.filter((h) => h.kind === kind).length;
      return { kind, hits: rest, total: totals[kind], more: totals[kind] - inLead - rest.length };
    })
    .filter((s) => s.hits.length > 0 || s.more > 0);
  return { top: lead, sections };
}

export function countByKind(hits: Hit[]): Record<Kind, number> {
  const n = { project: 0, finding: 0, feature: 0, comment: 0 };
  for (const h of hits) n[h.kind]++;
  return n;
}

export const isKind = (k: string | null | undefined): k is Kind => !!k && (KINDS as string[]).includes(k);

/** "/search?q=…&kind=…&project=…": the search page's address, and back. */
export function searchPath(q: string, kind?: Kind | null, project?: string | null): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);
  if (project) params.set('project', project);
  const s = params.toString();
  return s ? `/search?${s}` : '/search';
}

export function parseSearch(search: string): { q: string; kind?: Kind; project?: string } {
  const params = new URLSearchParams(search);
  const kind = params.get('kind');
  const project = params.get('project');
  return { q: params.get('q') ?? '', ...(isKind(kind) ? { kind } : {}), ...(project ? { project } : {}) };
}
