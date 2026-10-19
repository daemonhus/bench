import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { SearchBox } from '@bench/components/SearchBox';
import { KIND_COLORS } from '@bench/components/FeatureCard';
import { matchText } from '@bench/core/fuzzy';
import { categoryMeta } from '@bench/core/finding-categories';
import { HTTP_METHODS, METHOD_COLORS } from '@bench/core/status-options';
import type { Comment, Feature } from '@bench/core/types';
import type { Finding, Project } from './api';
import { remoteToHttp, repoLabel } from './ProjectList';

// Search across every project from the home page: projects, findings, features and comments,
// fuzzy-matched. The three best hits of any kind lead; then up to three more of each kind, in
// that order, skipping kinds with nothing left to show.

type Kind = 'project' | 'finding' | 'feature' | 'comment';
const KINDS: Kind[] = ['project', 'finding', 'feature', 'comment'];
const SECTION_TITLE: Record<Kind, string> = { project: 'Projects', finding: 'Findings', feature: 'Features', comment: 'Comments' };
const TOP = 3;
const PER_SECTION = 3;

interface Hit {
  key: string;
  kind: Kind;
  score: number;
  title: string;
  /** Muted second line: the project, and what kind of thing this is within it. */
  sub: string;
  slug: string;
  hash?: string;
  /** Leading marker: a severity, an HTTP method or a feature kind. */
  severity?: string;
  method?: string;
  featureKind?: string;
}

/** Best of each field's match, weighted by how much that field says about the item. */
const best = (q: string, fields: [string | undefined | null, number][]) =>
  Math.max(0, ...fields.map(([text, w]) => matchText(q, text) * w));

const methodOf = (f: Feature) => {
  if (f.kind !== 'interface') return undefined;
  const op = f.operation?.toUpperCase();
  if (op && HTTP_METHODS.includes(op)) return op;
  return HTTP_METHODS.find((m) => f.title.toUpperCase().startsWith(`${m} `));
};

/** A comment's text around the first match, so the hit shows why it matched. */
function excerpt(text: string, q: string, width = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q.trim().toLowerCase().split(/\s+/)[0] ?? '');
  if (flat.length <= width) return flat;
  if (at < 0) return `${flat.slice(0, width - 1)}…`;
  const start = Math.max(0, Math.min(at - 24, flat.length - width));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width).trim()}${start + width < flat.length ? '…' : ''}`;
}

/** The title with the matched text marked, when the query appears in it as typed. */
function Highlight({ text, q }: { text: string; q: string }) {
  const at = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (!q.trim() || at < 0) return <>{text}</>;
  const end = at + q.trim().length;
  return <>{text.slice(0, at)}<mark className="home-search-mark">{text.slice(at, end)}</mark>{text.slice(end)}</>;
}

function KindIcon({ kind }: { kind: Kind }) {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'project') return <svg {...common}><path d="M2 4.5h4l1.5 1.5H14v6.5H2z" /></svg>;
  if (kind === 'finding') return <svg {...common}><path d="M8 1.75 13.5 4v4c0 3.1-2.3 5.4-5.5 6.25C4.8 13.4 2.5 11.1 2.5 8V4z" /><path d="M8 5.5v3" /><path d="M8 10.75v.01" /></svg>;
  if (kind === 'feature') return <svg {...common}><circle cx="4" cy="8" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M5.8 7.1 10.2 4.9M5.8 8.9l4.4 2.2" /></svg>;
  return <svg {...common}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>;
}

interface SearchData { findings: Finding[]; features: Feature[] }

export function HomeSearch({ projects, data, onOpen }: {
  projects: Project[];
  data: Record<string, SearchData | undefined>;
  onOpen: (slug: string, hash?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDeferredValue(query).trim();

  // Comments aren't on the home page, so they're fetched the first time someone searches.
  const [comments, setComments] = useState<Record<string, Comment[]> | null>(null);
  const fetchedFor = useRef<string | null>(null);
  const searching = q.length > 0;
  const slugs = projects.map((p) => p.slug).join(',');
  useEffect(() => {
    if (!searching || !slugs || fetchedFor.current === slugs) return;
    fetchedFor.current = slugs;
    let live = true, done = false;
    Promise.all(slugs.split(',').map(async (slug): Promise<[string, Comment[]]> => {
      try {
        const res = await fetch(`/api/p/${slug}/api/comments?include_resolved=true`);
        return [slug, res.ok ? await res.json() : []];
      } catch { return [slug, []]; }
    })).then((entries) => { done = true; if (live) setComments(Object.fromEntries(entries)); });
    // Abandoned before it finished (unmounted, or the project list changed): fetch again next time.
    return () => { live = false; if (!done) fetchedFor.current = null; };
  }, [searching, slugs]);

  const results = useMemo(() => {
    if (!q) return null;
    const hits: Hit[] = [];
    for (const p of projects) {
      const score = best(q, [[p.name, 1], [p.slug, 0.9], [p.owner, 0.6], [p.remoteUrl, 0.5], [p.repoPath, 0.5], ...(p.tags ?? []).map((t): [string, number] => [t, 0.6])]);
      if (score > 0) hits.push({ key: `p:${p.slug}`, kind: 'project', score, title: p.name, sub: remoteToHttp(p.remoteUrl ?? '')?.replace(/^https?:\/\//, '') || repoLabel(p.repoPath), slug: p.slug });
      const d = data[p.slug];
      for (const f of d?.findings ?? []) {
        const s = best(q, [[f.title, 1], [f.externalId, 0.8], [f.cwe, 0.8], [f.cve, 0.8], [f.category && categoryMeta(f.category).label, 0.6], [f.description, 0.5], [f.anchor?.fileId, 0.5]]);
        if (s > 0) hits.push({ key: `f:${p.slug}:${f.id}`, kind: 'finding', score: s, title: f.title, sub: `${p.name} · ${f.severity} · ${f.status}`, slug: p.slug, hash: `#/finding/${f.id}`, severity: f.severity });
      }
      for (const f of d?.features ?? []) {
        const s = best(q, [[f.title, 1], [f.operation, 0.7], [f.description, 0.5], [f.anchor?.fileId, 0.5], ...(f.tags ?? []).map((t): [string, number] => [t, 0.6])]);
        if (s > 0) hits.push({ key: `x:${p.slug}:${f.id}`, kind: 'feature', score: s, title: f.title, sub: `${p.name} · ${f.kind}`, slug: p.slug, hash: `#/feature/${f.id}`, method: methodOf(f), featureKind: f.kind });
      }
      for (const c of comments?.[p.slug] ?? []) {
        const s = best(q, [[c.text, 0.9], [c.author, 0.5]]);
        if (s <= 0) continue;
        // A comment opens where it lives: its finding, its feature, or its file.
        const hash = c.findingId ? `#/finding/${c.findingId}` : c.featureId ? `#/feature/${c.featureId}` : `#/browse/${c.anchor.fileId}`;
        hits.push({ key: `c:${p.slug}:${c.id}`, kind: 'comment', score: s, title: excerpt(c.text, q), sub: `${p.name} · ${c.author || 'comment'}`, slug: p.slug, hash });
      }
    }
    // Best first; on a tie, the kind listed first, then alphabetical.
    hits.sort((a, b) => b.score - a.score || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.title.localeCompare(b.title));
    const top = hits.slice(0, TOP);
    const shown = new Set(top.map((h) => h.key));
    const sections = KINDS
      .map((kind) => ({ kind, hits: hits.filter((h) => h.kind === kind && !shown.has(h.key)).slice(0, PER_SECTION) }))
      .filter((s) => s.hits.length > 0);
    return { top, sections, flat: [...top, ...sections.flatMap((s) => s.hits)] };
  }, [q, projects, data, comments]);

  useEffect(() => { setActive(0); }, [q]);

  const go = (h: Hit) => {
    setOpen(false);
    onOpen(h.slug, h.hash);
  };
  const flat = results?.flat ?? [];
  const panelOpen = open && !!q;
  const optionId = (i: number) => `home-search-opt-${i}`;

  const row = (h: Hit, i: number) => (
    <div
      key={h.key}
      id={optionId(i)}
      role="option"
      aria-selected={i === active}
      className={`home-search-row${i === active ? ' home-search-row--active' : ''}`}
      onMouseEnter={() => setActive(i)}
      onClick={() => go(h)}
    >
      <span className="home-search-icon"><KindIcon kind={h.kind} /></span>
      <span className="home-search-text">
        <span className="home-search-title">
          {h.severity && <span className="home-dot" style={{ background: `var(--severity-${h.severity})` }} aria-hidden="true" />}
          {h.method
            ? <span className="feature-method-badge" style={{ background: METHOD_COLORS[h.method] }}>{h.method}</span>
            : h.featureKind && <span className="home-dot" style={{ background: KIND_COLORS[h.featureKind as keyof typeof KIND_COLORS] }} aria-hidden="true" />}
          <span className="home-search-label"><Highlight text={h.title} q={q} /></span>
        </span>
        <span className="home-search-sub">{h.sub}</span>
      </span>
    </div>
  );

  return (
    <div className="home-search">
      <SearchBox
        value={query}
        onChange={(v) => { setQuery(v); setOpen(true); }}
        placeholder="Search projects, findings, features, comments…"
        ariaLabel="Search everything"
        shortcut={['/']}
        className="home-search-box"
        icon
        inputProps={{
          role: 'combobox',
          'aria-expanded': panelOpen,
          'aria-controls': 'home-search-results',
          'aria-autocomplete': 'list',
          'aria-activedescendant': panelOpen && flat.length ? optionId(active) : undefined,
          onFocus: () => setOpen(true),
          onBlur: () => setOpen(false),
          onKeyDown: (e) => {
            if (e.key === 'Escape') {
              if (panelOpen) { e.preventDefault(); setOpen(false); }
              else if (query) { e.preventDefault(); setQuery(''); }
              return;
            }
            if (!panelOpen || !flat.length) {
              if (e.key === 'ArrowDown' && q) { e.preventDefault(); setActive(0); setOpen(true); }
              return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % flat.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + flat.length) % flat.length); }
            else if (e.key === 'Enter') { e.preventDefault(); go(flat[Math.min(active, flat.length - 1)]); }
          },
        }}
      />
      {panelOpen && (
        // mousedown would blur the input (closing the panel) before the click lands.
        <div className="home-search-panel" onMouseDown={(e) => e.preventDefault()}>
          <div id="home-search-results" role="listbox" aria-label="Search results">
            {results && results.top.length > 0 && (
              <div role="group" aria-labelledby="home-search-sec-top">
                <div className="home-search-section" id="home-search-sec-top">Top results</div>
                {results.top.map((h, i) => row(h, i))}
              </div>
            )}
            {results?.sections.map((s) => {
              const offset = results.top.length + results.sections.slice(0, results.sections.indexOf(s)).reduce((n, x) => n + x.hits.length, 0);
              return (
                <div key={s.kind} role="group" aria-labelledby={`home-search-sec-${s.kind}`}>
                  <div className="home-search-section" id={`home-search-sec-${s.kind}`}>{SECTION_TITLE[s.kind]}</div>
                  {s.hits.map((h, i) => row(h, offset + i))}
                </div>
              );
            })}
          </div>
          {flat.length === 0 && <div className="home-search-empty" role="status">No matches for “{q}”</div>}
          {comments === null && <div className="home-search-note" role="status">Searching comments…</div>}
        </div>
      )}
    </div>
  );
}
