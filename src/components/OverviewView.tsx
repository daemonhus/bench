import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { findingsApi, commentsApi, gitApi } from '../core/api';
import { useEvents } from '../core/use-events';
import { useBranchMap } from '../core/use-branch-map';
import { useRepoStore } from '../stores/repo-store';
import { useReconcileStore } from '../stores/reconcile-store';
import { useAnnotationStore } from '../stores/annotation-store';
import { useUIStore } from '../stores/ui-store';
import { useBaselineStore } from '../stores/baseline-store';
import { FindingCard } from './FindingCard';
import { AnnotationFilters, ALL_SEVERITIES, ALL_STATUSES } from './AnnotationFilters';
import type { Finding, Comment, GraphCommit, Severity, LineRange, FindingStatus } from '../core/types';
import { COMMENT_TYPE_ICON, COMMENT_TYPE_LABEL } from '../core/types';
import { InlineMarkdown } from '../core/markdown';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

type ActivityKind = 'comment' | 'merge' | 'finding-opened';

type ActivityItem =
  | { kind: 'comment'; data: Comment; time: string; actor: string }
  | { kind: 'merge'; data: GraphCommit; time: string; actor: string }
  | { kind: 'finding-opened'; data: Finding; time: string; actor: string };

const KIND_LABELS: Record<ActivityKind, string> = {
  'finding-opened': 'Findings',
  comment: 'Comments',
  merge: 'Git Events',
};

export const OverviewView: React.FC = () => {
  const findings = useAnnotationStore((s) => s.findings);
  const comments = useAnnotationStore((s) => s.comments);
  const loadFindings = useAnnotationStore((s) => s.loadFindings);
  const loadComments = useAnnotationStore((s) => s.loadComments);
  const [mergeCommits, setMergeCommits] = useState<GraphCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentText, setEditCommentText] = useState('');
  const [editCommentType, setEditCommentType] = useState<import('../core/types').CommentType>('');
  const commits = useRepoStore((s) => s.commits);
  const branches = useRepoStore((s) => s.branches);
  const reconciledHead = useReconcileStore((s) => s.head);

  const refreshBaseline = useBaselineStore((s) => s.refreshAll);

  const gitHead = reconciledHead?.gitHead ?? null;
  const branchMap = useBranchMap();

  const renderCommitBadges = (hash: string) => {
    const isHead = gitHead === hash;
    const branchNames = branchMap.get(hash);
    if (!isHead && !branchNames) return null;
    return (
      <>
        {isHead && <span className="commit-head-badge">HEAD</span>}
        {branchNames?.map((name) => (
          <span key={name} className="commit-branch-badge">{name}</span>
        ))}
      </>
    );
  };

  // Filters (persisted to localStorage)
  const ALL_KINDS: ActivityKind[] = ['finding-opened', 'comment', 'merge'];

  const loadFilter = <T,>(key: string, defaults: T[] | null): Set<T> | null => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaults ? new Set(defaults) : null;
      const arr = JSON.parse(raw) as T[] | null;
      return arr === null ? null : new Set(arr);
    } catch { return defaults ? new Set(defaults) : null; }
  };
  const saveFilter = <T,>(key: string, value: Set<T> | null) => {
    try { localStorage.setItem(key, JSON.stringify(value === null ? null : [...value])); } catch {}
  };

  const [filterActors, _setFilterActors] = useState<Set<string> | null>(() => loadFilter<string>('ov-filter-actors', null));
  const [filterKinds, _setFilterKinds] = useState<Set<ActivityKind>>(() => loadFilter<ActivityKind>('ov-filter-kinds', ALL_KINDS)!);
  const [filterStatuses, _setFilterStatuses] = useState<Set<FindingStatus>>(() => loadFilter<FindingStatus>('ov-filter-statuses', ALL_STATUSES)!);
  const [filterSeverities, _setFilterSeverities] = useState<Set<Severity>>(() => loadFilter<Severity>('ov-filter-severities', ALL_SEVERITIES)!);

  const setFilterActors = useCallback((v: Set<string> | null) => { _setFilterActors(v); saveFilter('ov-filter-actors', v); }, []);
  const setFilterKinds = useCallback((v: Set<ActivityKind> | ((prev: Set<ActivityKind>) => Set<ActivityKind>)) => {
    _setFilterKinds((prev) => { const next = typeof v === 'function' ? v(prev) : v; saveFilter('ov-filter-kinds', next); return next; });
  }, []);
  const setFilterStatuses = useCallback((v: Set<FindingStatus>) => { _setFilterStatuses(v); saveFilter('ov-filter-statuses', v); }, []);
  const setFilterSeverities = useCallback((v: Set<Severity>) => { _setFilterSeverities(v); saveFilter('ov-filter-severities', v); }, []);
  const [displayCount, setDisplayCount] = useState(50);

  const refreshOverview = useCallback(() => {
    return Promise.all([
      findingsApi.list().catch(() => [] as Finding[]),
      commentsApi.list().catch(() => [] as Comment[]),
      gitApi.listGraph(200).catch(() => [] as GraphCommit[]),
    ]).then(([f, c, graph]) => {
      loadFindings(f);
      loadComments([...c].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
      setMergeCommits(graph.filter((g) => (g.parents?.length ?? 0) >= 2));
    });
  }, [loadFindings, loadComments]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([refreshOverview(), refreshBaseline()]).finally(() => setLoading(false));
  }, [refreshOverview, refreshBaseline]);

  // SSE-driven refresh
  useEvents(['annotations', 'baselines'], useCallback(() => {
    if (!document.hidden) { refreshOverview(); refreshBaseline(); }
  }, [refreshOverview, refreshBaseline]));

  const commitMap = new Map(commits.map((c) => [c.hash, c.shortHash]));
  const shortHash = (hash: string) => commitMap.get(hash) ?? hash.slice(0, 7);
  // Build full activity stream (unfiltered)
  // Finding-linked comments are shown inside their finding card, not as standalone items
  const allActivity = useMemo<ActivityItem[]>(() => {
    const items: ActivityItem[] = [];
    for (const c of comments) {
      if (c.findingId) continue; // shown inside FindingCard
      items.push({ kind: 'comment', data: c, time: c.timestamp, actor: c.author });
    }
    for (const m of mergeCommits) {
      items.push({ kind: 'merge', data: m, time: m.date, actor: m.author });
    }
    // All findings as activity events
    for (const f of findings) {
      items.push({ kind: 'finding-opened', data: f, time: f.createdAt ?? '', actor: f.source });
    }
    items.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return b.time.localeCompare(a.time);
    });
    return items;
  }, [comments, mergeCommits, findings]);

  // Unique actors for filter dropdown
  const actors = useMemo(() => {
    const set = new Set<string>();
    for (const item of allActivity) set.add(item.actor);
    return [...set].sort();
  }, [allActivity]);

  // Unique kinds present
  const kindsPresent = useMemo(() => {
    const set = new Set<ActivityKind>();
    for (const item of allActivity) set.add(item.kind);
    return [...set];
  }, [allActivity]);

  // Track findings whose status just changed so they fade out gracefully
  // instead of vanishing instantly when filters would exclude them
  const [departingIds, setDepartingIds] = useState<Set<string>>(new Set());
  const prevFindingStatusRef = useRef<Map<string, FindingStatus>>(new Map());
  const departingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const filterStatusesRef = useRef(filterStatuses);
  filterStatusesRef.current = filterStatuses;

  useEffect(() => {
    const prev = prevFindingStatusRef.current;
    const statusesFilter = filterStatusesRef.current;
    const hasStatusFilter = statusesFilter.size < ALL_STATUSES.length;

    if (prev.size > 0 && hasStatusFilter) {
      const newDeparting: string[] = [];
      const cancelDeparting: string[] = [];
      for (const f of findings) {
        const prevStatus = prev.get(f.id);
        if (prevStatus && prevStatus !== f.status) {
          if (!statusesFilter.has(f.status)) {
            newDeparting.push(f.id);
          } else if (departingTimersRef.current.has(f.id)) {
            // Cycled back to a matching status — cancel departure
            cancelDeparting.push(f.id);
          }
        }
      }
      if (cancelDeparting.length > 0) {
        setDepartingIds((d) => {
          const next = new Set(d);
          for (const id of cancelDeparting) {
            next.delete(id);
            const t = departingTimersRef.current.get(id);
            if (t) clearTimeout(t);
            departingTimersRef.current.delete(id);
          }
          return next;
        });
      }
      if (newDeparting.length > 0) {
        setDepartingIds((d) => {
          const next = new Set(d);
          for (const id of newDeparting) next.add(id);
          return next;
        });
        for (const id of newDeparting) {
          const existing = departingTimersRef.current.get(id);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            setDepartingIds((d) => { const next = new Set(d); next.delete(id); return next; });
            departingTimersRef.current.delete(id);
          }, 2000);
          departingTimersRef.current.set(id, timer);
        }
      }
    }

    const next = new Map<string, FindingStatus>();
    for (const f of findings) next.set(f.id, f.status);
    prevFindingStatusRef.current = next;
  }, [findings]);

  useEffect(() => {
    const timers = departingTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  // Filtered stream (all matching items, keeping departing findings temporarily)
  const allFilteredActivity = useMemo(() => {
    let items = allActivity;
    if (filterActors) items = items.filter((i) => filterActors.has(i.actor));
    if (filterKinds.size > 0) items = items.filter((i) => filterKinds.has(i.kind));
    if (filterStatuses.size < ALL_STATUSES.length) items = items.filter((i) => i.kind !== 'finding-opened' || filterStatuses.has((i.data as Finding).status) || departingIds.has((i.data as Finding).id));
    if (filterSeverities.size < ALL_SEVERITIES.length) items = items.filter((i) => i.kind !== 'finding-opened' || filterSeverities.has((i.data as Finding).severity));
    return items;
  }, [allActivity, filterActors, filterKinds, filterStatuses, filterSeverities, departingIds]);

  // Reset display count when filters change
  useEffect(() => { setDisplayCount(50); }, [filterActors, filterKinds, filterStatuses, filterSeverities]);

  // Paginated slice for display
  const activityStream = allFilteredActivity.slice(0, displayCount);
  const hasMore = displayCount < allFilteredActivity.length;

  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);
  const setHighlightRange = useUIStore((s) => s.setHighlightRange);

  const storeUpdateComment = useAnnotationStore((s) => s.updateComment);
  const storeDeleteComment = useAnnotationStore((s) => s.deleteComment);

  const scrollToRange = useCallback((range?: LineRange) => {
    if (!range) return;
    setScrollTargetLine(range.start);
    setHighlightRange({ start: range.start, end: range.end });
    setTimeout(() => setHighlightRange(null), 3000);
  }, [setScrollTargetLine, setHighlightRange]);

  if (loading) return <div className="empty-state">Loading...</div>;

  const shortDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const navigateToCommit = (hash: string, fileId?: string, range?: LineRange) => {
    useRepoStore.getState().selectCommit(hash);
    scrollToRange(range);
    if (fileId) {
      useUIStore.getState().setViewMode('browse');
      useRepoStore.getState().selectFile(fileId);
    } else {
      window.location.hash = '#/browse';
    }
  };

  const navigateToFile = (fileId: string, range?: LineRange, commitId?: string) => {
    if (commitId) useRepoStore.getState().selectCommit(commitId);
    scrollToRange(range);
    useUIStore.getState().setViewMode('browse');
    useRepoStore.getState().selectFile(fileId);
  };

  const navigateToDiff = (hash: string, parentHash: string) => {
    window.location.hash = `#/diff/${parentHash}/${hash}`;
  };

  const handleStartEditComment = (c: Comment) => {
    setEditingCommentId(c.id);
    setEditCommentText(c.text);
    setEditCommentType(c.commentType ?? '');
  };

  const handleSaveEditComment = () => {
    if (!editingCommentId || !editCommentText.trim()) return;
    storeUpdateComment(editingCommentId, editCommentText.trim(), editCommentType || undefined);
    setEditingCommentId(null);
    setEditCommentText('');
    setEditCommentType('');
  };

  const handleCancelEditComment = () => {
    setEditingCommentId(null);
    setEditCommentText('');
    setEditCommentType('');
  };

  const handleDeleteComment = (id: string) => {
    storeDeleteComment(id);
  };

  const hasActiveFilter = filterActors !== null || filterKinds.size < 3 || filterStatuses.size < ALL_STATUSES.length || filterSeverities.size < ALL_SEVERITIES.length;

  return (
    <div className="overview-view">
        <section className="overview-section">
          <h2 className="overview-section-title">
            Activity
            <span className="overview-section-count">{hasMore ? `${activityStream.length} of ${allFilteredActivity.length}` : allFilteredActivity.length}</span>
          </h2>
          <div className="activity-controls">
            <div className="activity-kind-toggles">
              {(['finding-opened', 'comment', 'merge'] as ActivityKind[]).map((k) => (
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
              statuses={filterStatuses}
              onStatusesChange={setFilterStatuses}
              actors={actors}
              selectedActors={filterActors}
              onActorsChange={setFilterActors}
              hasActiveFilter={hasActiveFilter}
              onReset={() => { setFilterActors(null); setFilterKinds(new Set(['finding-opened', 'comment', 'merge'])); setFilterSeverities(new Set(ALL_SEVERITIES)); setFilterStatuses(new Set(ALL_STATUSES)); }}
            />
          </div>

          {activityStream.length === 0 && (
            <div className="overview-empty">
              {hasActiveFilter ? 'No matching activity' : 'No activity yet'}
            </div>
          )}

          {activityStream.map((item) => {
            if (item.kind === 'comment') {
              const c = item.data;
              return (
                <div key={`c-${c.id}`} className="overview-comment-card">
                  <div className="overview-card-header">
                    <span className="overview-card-header-left">
                      <span className="comment-card-author">{c.author}</span>
                      <span className="overview-card-date" title={new Date(c.timestamp).toISOString()}>
                        {shortDate(c.timestamp)}
                      </span>
                    </span>
                    {editingCommentId !== c.id && (
                      <div className="overview-comment-actions">
                        <button
                          className="comment-icon-btn"
                          onClick={(e) => { e.stopPropagation(); handleStartEditComment(c); }}
                          title="Edit"
                        >&#x270E;</button>
                        <button
                          className="comment-icon-btn comment-icon-btn-danger"
                          onClick={(e) => { e.stopPropagation(); handleDeleteComment(c.id); }}
                          title="Delete"
                        >&#x2715;</button>
                      </div>
                    )}
                  </div>
                  {editingCommentId === c.id ? (
                    <div className="comment-card-edit">
                      <div className="comment-type-toggle-row">
                        <div className="comment-type-toggle">
                          {(['feature', 'improvement', 'question', 'concern'] as const).map((t) => (
                            <button
                              key={t}
                              className={`comment-type-toggle-btn${editCommentType === t ? ' active' : ''}`}
                              onClick={() => setEditCommentType(editCommentType === t ? '' : t)}
                              title={t.charAt(0).toUpperCase() + t.slice(1)}
                            >
                              {COMMENT_TYPE_ICON[t]}
                            </button>
                          ))}
                        </div>
                        <textarea
                          className="comment-textarea"
                          style={{ flex: 1 }}
                          value={editCommentText}
                          onChange={(e) => setEditCommentText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEditComment();
                            if (e.key === 'Escape') handleCancelEditComment();
                          }}
                          rows={2}
                          autoFocus
                        />
                      </div>
                      <div className="comment-form-actions">
                        <button className="comment-btn comment-btn-cancel" onClick={handleCancelEditComment}>Cancel</button>
                        <button
                          className="comment-btn comment-btn-submit"
                          onClick={handleSaveEditComment}
                          disabled={!editCommentText.trim()}
                        >Save</button>
                      </div>
                    </div>
                  ) : (
                    <div className="comment-card-text">
                      {c.commentType && COMMENT_TYPE_ICON[c.commentType] && (
                        <span className="comment-type-icon" title={COMMENT_TYPE_LABEL[c.commentType]}>{COMMENT_TYPE_ICON[c.commentType]}</span>
                      )}
                      <InlineMarkdown text={c.text} />
                    </div>
                  )}
                  <div className="overview-card-meta">
                    {c.anchor.fileId && (
                      <span
                        className="overview-comment-file"
                        onClick={() => navigateToFile(c.anchor.fileId, c.anchor.lineRange ?? undefined)}
                      >
                        {c.anchor.fileId}
                        {c.anchor.lineRange && `:${c.anchor.lineRange.start}${c.anchor.lineRange.end !== c.anchor.lineRange.start ? `-${c.anchor.lineRange.end}` : ''}`}
                      </span>
                    )}
                    <span className="overview-card-meta-right">
                      {c.anchor.commitId && renderCommitBadges(c.anchor.commitId)}
                      {c.anchor.commitId && (
                        <span
                          className="overview-commit-ref overview-commit-link"
                          onClick={(e) => { e.stopPropagation(); navigateToCommit(c.anchor.commitId, c.anchor.fileId, c.anchor.lineRange ?? undefined); }}
                        >
                          {shortHash(c.anchor.commitId)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            }

            if (item.kind === 'merge') {
              const m = item.data;
              return (
                <div
                  key={`m-${m.hash}`}
                  className="overview-merge-card"
                  onClick={() => navigateToDiff(m.hash, m.parents[0])}
                >
                  <div className="overview-card-header">
                    <span className="overview-card-header-left">
                      <span className="overview-merge-icon">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="4" cy="4" r="2" />
                          <circle cx="12" cy="4" r="2" />
                          <circle cx="8" cy="13" r="2" />
                          <path d="M4 6v2c0 2 4 3 4 5" />
                          <path d="M12 6v2c0 2-4 3-4 5" />
                        </svg>
                      </span>
                      <span className="overview-merge-author">{m.author}</span>
                      <span className="overview-card-date" title={new Date(m.date).toISOString()}>
                        {shortDate(m.date)}
                      </span>
                    </span>
                  </div>
                  <div className="overview-merge-subject">{m.subject}</div>
                  <div className="overview-card-meta">
                    <span className="overview-card-meta-right">
                      {renderCommitBadges(m.hash)}
                      <span
                        className="overview-commit-ref overview-commit-link"
                        onClick={(e) => { e.stopPropagation(); navigateToCommit(m.hash); }}
                      >
                        {m.shortHash}
                      </span>
                    </span>
                  </div>
                </div>
              );
            }

            // finding-opened
            const f = item.data;
            const isDeparting = departingIds.has(f.id);
            return (
              <div key={`fo-${f.id}`} className={isDeparting ? 'finding-departing' : undefined}>
                <FindingCard
                  finding={f}
                  isExpanded={true}
                  onToggle={() => {}}
                  onScrollTo={() => navigateToFile(f.anchor.fileId, f.anchor.lineRange ?? undefined, f.anchor.commitId)}
                />
              </div>
            );
          })}

          {hasMore && (
            <button
              className="activity-show-more"
              onClick={() => setDisplayCount((c) => c + 50)}
            >
              Show more ({allFilteredActivity.length - displayCount} remaining)
            </button>
          )}
        </section>
    </div>
  );
};
