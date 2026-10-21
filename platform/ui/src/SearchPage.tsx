import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { SearchBox } from '@bench/components/SearchBox';
import { SkeletonRows } from '@bench/components/Skeleton';
import { SelectDropdown } from '@bench/components/SelectDropdown';
import type { Feature } from '@bench/core/types';
import { listProjects, listProjectFindings, type Finding, type Project } from './api';
import { searchAll, countByKind, KINDS, SECTION_TITLE, KIND_NOUN, type Hit, type Kind, type SearchData } from './searchModel';
import { useSearchComments } from './SearchParts';
import { SearchResultCard, useSearchContext } from './SearchResultCard';
import { listAllFlows, type FlowSummary } from './flows';

// The search page (/search?q=…&kind=…&project=…): every result for a query, full screen. "All"
// shows each kind's best few with a way into the rest; a kind's tab lists all of it, a page at a
// time. The home page's search opens it on Enter, or on a kind's "See all".

/** Hits per kind on the "All" tab. */
const SECTION_LIMIT = 10;
/** Hits listed at a time on a kind's tab. */
const PAGE = 50;

export interface SearchState { q: string; kind?: Kind; project?: string }

/** The last index loaded (here, or handed over by the home page, which loads the same data), so
 *  arriving from the home page shows results at once while a fresh copy loads behind them. */
let lastIndex: { projects: Project[]; data: Record<string, SearchData>; flows: FlowSummary[] } | null = null;
export function primeSearchIndex(projects: Project[], data: Record<string, SearchData>, flows: FlowSummary[]) {
  if (projects.length && Object.keys(data).length) lastIndex = { projects, data, flows };
}

/** Projects with their findings (resolved too) and features: what search runs over; and the
 *  flows, so a feature's card can say which it is on. */
function useSearchIndex() {
  const [projects, setProjects] = useState<Project[]>(lastIndex?.projects ?? []);
  const [data, setData] = useState<Record<string, SearchData>>(lastIndex?.data ?? {});
  const [flows, setFlows] = useState<FlowSummary[]>(lastIndex?.flows ?? []);
  const [loading, setLoading] = useState(!lastIndex);
  useEffect(() => {
    let live = true;
    listProjects().then(async (ps) => {
      const flowsP = listAllFlows().catch(() => [] as FlowSummary[]);
      const loaded = await Promise.all(ps.map(async (p): Promise<[string, SearchData]> => {
        const [findings, features] = await Promise.all([
          listProjectFindings(p.slug, true).catch(() => [] as Finding[]),
          fetch(`/api/projects/${p.slug}/features`).then((r) => (r.ok ? r.json() as Promise<Feature[]> : [])).catch(() => [] as Feature[]),
        ]);
        return [p.slug, { findings, features }];
      }));
      const fs = await flowsP;
      if (!live) return;
      const next = Object.fromEntries(loaded);
      lastIndex = { projects: ps, data: next, flows: fs };
      setProjects(ps);
      setData(next);
      setFlows(fs);
    }).catch(() => {}).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  return { projects, data, flows, loading };
}

export function SearchPage({ state, onChange, onOpen, onOpenFlow }: {
  state: SearchState;
  /** A new query (replace: typing, so the address follows without filling history) or filter. */
  onChange: (next: SearchState, opts?: { replace?: boolean }) => void;
  onOpen: (slug: string, hash?: string) => void;
  onOpenFlow: (id: string) => void;
}) {
  const { projects, data, flows, loading } = useSearchIndex();
  const q = useDeferredValue(state.q).trim();
  const comments = useSearchComments(projects, q.length > 0);
  const ctx = useSearchContext(projects, data, flows, comments);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [q, state.kind, state.project]);

  const inScope = useMemo(() => (state.project ? projects.filter((p) => p.slug === state.project) : projects), [projects, state.project]);
  const hits = useMemo(() => searchAll(q, inScope, data, comments), [q, inScope, data, comments]);
  const counts = useMemo(() => countByKind(hits), [hits]);
  const shown = state.kind ? hits.filter((h) => h.kind === state.kind) : hits;
  const projectName = projects.find((p) => p.slug === state.project)?.name ?? state.project;

  const listRef = useRef<HTMLDivElement>(null);
  const rows = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.search-page-row') ?? [])];
  // Up and down move between results (and from the box into them); Tab still works as usual.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && at === 0) { document.querySelector<HTMLInputElement>('.search-page-box input')?.focus(); return; }
    all[Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  const setKind = (kind?: Kind) => onChange({ ...state, kind });
  const row = (h: Hit) => <SearchResultCard key={h.key} h={h} q={q} ctx={ctx} onOpen={onOpen} onOpenFlow={onOpenFlow} />;

  return (
    <div className="search-page">
      <div className="search-page-header">
        <h2 className="overview-section-title">Search</h2>
        <SearchBox
          value={state.q}
          onChange={(v) => onChange({ ...state, q: v }, { replace: true })}
          placeholder="Search projects, findings, features, comments…"
          ariaLabel="Search everything"
          className="home-search-box search-page-box"
          icon
          inputProps={{
            autoFocus: true,
            onKeyDown: (e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); rows()[0]?.focus(); }
              else if (e.key === 'Escape' && state.q) { e.preventDefault(); onChange({ ...state, q: '' }, { replace: true }); }
            },
          }}
        />
      </div>

      <div className="search-page-filters">
        <div className="search-page-tabs" role="group" aria-label="Show">
          <button type="button" className="search-page-tab" aria-pressed={!state.kind} onClick={() => setKind(undefined)}>
            All {!loading && q && <span className="search-page-count">{hits.length}</span>}
          </button>
          {KINDS.map((k) => (
            <button key={k} type="button" className="search-page-tab" aria-pressed={state.kind === k} onClick={() => setKind(k)}>
              {SECTION_TITLE[k]} {!loading && q && <span className="search-page-count">{counts[k]}</span>}
            </button>
          ))}
        </div>
        <SelectDropdown<string>
          label="Project"
          className="search-page-project"
          options={[{ value: '', label: 'All projects' }, ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.slug, label: p.name }))]}
          value={state.project ?? ''}
          onChange={(slug) => onChange({ ...state, project: slug || undefined })}
        />
      </div>

      <div className="search-page-body" ref={listRef} onKeyDown={onListKey}>
        {!q ? (
          <div className="search-page-empty">Type to search {projects.length ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : 'every project'}: projects, findings, features and comments.</div>
        ) : loading ? (
          <SkeletonRows rows={6} height={44} gap={8} lastWidth="100%" />
        ) : (
          <>
            <div className="search-page-summary" role="status">
              {shown.length === 0
                ? `No ${state.kind ? KIND_NOUN[state.kind][1] : 'matches'} for “${q}”${state.project ? ` in ${projectName}` : ''}`
                : `${shown.length} ${state.kind ? KIND_NOUN[state.kind][shown.length === 1 ? 0 : 1] : shown.length === 1 ? 'result' : 'results'} for “${q}”${state.project ? ` in ${projectName}` : ''}`}
              {comments === null && <span className="search-page-note"> · searching comments…</span>}
            </div>
            {state.kind ? (
              <>
                <ul className="search-page-list" aria-label={SECTION_TITLE[state.kind]}>{shown.slice(0, limit).map(row)}</ul>
                {shown.length > limit && (
                  <button type="button" className="home-more search-page-more" onClick={() => setLimit(limit + PAGE)}>
                    Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
                  </button>
                )}
              </>
            ) : KINDS.filter((k) => counts[k] > 0).map((k) => (
              <section key={k} className="search-page-section" aria-labelledby={`search-sec-${k}`}>
                <h3 className="home-search-section" id={`search-sec-${k}`}>{SECTION_TITLE[k]} <span className="search-page-count">{counts[k]}</span></h3>
                <ul className="search-page-list">{hits.filter((h) => h.kind === k).slice(0, SECTION_LIMIT).map(row)}</ul>
                {counts[k] > SECTION_LIMIT && (
                  <button type="button" className="home-more search-page-more" onClick={() => setKind(k)}>
                    See all {counts[k]} {KIND_NOUN[k][1]} →
                  </button>
                )}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
