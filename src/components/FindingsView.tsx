import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { findingsApi } from '../core/api';
import { useEvents } from '../core/use-events';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { FindingCard } from './FindingCard';
import { FindingsMetrics } from './FindingsMetrics';
import { AnnotationFilters, ALL_SEVERITIES } from './AnnotationFilters';
import type { Finding, Severity, LineRange } from '../core/types';

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

/** Shallow-compare two finding arrays by id + key fields to avoid unnecessary re-renders. */
function findingsEqual(a: Finding[], b: Finding[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].status !== b[i].status || a[i].severity !== b[i].severity || a[i].title !== b[i].title) return false;
  }
  return true;
}

export const FindingsView: React.FC = () => {
  const [findings, setFindings] = useState<Finding[]>([]);
  const findingsRef = useRef<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      const stored = sessionStorage.getItem('bench-collapsed-findings');
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
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
    sessionStorage.setItem('bench-collapsed-findings', JSON.stringify([...collapsedIds]));
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
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
        el.classList.add('scroll-target-highlight');
        el.addEventListener('animationend', () => el.classList.remove('scroll-target-highlight'), { once: true });
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

  const stableSetFindings = useCallback((incoming: Finding[]) => {
    if (!findingsEqual(findingsRef.current, incoming as Finding[])) {
      findingsRef.current = incoming as Finding[];
      setFindings(incoming as Finding[]);
    }
  }, []);

  const refreshFindings = useCallback(() => {
    return findingsApi.list().then(stableSetFindings).catch(() => {});
  }, [stableSetFindings]);

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
    useUIStore.getState().setViewMode('browse');
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
    return list;
  }, [findings, filterSeverities, filterActors]);

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

  const hasActiveFilter = filterSeverities.size < ALL_SEVERITIES.length || filterActors !== null || filterKinds.size < ALL_FINDING_KINDS.length;

  const renderFindingList = (list: Finding[]) =>
    list.map((f) => (
      <div key={f.id} data-finding-id={f.id}>
        <FindingCard
          finding={f}
          isExpanded={!collapsedIds.has(f.id)}
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

  return (
    <div className="findings-view">
      <section className="overview-section">
        <div className="findings-title-row">
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
          <AnnotationFilters
            severities={filterSeverities}
            onSeveritiesChange={setFilterSeverities}
            actors={allActors}
            selectedActors={filterActors}
            onActorsChange={setFilterActors}
            hasActiveFilter={hasActiveFilter}
            onReset={() => { setFilterSeverities(new Set(ALL_SEVERITIES)); setFilterActors(null); }}
          />
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
      </section>
    </div>
  );
};
