import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { SearchBox } from '@bench/components/SearchBox';
import type { Project } from './api';
import { searchAll, summarise, SECTION_TITLE, KIND_NOUN, type Hit, type Kind, type SearchData } from './searchModel';
import { HitBody, useSearchComments } from './SearchParts';

// Search across every project from the home page: projects, findings, features and comments,
// fuzzy-matched. The three best hits of any kind lead; then up to three more of each kind, in
// that order, skipping kinds with nothing left to show. A kind with more than that offers
// "See all N …", and Enter (with no row picked) opens every result on the search page.
// The same search sits in the workbench's tab bar (variant "bar"): compact until used, ⌘K /
// Ctrl+K from anywhere, its panel opening under it on the right.

const TOP = 3;
const PER_SECTION = 3;

/** One row of the dropdown: a hit, a kind's "See all", or the closing "See all results". */
type Entry = { type: 'hit'; hit: Hit } | { type: 'more'; kind: Kind; total: number } | { type: 'all'; total: number };

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function HomeSearch({ projects, data, onOpen, onSearch, variant = 'home', loading = false, onEngage }: {
  projects: Project[];
  data: Record<string, SearchData | undefined>;
  onOpen: (slug: string, hash?: string) => void;
  /** Open the search page for q, on one kind's results or on all of them. */
  onSearch: (q: string, kind?: Kind) => void;
  variant?: 'home' | 'bar';
  /** The projects' data is still loading (the bar loads it when first used). */
  loading?: boolean;
  /** The box was focused: the moment to load what it searches. */
  onEngage?: () => void;
}) {
  const bar = variant === 'bar';
  const uid = useId();
  const listId = `${uid}-results`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // -1: no row picked yet, so Enter searches; the arrows pick one.
  const [active, setActive] = useState(-1);
  const q = useDeferredValue(query).trim();
  const comments = useSearchComments(projects, q.length > 0);

  const results = useMemo(() => {
    if (!q) return null;
    const hits = searchAll(q, projects, data, comments);
    const { top, sections } = summarise(hits, TOP, PER_SECTION);
    const shown = top.length + sections.reduce((n, s) => n + s.hits.length, 0);
    const groups: { id: string; title: string; entries: Entry[] }[] = [];
    if (top.length) groups.push({ id: 'top', title: 'Top results', entries: top.map((hit) => ({ type: 'hit', hit })) });
    for (const s of sections) {
      groups.push({
        id: s.kind,
        title: SECTION_TITLE[s.kind],
        entries: [...s.hits.map((hit): Entry => ({ type: 'hit', hit })), ...(s.more > 0 ? [{ type: 'more' as const, kind: s.kind, total: s.total }] : [])],
      });
    }
    const footer: Entry | null = hits.length > shown ? { type: 'all', total: hits.length } : null;
    return { groups, footer, total: hits.length, flat: [...groups.flatMap((g) => g.entries), ...(footer ? [footer] : [])] };
  }, [q, projects, data, comments]);

  useEffect(() => { setActive(-1); }, [q]);

  const activate = (e: Entry | undefined) => {
    setOpen(false);
    if (!e || e.type === 'all') onSearch(q);
    else if (e.type === 'more') onSearch(q, e.kind);
    else onOpen(e.hit.slug, e.hit.hash);
  };
  const flat = results?.flat ?? [];
  const panelOpen = open && !!q;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const row = (e: Entry, i: number) => {
    const common = {
      key: e.type === 'hit' ? e.hit.key : `${e.type}:${e.type === 'more' ? e.kind : ''}`,
      id: optionId(i),
      role: 'option',
      'aria-selected': i === active,
      // Moving the mouse picks a row; a panel opening under a resting pointer doesn't.
      onMouseMove: () => { if (active !== i) setActive(i); },
      onClick: () => activate(e),
    };
    if (e.type === 'hit') {
      return <div {...common} className={`home-search-row${i === active ? ' home-search-row--active' : ''}`}><HitBody h={e.hit} q={q} /></div>;
    }
    const label = e.type === 'more' ? `See all ${e.total} ${KIND_NOUN[e.kind][e.total === 1 ? 0 : 1]}` : `See all ${e.total} results for “${q}”`;
    return (
      <div {...common} className={`home-search-more-row home-search-more-row--${e.type}${i === active ? ' home-search-row--active' : ''}`}>
        <span>{label}</span><span aria-hidden="true">→</span>
      </div>
    );
  };

  let i = 0;
  return (
    <div className={`home-search${bar ? ' home-search--bar' : ''}`}>
      <SearchBox
        value={query}
        onChange={(v) => { setQuery(v); setOpen(true); }}
        placeholder={bar ? 'Search all projects…' : 'Search projects, findings, features, comments…'}
        ariaLabel="Search everything"
        shortcut={bar ? [MAC ? '⌘' : 'Ctrl', 'K'] : ['/']}
        className="home-search-box"
        icon={!bar}
        expand={bar}
        inputProps={{
          role: 'combobox',
          'aria-expanded': panelOpen,
          'aria-controls': listId,
          'aria-autocomplete': 'list',
          'aria-activedescendant': panelOpen && active >= 0 && active < flat.length ? optionId(active) : undefined,
          onFocus: () => { setOpen(true); onEngage?.(); },
          onBlur: () => setOpen(false),
          onKeyDown: (e) => {
            if (e.key === 'Escape') {
              if (panelOpen) { e.preventDefault(); setOpen(false); }
              else if (query) { e.preventDefault(); setQuery(''); }
              return;
            }
            // Enter on a picked row opens it; otherwise it opens the search page with everything.
            if (e.key === 'Enter') {
              if (!query.trim()) return;
              e.preventDefault();
              if (panelOpen && active >= 0 && active < flat.length) activate(flat[active]);
              else { setOpen(false); onSearch(query.trim()); }
              return;
            }
            if (!panelOpen || !flat.length) {
              if (e.key === 'ArrowDown' && q) { e.preventDefault(); setActive(0); setOpen(true); }
              return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % flat.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a <= 0 ? flat.length : a) - 1); }
          },
        }}
      />
      {panelOpen && (
        // mousedown would blur the input (closing the panel) before the click lands.
        <div className="home-search-panel" onMouseDown={(e) => e.preventDefault()}>
          <div id={listId} className="home-search-results" role="listbox" aria-label="Search results">
            {results?.groups.map((g) => (
              <div key={g.id} role="group" aria-labelledby={`home-search-sec-${g.id}`}>
                <div className="home-search-section" id={`home-search-sec-${g.id}`}>{g.title}</div>
                {g.entries.map((e) => row(e, i++))}
              </div>
            ))}
            {results?.footer && row(results.footer, i++)}
          </div>
          {flat.length === 0 && (loading
            ? <div className="home-search-note" role="status">Loading every project…</div>
            : <div className="home-search-empty" role="status">No matches for “{q}”</div>)}
          {comments === null && <div className="home-search-note" role="status">Searching comments…</div>}
          {flat.length > 0 && <div className="home-search-hint" aria-hidden="true"><kbd>↵</kbd> all results · <kbd>↑</kbd><kbd>↓</kbd> pick one</div>}
        </div>
      )}
    </div>
  );
}
