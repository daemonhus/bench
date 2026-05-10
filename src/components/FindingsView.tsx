import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { findingsApi, featuresApi } from '../core/api';
import { useNavList } from '../core/use-nav-list';
import { useEvents } from '../core/use-events';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { FindingCard } from './FindingCard';
import { FindingsMetrics } from './FindingsMetrics';
import { AnnotationFilters, ALL_SEVERITIES } from './AnnotationFilters';
import { SearchBox } from './SearchBox';
import { useRegexSearch } from '../hooks/useRegexSearch';
import type { Feature, Finding, Severity, LineRange } from '../core/types';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

const ALL_SEVERITY_KEYS: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function sortBySeverity(a: Finding, b: Finding): number {
  return (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
}

type FindingsKind = 'open' | 'closed';
const ALL_FINDING_KINDS: FindingsKind[] = ['open', 'closed'];
const KIND_LABELS: Record<FindingsKind, string> = { open: 'Open', closed: 'Closed' };


export const FindingsView: React.FC = () => {
  const findings = useAnnotationStore((s) => s.findings);
  const loadFindings = useAnnotationStore((s) => s.loadFindings);
  const [loading, setLoading] = useState(true);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('bench-collapsed-findings');
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [expandSnippetsTick, setExpandSnippetsTick] = useState(0);
  const [collapseSnippetsTick, setCollapseSnippetsTick] = useState(0);
  const [collapsedSnippetIds, setCollapsedSnippetIds] = useState<Set<string>>(new Set());
  const [metricsOpen, setMetricsOpen] = useState(true);
  const [filterKinds, setFilterKinds] = useState<Set<FindingsKind>>(() => {
    try {
      const saved = sessionStorage.getItem('bench-filter-kinds');
      if (saved) {
        const arr = JSON.parse(saved) as FindingsKind[];
        return new Set(arr.filter((k) => ALL_FINDING_KINDS.includes(k)));
      }
    } catch {}
    return new Set<FindingsKind>(['open']);
  });

  useEffect(() => {
    sessionStorage.setItem('bench-filter-kinds', JSON.stringify([...filterKinds]));
  }, [filterKinds]);

  useEffect(() => {
    localStorage.setItem('bench-collapsed-findings', JSON.stringify([...collapsedIds]));
  }, [collapsedIds]);

  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);
  const setHighlightRange = useUIStore((s) => s.setHighlightRange);
  const scrollToFindingId = useUIStore((s) => s.scrollToFindingId);
  const setScrollToFindingId = useUIStore((s) => s.setScrollToFindingId);

  useEffect(() => {
    if (!scrollToFindingId) return;
    setCollapsedIds((prev) => { if (!prev.has(scrollToFindingId)) return prev; const next = new Set(prev); next.delete(scrollToFindingId); return next; });
    let cancelled = false;
    const tryScroll = (attempts = 0) => {
      if (cancelled) return;
      const el = document.querySelector(`[data-finding-id="${scrollToFindingId}"]`);
      if (el) {
        const container = el.closest('.findings-view') as HTMLElement | null;
        if (container) {
          const targetTop = container.scrollTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top;
          container.scrollTo({ top: targetTop, behavior: 'smooth' });
        } else {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        const card = (el.querySelector('.finding-card') ?? el) as HTMLElement;
        card.classList.add('scroll-target-highlight');
        card.addEventListener('animationend', () => card.classList.remove('scroll-target-highlight'), { once: true });
        setScrollToFindingId(null);
      } else if (attempts < 30) {
        requestAnimationFrame(() => tryScroll(attempts + 1));
      }
    };
    requestAnimationFrame(() => tryScroll());
    return () => { cancelled = true; };
  }, [scrollToFindingId, setScrollToFindingId]);

  // Filters
  const [filterSeverities, setFilterSeverities] = useState<Set<Severity>>(new Set(ALL_SEVERITIES));
  const [filterActors, setFilterActors] = useState<Set<string> | null>(null); // null = all
  const { query: searchQuery, setQuery: setSearchQuery, matcher: searchMatcher, isRegexValid } =
    useRegexSearch('bench-findings-search');

  const loadFeatures = useAnnotationStore((s) => s.loadFeatures);

  const refreshFindings = useCallback(() => {
    featuresApi.list().then((f) => loadFeatures(f as Feature[])).catch(() => {});
    return findingsApi.list().then((f) => loadFindings(f as Finding[])).catch(() => {});
  }, [loadFindings, loadFeatures]);

  useEffect(() => {
    setLoading(true);
    refreshFindings().finally(() => setLoading(false));
  }, [refreshFindings]);

  // SSE-driven refresh (picks up MCP / external changes)
  useEvents('annotations', refreshFindings);

  const scrollToRange = useCallback((range?: LineRange) => {
    if (!range) return;
    setScrollTargetLine(range.start);
    setHighlightRange({ start: range.start, end: range.end });
    setTimeout(() => setHighlightRange(null), 3000);
  }, [setScrollTargetLine, setHighlightRange]);

  const navigateToFile = (fileId: string, range?: LineRange, commitId?: string) => {
    if (commitId) useRepoStore.getState().selectCommit(commitId);
    scrollToRange(range);
    if (range) useUIStore.getState().setPendingCodeviewLine(range.start);
    useUIStore.getState().setViewMode('browse');
    useUIStore.getState().setPendingNavFocus('codeview');
    useRepoStore.getState().selectFile(fileId);
  };

  // Distinct actors (sources) for the actor filter
  const allActors = useMemo(() => {
    const s = new Set<string>();
    for (const f of findings) if (f.source) s.add(f.source);
    return [...s].sort();
  }, [findings]);

  // Apply filters then split
  const filtered = useMemo(() => {
    let list = findings;
    if (filterSeverities.size < ALL_SEVERITIES.length) {
      list = list.filter((f) => filterSeverities.has(f.severity));
    }
    if (filterActors !== null) {
      list = list.filter((f) => filterActors.has(f.source));
    }
    if (searchMatcher) {
      list = list.filter(f => searchMatcher(f.title) || searchMatcher(f.description ?? ''));
    }
    return list;
  }, [findings, filterSeverities, filterActors, searchMatcher]);

  const displayedFindings = useMemo(() => {
    const isOpen = (f: Finding) => f.status === 'draft' || f.status === 'open' || f.status === 'in-progress';
    return filtered
      .filter((f) => filterKinds.has(isOpen(f) ? 'open' : 'closed'))
      .sort(sortBySeverity);
  }, [filtered, filterKinds]);

  // Metrics data
  const severityTotals = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of ALL_SEVERITY_KEYS) m[s] = 0;
    for (const f of findings) m[f.severity] = (m[f.severity] ?? 0) + 1;
    return m;
  }, [findings]);

  const sourceTotals = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of findings) m[f.source] = (m[f.source] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [findings]);

  const categoryTotals = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of findings) {
      const cat = f.category || 'uncategorized';
      m[cat] = (m[cat] ?? 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [findings]);

  const statusTotals = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of findings) m[f.status] = (m[f.status] ?? 0) + 1;
    return m;
  }, [findings]);

  const hasActiveFilter = filterSeverities.size < ALL_SEVERITIES.length || filterActors !== null || filterKinds.size < ALL_FINDING_KINDS.length || searchQuery !== '';

  const listRef = useRef<HTMLDivElement>(null);
  const pendingReplyFocusId = useRef<string | null>(null);
  const { focusedId: navFocusedId, containerRef: navContainerRef, handleKeyDown: navHandleKeyDown, handleFocus: navHandleFocus, handlePointerDown: navHandlePointerDown } = useNavList({
    items: displayedFindings,
    getId: f => f.id,
    onSelect: (f) => setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
      return next;
    }),
    // Enter: expand the card in place; if already expanded, focus the reply textarea.
    // Shift+Enter: jump to the file in Browse.
    onActivate: (f) => {
      const isExpanded = !collapsedIds.has(f.id);
      if (isExpanded) {
        const card = navContainerRef.current?.querySelector(`[data-nav-id="${CSS.escape(f.id)}"]`);
        card?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        return;
      }
      pendingReplyFocusId.current = f.id;
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(f.id);
        return next;
      });
    },
    onShiftActivate: (f) => navigateToFile(f.anchor.fileId, f.anchor.lineRange ?? undefined, f.anchor.commitId),
  });

  // After expand commits, focus the reply textarea of the newly expanded card.
  useEffect(() => {
    const id = pendingReplyFocusId.current;
    if (!id || collapsedIds.has(id)) return;
    const card = navContainerRef.current?.querySelector(`[data-nav-id="${CSS.escape(id)}"]`);
    card?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    pendingReplyFocusId.current = null;
  }, [collapsedIds, navContainerRef]);
  // Keep both refs pointing at the same element
  const setListRef = (el: HTMLDivElement | null) => {
    (listRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    (navContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  };

  const renderFindingList = (list: Finding[]) =>
    list.map((f) => (
      <div key={f.id} data-finding-id={f.id} data-nav-id={f.id} data-nav-focused={navFocusedId === f.id ? 'true' : undefined}>
        <FindingCard
          finding={f}
          isExpanded={!collapsedIds.has(f.id)}
          isNavFocused={navFocusedId === f.id}
          expandSnippetsTick={expandSnippetsTick}
          collapseSnippetsTick={collapseSnippetsTick}
          onSnippetCollapsedChange={(collapsed) => setCollapsedSnippetIds(prev => {
            const next = new Set(prev);
            if (collapsed) next.add(f.id); else next.delete(f.id);
            return next;
          })}
          onToggle={() => setCollapsedIds((prev) => {
            const next = new Set(prev);
            if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
            return next;
          })}
          onScrollTo={() => navigateToFile(f.anchor.fileId, f.anchor.lineRange ?? undefined, f.anchor.commitId)}
        />
      </div>
    ));

  if (loading) return <div className="empty-state">Loading...</div>;

  const allCardsOpen = displayedFindings.every(f => !collapsedIds.has(f.id));
  const anyCardsOpen = displayedFindings.some(f => !collapsedIds.has(f.id));
  const anySnippetsVisible = displayedFindings.some(f => !collapsedIds.has(f.id) && !collapsedSnippetIds.has(f.id));

  return (
    <div className="findings-view">
      <section className="overview-section">
        <div
          className="findings-title-row"
          tabIndex={0}
          data-nav-area="findings-filter"
          onKeyDown={(e) => {
            const tag = (e.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            const container = e.currentTarget;
            const items = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled])'));
            if (items.length === 0) return;
            const idx = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'ArrowRight') {
              items[Math.min(idx + 1, items.length - 1)].focus();
            } else if (e.key === 'ArrowLeft') {
              items[Math.max(idx < 0 ? 0 : idx - 1, 0)].focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
              if (idx >= 0) items[idx].click();
              else items[0].focus();
            }
          }}
        >
          <h2 className="overview-section-title">Findings</h2>
          <div className="activity-kind-toggles">
            {ALL_FINDING_KINDS.map((k) => (
              <button
                key={k}
                className={`activity-kind-toggle${filterKinds.has(k) ? ' activity-kind-toggle-active' : ''}`}
                onClick={() => setFilterKinds((prev) => {
                  const next = new Set(prev);
                  if (next.has(k)) next.delete(k); else next.add(k);
                  return next;
                })}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <div className="findings-filter-group">
            <SearchBox value={searchQuery} onChange={setSearchQuery} invalid={!isRegexValid} shortcut={['/']} />
            <AnnotationFilters
              severities={filterSeverities}
              onSeveritiesChange={setFilterSeverities}
              actors={allActors}
              selectedActors={filterActors}
              onActorsChange={setFilterActors}
              hasActiveFilter={hasActiveFilter}
              onReset={() => { setFilterSeverities(new Set(ALL_SEVERITIES)); setFilterActors(null); setSearchQuery(''); }}
            />
          </div>
        </div>

      {/* Collapsible metrics panel */}
      {displayedFindings.length > 0 && (
        <div className="findings-metrics">
          <h3
            className="findings-metrics-toggle"
            onClick={() => setMetricsOpen(!metricsOpen)}
          >
            <span className={`overview-subsection-chevron${metricsOpen ? ' overview-subsection-chevron-open' : ''}`}>&#x25B8;</span>
            Metrics
          </h3>
          {metricsOpen && (
            <FindingsMetrics
              severityTotals={severityTotals}
              statusTotals={statusTotals}
              categoryTotals={categoryTotals}
              sourceTotals={sourceTotals}
              total={findings.length}
            />
          )}
        </div>
      )}

      <div
        ref={setListRef}
        tabIndex={0}
        data-nav-area="findings-list"
        onKeyDown={navHandleKeyDown}
        onFocus={navHandleFocus}
        onMouseDown={navHandlePointerDown}
      >
      {renderFindingList(displayedFindings)}

      {findings.length === 0 && (
        <div className="overview-empty">No findings</div>
      )}
      {findings.length > 0 && displayedFindings.length === 0 && (
        <div className="overview-empty">No findings match current filters</div>
      )}

      {displayedFindings.length > 0 && (
        <div className="feed-new-pill-wrap">
          <button className="feed-new-pill" onClick={() => useUIStore.getState().setRequestFindingCreate(true)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            New
          </button>
        </div>
      )}
      </div>{/* /findings-list nav area */}
      </section>

      {displayedFindings.length > 0 && (
        <div className="view-expand-fabs">
          <button
            className={`view-expand-fab-btn${allCardsOpen && collapsedSnippetIds.size > 0 ? ' view-expand-fab-btn--active' : allCardsOpen ? ' view-expand-fab-btn--disabled' : ''}`}
            title={allCardsOpen && collapsedSnippetIds.size > 0 ? 'Expand code snippets' : 'Expand all'}
            onClick={() => {
              if (!allCardsOpen) { setCollapsedIds(new Set()); }
              else { setExpandSnippetsTick(t => t + 1); }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 1L1 1L1 5" />
              <path d="M11 1L15 1L15 5" />
              <path d="M5 15L1 15L1 11" />
              <path d="M11 15L15 15L15 11" />
            </svg>
          </button>
          <button
            className={`view-expand-fab-btn${anyCardsOpen && anySnippetsVisible ? ' view-expand-fab-btn--active' : !anyCardsOpen ? ' view-expand-fab-btn--disabled' : ''}`}
            title={anySnippetsVisible ? 'Collapse code snippets' : 'Collapse all'}
            onClick={() => {
              if (anyCardsOpen && anySnippetsVisible) { setCollapseSnippetsTick(t => t + 1); }
              else if (anyCardsOpen) { setCollapsedIds(new Set(displayedFindings.map(f => f.id))); }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6L6 6L6 2" />
              <path d="M14 6L10 6L10 2" />
              <path d="M2 10L6 10L6 14" />
              <path d="M14 10L10 10L10 14" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};
