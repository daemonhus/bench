import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { commentsApi, findingsApi, featuresApi, gitApi, baselinesApi } from '../core/api';
import { useEvents } from '../core/use-events';
import { useBranchMap } from '../core/use-branch-map';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { useReconcileStore } from '../stores/reconcile-store';
import { useBaselineStore } from '../stores/baseline-store';
import { FindingCard } from './FindingCard';
import { SetBaselineModal } from './SetBaselineModal';
import { MultiSelectDropdown } from './MultiSelectDropdown';
import type { Finding, Comment, Feature, GraphCommit, Severity, LineRange, BaselineDelta } from '../core/types';
import { COMMENT_TYPE_ICON, COMMENT_TYPE_LABEL } from '../core/types';
import { InlineMarkdown } from '../core/markdown';

type ActivityKind = 'comment' | 'comment-on-finding' | 'comment-on-feature' | 'merge' | 'commit-group' | 'finding-opened';
type FilterKind = 'comment' | 'merge' | 'finding-opened';

type ActivityItem =
  | { kind: 'comment'; data: Comment; time: string; actor: string }
  | { kind: 'comment-on-finding'; data: Comment; finding: Finding; time: string; actor: string }
  | { kind: 'comment-on-feature'; data: Comment; feature: Feature; time: string; actor: string }
  | { kind: 'merge'; data: GraphCommit; time: string; actor: string }
  | { kind: 'commit-group'; data: GraphCommit[]; time: string; actor: string }
  | { kind: 'finding-opened'; data: Finding; time: string; actor: string };

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
  info: '#6b7280',
};

const KIND_LABELS: Record<FilterKind, string> = {
  'finding-opened': 'Findings',
  comment: 'Comments',
  merge: 'Git Events',
};

const ALL_KINDS: FilterKind[] = ['finding-opened', 'comment', 'merge'];
const ALL_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

interface Props {
  baselineId?: string;
}

export const DeltaView: React.FC<Props> = ({ baselineId }) => {
  const storeDelta = useBaselineStore((s) => s.delta);
  const storeBaseline = useBaselineStore((s) => s.latestBaseline);
  const pastBaselines = useBaselineStore((s) => s.pastBaselines);
  const refreshBaseline = useBaselineStore((s) => s.refreshAll);
  const deleteBaseline = useBaselineStore((s) => s.deleteBaseline);
  const setBaseline = useBaselineStore((s) => s.setBaseline);
  const gitHead = useReconcileStore((s) => s.head?.gitHead ?? null);
  const commits = useRepoStore((s) => s.commits);
  const branches = useRepoStore((s) => s.branches);

  const [specificDelta, setSpecificDelta] = useState<BaselineDelta | null>(null);
  const [allComments, setAllComments] = useState<Comment[]>([]);
  const [allFindings, setAllFindings] = useState<Finding[]>([]);
  const [allFeatures, setAllFeatures] = useState<Feature[]>([]);
  const [graphCommits, setGraphCommits] = useState<GraphCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBaselineModal, setShowBaselineModal] = useState(false);

  // Edit panel state
  const [editOpen, setEditOpen] = useState(false);
  const [editSummary, setEditSummary] = useState('');
  const [editReviewer, setEditReviewer] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Inline label editing

  // Activity filters
  const [filterKinds, setFilterKinds] = useState<Set<FilterKind>>(new Set(ALL_KINDS));
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedMerges, setExpandedMerges] = useState<Set<string>>(new Set());
  const [filterSeverities, setFilterSeverities] = useState<Set<Severity>>(new Set(ALL_SEVERITIES));
  const [filterActors, setFilterActors] = useState<Set<string> | null>(null); // null = all selected
  const [displayCount, setDisplayCount] = useState(50);

  // Use specific delta when viewing a past baseline, otherwise use the store's global delta
  const isSpecificBaseline = !!baselineId;
  const delta = isSpecificBaseline ? specificDelta : storeDelta;
  const baseline = delta?.sinceBaseline ?? (isSpecificBaseline ? null : storeBaseline);

  const createdAt = baseline?.createdAt ?? null;
  const commitId = baseline?.commitId ?? null;
  const headCommit = delta?.headCommit ?? null;

  // Load comments + graph on mount.
  // On first open with no baseline, auto-create one at the repo's init commit so
  // Changes always shows the full history rather than an empty state.
  const loadData = useCallback(async () => {
    const [c, findings, features, graph] = await Promise.all([
      commentsApi.list().catch(() => [] as Comment[]),
      findingsApi.list().catch(() => [] as Finding[]),
      featuresApi.list().catch(() => [] as Feature[]),
      gitApi.listGraph(10000).catch(() => [] as GraphCommit[]),
    ]);
    setAllComments(c as Comment[]);
    setAllFindings(findings as Finding[]);
    setAllFeatures(features as Feature[]);
    setGraphCommits(graph as GraphCommit[]);

    if (isSpecificBaseline) {
      const d = await baselinesApi.deltaFor(baselineId!).catch(() => null);
      setSpecificDelta(d);
    } else {
      await refreshBaseline();
      // Auto-init: if still no baseline exists, create one at the oldest (init) commit
      if (!useBaselineStore.getState().latestBaseline && (graph as GraphCommit[]).length > 0) {
        const g = graph as GraphCommit[];
        const initCommit = g.find(c => !c.parents || c.parents.length === 0) ?? g[g.length - 1];
        await setBaseline(undefined, undefined, initCommit.hash);
      }
    }
  }, [refreshBaseline, baselineId, isSpecificBaseline, setBaseline]);

  useEffect(() => {
    setLoading(true);
    setSpecificDelta(null);
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  // SSE-driven refresh (only for latest baseline, not historical)
  useEvents(['annotations', 'baselines'], useCallback(() => {
    if (!isSpecificBaseline && !document.hidden) loadData();
  }, [loadData, isSpecificBaseline]));

  const commitMap = new Map(commits.map((c) => [c.hash, c.shortHash]));
  const shortHash = (hash: string) => commitMap.get(hash) ?? hash.slice(0, 7);
  const commitSubject = (hash: string | null): string => {
    if (!hash) return '';
    return commits.find(c => c.hash === hash)?.subject ?? '';
  };

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

  // Resolve the baseline commit's date from the graph — used only for filtering git commits.
  const baselineCommitDate = useMemo(() => {
    if (!commitId) return null;
    const match = graphCommits.find(c => c.hash === commitId || c.hash.startsWith(commitId));
    return match?.date ?? null;
  }, [commitId, graphCommits]);

  // Use the baseline's own createdAt as the cutoff for review activities (findings, comments).
  // This avoids the mismatch where the anchored git commit predates when the review was done.
  const baselineActivityCutoff = baseline?.createdAt ?? null;

  // Build the mainline set: commits reachable by following parents[0] from HEAD.
  // Commits only reachable via parents[1+] (feature branch commits absorbed by a merge)
  // are excluded from the top-level activity stream — they live inside the merge card.
  const mainlineSet = useMemo(() => {
    if (!graphCommits.length) return new Set<string>();
    const byHash = new Map(graphCommits.map(g => [g.hash, g]));
    const mainline = new Set<string>();
    let cur: string | undefined = gitHead ?? graphCommits[0]?.hash;
    while (cur && !mainline.has(cur)) {
      mainline.add(cur);
      cur = byHash.get(cur)?.parents?.[0];
    }
    return mainline;
  }, [graphCommits, gitHead]);

  // For each merge commit, collect the branch commits it absorbed: BFS from parents[1],
  // stopping at any commit already on the mainline.
  const mergeBranchCommitsMap = useMemo(() => {
    const byHash = new Map(graphCommits.map(g => [g.hash, g]));
    const map = new Map<string, GraphCommit[]>();
    for (const g of graphCommits) {
      if ((g.parents?.length ?? 0) < 2) continue;
      const branchTip = g.parents[1];
      const branchCommits: GraphCommit[] = [];
      const visited = new Set<string>();
      const queue = [branchTip];
      while (queue.length > 0) {
        const hash = queue.shift()!;
        if (visited.has(hash) || mainlineSet.has(hash)) continue;
        visited.add(hash);
        const c = byHash.get(hash);
        if (!c) continue;
        branchCommits.push(c);
        for (const p of c.parents ?? []) queue.push(p);
      }
      branchCommits.sort((a, b) => b.date.localeCompare(a.date));
      map.set(g.hash, branchCommits);
    }
    return map;
  }, [graphCommits, mainlineSet]);

  // Build activity stream: items since the baseline commit (unfiltered)
  const allActivity = useMemo<ActivityItem[]>(() => {
    if (!baseline) return [];
    const items: ActivityItem[] = [];

    // Comments since the baseline commit
    const findingById = new Map(allFindings.map(f => [f.id, f]));
    const featureById = new Map(allFeatures.map(f => [f.id, f]));
    for (const c of allComments) {
      if (baselineActivityCutoff && c.timestamp > baselineActivityCutoff) {
        if (c.findingId) {
          const finding = findingById.get(c.findingId);
          if (finding) {
            items.push({ kind: 'comment-on-finding', data: c, finding, time: c.timestamp, actor: c.author });
          } else {
            items.push({ kind: 'comment', data: c, time: c.timestamp, actor: c.author });
          }
        } else if (c.featureId) {
          const feature = featureById.get(c.featureId);
          if (feature) {
            items.push({ kind: 'comment-on-feature', data: c, feature, time: c.timestamp, actor: c.author });
          } else {
            items.push({ kind: 'comment', data: c, time: c.timestamp, actor: c.author });
          }
        } else {
          items.push({ kind: 'comment', data: c, time: c.timestamp, actor: c.author });
        }
      }
    }

    // Findings created since the baseline commit
    for (const f of allFindings) {
      if (baselineActivityCutoff && f.createdAt && f.createdAt > baselineActivityCutoff) {
        items.push({ kind: 'finding-opened', data: f, time: f.createdAt, actor: f.source });
      }
    }

    // Group commits: merge commits as standalone cards, regular commits grouped
    // between consecutive merges into collapsible commit-group cards.
    // Only mainline commits are included — branch commits absorbed by a merge
    // are reachable via parents[1+] and should not appear as standalone items.
    const commitsAfterBaseline = graphCommits
      .filter(g => baselineCommitDate && g.date > baselineCommitDate && mainlineSet.has(g.hash))
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first

    let pendingGroup: GraphCommit[] = [];
    for (const g of commitsAfterBaseline) {
      if ((g.parents?.length ?? 0) >= 2) {
        if (pendingGroup.length > 0) {
          items.push({ kind: 'commit-group', data: pendingGroup, time: pendingGroup[0].date, actor: '' });
          pendingGroup = [];
        }
        items.push({ kind: 'merge', data: g, time: g.date, actor: g.author });
      } else {
        pendingGroup.push(g);
      }
    }
    if (pendingGroup.length > 0) {
      items.push({ kind: 'commit-group', data: pendingGroup, time: pendingGroup[0].date, actor: '' });
    }

    items.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return b.time.localeCompare(a.time);
    });
    return items;
  }, [allComments, allFindings, graphCommits, baseline, baselineActivityCutoff, baselineCommitDate, mainlineSet]);

  // For each merge commit, map to the hash to diff from: the previous merge on the
  // mainline (sorted older), or the baseline commit if this is the first merge.
  const mergePrevMap = useMemo(() => {
    const mergeHashes = allActivity
      .filter(i => i.kind === 'merge')
      .map(i => (i.data as GraphCommit).hash); // newest-first (allActivity is sorted desc)
    const map = new Map<string, string>();
    for (let i = 0; i < mergeHashes.length; i++) {
      map.set(mergeHashes[i], mergeHashes[i + 1] ?? commitId ?? '');
    }
    return map;
  }, [allActivity, commitId]);

  // Unique actors from the activity stream
  const allActors = useMemo(() => {
    const seen = new Set<string>();
    for (const item of allActivity) {
      if (item.actor) seen.add(item.actor);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [allActivity]);

  // Filtered activity stream
  const allFilteredActivity = useMemo(() => {
    let items = allActivity;
    if (filterKinds.size < ALL_KINDS.length) {
      items = items.filter((i) => {
        const cat: FilterKind = i.kind === 'commit-group' ? 'merge' : (i.kind === 'comment-on-finding' || i.kind === 'comment-on-feature') ? 'comment' : i.kind as FilterKind;
        return filterKinds.has(cat);
      });
    }
    if (filterSeverities.size < ALL_SEVERITIES.length) items = items.filter((i) => i.kind !== 'finding-opened' || filterSeverities.has((i.data as Finding).severity));
    if (filterActors) items = items.filter((i) => i.kind === 'commit-group' || filterActors.has(i.actor));
    return items;
  }, [allActivity, filterKinds, filterSeverities, filterActors]);

  // Reset display count when filters change
  useEffect(() => { setDisplayCount(50); }, [filterKinds, filterSeverities, filterActors]);

  const activityStream = allFilteredActivity.slice(0, displayCount);
  const hasMore = displayCount < allFilteredActivity.length;
  const hasActiveFilter = filterKinds.size < ALL_KINDS.length || filterSeverities.size < ALL_SEVERITIES.length || filterActors !== null;


  const shortDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const navigateToFile = (fileId: string, range?: LineRange, commitId?: string) => {
    if (commitId) useRepoStore.getState().selectCommit(commitId);
    useUIStore.getState().setViewMode('browse');
    useRepoStore.getState().selectFile(fileId);
  };

  const navigateToDiff = (hash: string, parentHash: string) => {
    window.location.hash = `#/diff/${parentHash}/${hash}`;
  };

  const navigateToCommit = (hash: string, fileId?: string) => {
    window.location.hash = fileId ? `#/browse/${fileId}` : '#/browse';
  };

  const handleViewDiff = () => {
    if (commitId && headCommit) {
      window.location.hash = `#/diff/${commitId}/${headCommit}`;
    }
  };


  const handleOpenEdit = () => {
    setEditSummary(baseline?.summary ?? '');
    setEditReviewer(baseline?.reviewer ?? '');
    setConfirmDelete(false);
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!baseline) return;
    setEditSaving(true);
    try {
      await baselinesApi.update(baseline.id, {
        reviewer: editReviewer,
        summary: editSummary,
      });
      await loadData();
      setEditOpen(false);
    } catch (e) {
      console.error('Failed to update baseline:', e);
    } finally {
      setEditSaving(false);
    }
  };

  // Close edit panel on click outside
  useEffect(() => {
    if (!editOpen) return;
    const handler = (e: MouseEvent) => {
      if (editRef.current && !editRef.current.contains(e.target as Node)) {
        setEditOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editOpen]);

  const handleDeleteBaseline = async () => {
    if (!baseline) return;
    await deleteBaseline(baseline.id);
    // Navigate back: if viewing latest, go to delta (will show previous or empty);
    // if viewing a specific historical baseline, go to overview
    window.location.hash = '#/delta';
  };

  if (loading) return <div className="empty-state">Loading...</div>;

  // Empty state: no baseline
  if (!baseline || !delta) {
    return (
      <div className="delta-empty">
        <p>No baselines yet.</p>
        <p>Set an initial baseline to start tracking changes.</p>
        <button
          className="baseline-action-btn baseline-action-btn-primary"
          onClick={() => setShowBaselineModal(true)}
        >
          Set Baseline
        </button>
        {showBaselineModal && (
          <SetBaselineModal
            branches={branches}
            headCommit={gitHead}
            defaultToHead={false}
            onClose={() => setShowBaselineModal(false)}
            onConfirm={async (commitHash) => {
              await setBaseline(undefined, undefined, commitHash);
              setShowBaselineModal(false);
            }}
          />
        )}
      </div>
    );
  }

  const defaultLabel = baseline?.seq ? `BL-${baseline.seq}` : (isSpecificBaseline ? 'Baseline' : 'Since baseline');
  const headerLabel = baseline?.reviewer || defaultLabel;
  const emptyActivityLabel = isSpecificBaseline ? 'No activity since this baseline' : 'No activity since last baseline';


  const canBrowseDiff = !!(commitId && headCommit);

  return (
    <div className="delta-view">
      {/* Header bar — two-column grid */}
      <div className="delta-header">
        <div className="delta-header-left">
          <div className="delta-header-left-content">
            <div className="delta-header-info">
              <span
                className={`delta-header-label${pastBaselines.length > 1 ? ' delta-header-label-clickable' : ''}${historyOpen ? ' delta-header-label-active' : ''}`}
                onClick={pastBaselines.length > 1 ? () => setHistoryOpen((v) => !v) : undefined}
                data-tooltip={pastBaselines.length > 1 ? 'Toggle baseline history' : undefined}
              >
                {pastBaselines.length > 1 && (
                  <svg className="delta-header-label-icon" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M8 5v3.5l2 1.5" />
                  </svg>
                )}
                {headerLabel}
              </span>
              <span className="delta-header-meta">
                <button
                  className="delta-edit-pencil"
                  onClick={handleOpenEdit}
                  data-tooltip="Edit baseline"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11.5 1.5l3 3L5 14H2v-3z" />
                  </svg>
                </button>
                {isSpecificBaseline ? (
                  <button
                    className="delta-edit-pencil"
                    onClick={() => { window.location.hash = '#/delta'; }}
                    data-tooltip="Go to current baseline"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 8h10M8 3l5 5-5 5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    className="delta-edit-pencil"
                    onClick={() => setShowBaselineModal(true)}
                    data-tooltip="Set new baseline"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 3L6.5 9.5 3.5 6.5" />
                    </svg>
                  </button>
                )}
              </span>
            </div>
            <div className="delta-header-sub">
              {createdAt && (
                <span className="delta-header-date">{shortDate(createdAt)}</span>
              )}
              <div className="delta-header-stats">
                {delta.newFindings.length > 0 && (
                  <span className="delta-stat delta-stat-new">+{delta.newFindings.length} findings</span>
                )}
                {delta.removedFindingIds.length > 0 && (
                  <span className="delta-stat delta-stat-removed">-{delta.removedFindingIds.length} removed</span>
                )}
                {delta.changedFiles.length > 0 && (
                  <span className="delta-stat delta-stat-files">{delta.changedFiles.length} files changed</span>
                )}
              </div>
              {baseline.summary && (
                <span className="delta-header-summary-inline">{baseline.summary}</span>
              )}
            </div>
          </div>
        </div>
        <div className="delta-header-right">
          <div className="delta-header-commit-rows">
            {headCommit && headCommit === commitId ? (
              <div className="delta-header-commit-row">
                <span className="delta-header-commit-label">At</span>
                <span className="overview-commit-ref">{shortHash(commitId)}</span>
                {renderCommitBadges(commitId)}
                <span className="delta-at-head-label">HEAD</span>
              </div>
            ) : (
              <>
                <div className="delta-header-commit-row">
                  <span className="delta-header-commit-label">From</span>
                  <span className="overview-commit-ref">{shortHash(commitId ?? '')}</span>
                  {commitId && renderCommitBadges(commitId)}
                </div>
                {headCommit && (
                  <div className="delta-header-commit-row">
                    <span className="delta-header-commit-label">To</span>
                    <span className="overview-commit-ref">{shortHash(headCommit)}</span>
                    {renderCommitBadges(headCommit)}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="delta-header-actions">
            <button
              className="baseline-action-btn baseline-action-btn-primary"
              onClick={handleViewDiff}
              disabled={!canBrowseDiff}
            >
              Compare
            </button>
          </div>
        </div>
      </div>

      {/* Edit panel */}
      {editOpen && (
        <div className="delta-edit-panel" ref={editRef}>
          <div className="delta-edit-field">
            <label className="delta-edit-label">Name</label>
            <input
              className="delta-edit-input"
              value={editReviewer}
              onChange={(e) => setEditReviewer(e.target.value)}
              placeholder={defaultLabel}
            />
          </div>
          <div className="delta-edit-field">
            <label className="delta-edit-label">Description</label>
            <textarea
              className="delta-edit-textarea"
              value={editSummary}
              onChange={(e) => setEditSummary(e.target.value)}
              placeholder="Baseline summary / notes"
              rows={3}
            />
          </div>
          <div className="delta-edit-actions">
            <button
              className="baseline-action-btn baseline-action-btn-primary"
              onClick={handleSaveEdit}
              disabled={editSaving}
            >
              {editSaving ? 'Saving...' : 'Save'}
            </button>
            <button
              className="baseline-action-btn baseline-action-btn-outline"
              onClick={() => setEditOpen(false)}
            >
              Cancel
            </button>
            <div style={{ marginLeft: 'auto' }}>
              {!confirmDelete ? (
                <button
                  className="baseline-action-btn baseline-action-btn-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
              ) : (
                <span className="delta-edit-confirm-delete">
                  <span>Delete this baseline?</span>
                  <button className="finding-delete-yes" onClick={handleDeleteBaseline}>Yes</button>
                  <button className="finding-delete-no" onClick={() => setConfirmDelete(false)}>No</button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Activity stream + history drawer */}
      <div className="delta-body-wrap">
      {/* History drawer — left side */}
      {historyOpen && (
        <div className="delta-history-drawer">
          <div className="delta-sidebar-header">
            <span className="delta-sidebar-title">History</span>
            <span className="overview-section-count">{pastBaselines.length}</span>
          </div>
          <div className="delta-sidebar-body">
            {[...pastBaselines].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((bl) => {
              const isActive = bl.id === (baseline?.id ?? null);
              const isLatest = bl.id === storeBaseline?.id;
              return (
                <div
                  key={bl.id}
                  className={`past-baseline-card${isActive ? ' past-baseline-card-active' : ''}`}
                  onClick={() => {
                    window.location.hash = isLatest ? '#/delta' : `#/delta/${bl.id}`;
                    setHistoryOpen(false);
                  }}
                >
                  <div className="past-baseline-card-header">
                    <span className="past-baseline-seq">{bl.seq ? `BL-${bl.seq}` : 'BL'}</span>
                    {bl.reviewer && <span className="past-baseline-reviewer">{bl.reviewer}</span>}
                    <span className="overview-card-date" style={{ marginLeft: 'auto' }}>{shortDate(bl.createdAt)}</span>
                  </div>
                  <div className="past-baseline-card-commits">
                    <span className="overview-commit-ref">{shortHash(bl.commitId)}</span>
                    {renderCommitBadges(bl.commitId)}
                  </div>
                  <div className="past-baseline-card-stats">
                    <span>{bl.findingsOpen} open findings</span>
                    <span className="past-baseline-stat-sep">·</span>
                    <span>{bl.commentsTotal} comments</span>
                  </div>
                  {bl.summary && (
                    <div className="past-baseline-card-summary">{bl.summary}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="delta-body">
          <section className="overview-section">
            <div className="findings-title-row">
              <h2 className="overview-section-title">
                Activity
                <span className="overview-section-count">{hasMore ? `${activityStream.length} of ${allFilteredActivity.length}` : allFilteredActivity.length}</span>
              </h2>
              <div className="activity-kind-toggles">
                {ALL_KINDS.map((k) => (
                  <button
                    key={k}
                    className={`activity-kind-toggle${filterKinds.has(k) ? ' activity-kind-toggle-active' : ''}`}
                    onClick={() => setFilterKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(k)) next.delete(k); else next.add(k);
                      return next;
                    })}
                  >
                    {KIND_LABELS[k as FilterKind]}
                  </button>
                ))}
              </div>
              <div className="activity-filters">
                <MultiSelectDropdown<Severity>
                  label="Severity"
                  options={[
                    { value: 'critical', label: 'Critical' },
                    { value: 'high', label: 'High' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'low', label: 'Low' },
                    { value: 'info', label: 'Info' },
                  ]}
                  selected={filterSeverities}
                  onChange={setFilterSeverities}
                />
                {allActors.length > 1 && (
                  <MultiSelectDropdown<string>
                    label="Actor"
                    options={allActors.map((a) => ({ value: a, label: a }))}
                    selected={filterActors ?? new Set(allActors)}
                    onChange={(next) => setFilterActors(next.size === allActors.length ? null : next)}
                  />
                )}
                <button
                  className={`activity-filter-clear${hasActiveFilter ? ' activity-filter-clear-visible' : ''}`}
                  onClick={() => { setFilterKinds(new Set<FilterKind>(ALL_KINDS)); setFilterSeverities(new Set(ALL_SEVERITIES)); setFilterActors(null); }}
                  title="Reset filters"
                >
                  &#x2715;
                </button>
              </div>
            </div>

            {activityStream.length === 0 && (
              <div className="overview-empty">
                {hasActiveFilter ? 'No matching activity' : emptyActivityLabel}
              </div>
            )}

            {activityStream.map((item) => {
              if (item.kind === 'comment') {
                const c = item.data;
                return (
                  <div key={`c-${c.id}`} className="activity-item-wrap">
                    <div className="activity-event-label">
                      <span className="comment-card-author">{c.author}</span>
                      <span className="activity-event-verb">commented</span>
                      <span className="overview-card-date" title={new Date(c.timestamp).toISOString()}>{shortDate(c.timestamp)}</span>
                    </div>
                    <div className="overview-comment-card">
                      <div className="comment-card-text">
                        {c.commentType && COMMENT_TYPE_ICON[c.commentType] && (
                          <span className="comment-type-icon" title={COMMENT_TYPE_LABEL[c.commentType]}>{COMMENT_TYPE_ICON[c.commentType]}</span>
                        )}
                        <InlineMarkdown text={c.text} />
                      </div>
                      <div className="overview-card-meta">
                        {c.anchor.fileId && (
                          <span
                            className="overview-comment-file"
                            onClick={() => navigateToFile(c.anchor.fileId, c.anchor.lineRange ?? undefined)}
                          >
                            {c.anchor.fileId}
                            {c.anchor.lineRange && `:${c.anchor.lineRange.start}`}
                          </span>
                        )}
                        <span className="overview-card-meta-right">
                          {c.anchor.commitId && renderCommitBadges(c.anchor.commitId)}
                          {c.anchor.commitId && (
                            <span
                              className="overview-commit-ref overview-commit-link"
                              onClick={(e) => { e.stopPropagation(); navigateToCommit(c.anchor.commitId, c.anchor.fileId); }}
                            >
                              {shortHash(c.anchor.commitId)}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }

              if (item.kind === 'comment-on-finding') {
                const c = item.data;
                const f = item.finding;
                const sevColor = SEVERITY_COLORS[f.severity] ?? '#6b7280';
                return (
                  <div key={`cf-${c.id}`} className="activity-item-wrap">
                    <div className="activity-event-label">
                      <span className="comment-card-author">{c.author}</span>
                      <span className="activity-event-verb">commented on</span>
                      <span className="overview-card-date" title={new Date(c.timestamp).toISOString()}>{shortDate(c.timestamp)}</span>
                    </div>
                    <div className="overview-comment-card">
                    <div className="comment-card-text">
                      {c.commentType && COMMENT_TYPE_ICON[c.commentType] && (
                        <span className="comment-type-icon" title={COMMENT_TYPE_LABEL[c.commentType]}>{COMMENT_TYPE_ICON[c.commentType]}</span>
                      )}
                      <InlineMarkdown text={c.text} />
                    </div>
                    <div
                      className="activity-finding-ref"
                      style={{ '--card-severity': sevColor } as React.CSSProperties}
                      onClick={() => { useUIStore.getState().setScrollToFindingId(f.id); useUIStore.getState().setViewMode('findings'); }}
                    >
                      <div className="activity-finding-ref-header">
                        <span className="activity-finding-ref-dot" style={{ background: sevColor }} />
                        <span className="activity-finding-ref-label">Finding:</span>
                        <span className="activity-finding-ref-title">{f.title}</span>
                        <span className="activity-finding-ref-severity" style={{ color: sevColor }}>{f.severity}</span>
                      </div>
                      {f.anchor.fileId && (
                        <div className="activity-finding-ref-meta">
                          <span className="activity-finding-ref-file">
                            {f.anchor.fileId}{f.anchor.lineRange ? `:${f.anchor.lineRange.start}` : ''}
                          </span>
                        </div>
                      )}
                      {f.description && (
                        <div className="activity-finding-ref-desc">{f.description}</div>
                      )}
                    </div>
                    </div>
                  </div>
                );
              }

              if (item.kind === 'comment-on-feature') {
                const c = item.data;
                const feat = item.feature;
                return (
                  <div key={`cft-${c.id}`} className="activity-item-wrap">
                    <div className="activity-event-label">
                      <span className="comment-card-author">{c.author}</span>
                      <span className="activity-event-verb">commented on</span>
                      <span className="overview-card-date" title={new Date(c.timestamp).toISOString()}>{shortDate(c.timestamp)}</span>
                    </div>
                    <div className="overview-comment-card">
                      <div className="comment-card-text">
                        {c.commentType && COMMENT_TYPE_ICON[c.commentType] && (
                          <span className="comment-type-icon" title={COMMENT_TYPE_LABEL[c.commentType]}>{COMMENT_TYPE_ICON[c.commentType]}</span>
                        )}
                        <InlineMarkdown text={c.text} />
                      </div>
                      <div
                        className="activity-feature-ref"
                        onClick={() => { useUIStore.getState().setScrollToFeature({ id: feat.id, kind: feat.kind }); useUIStore.getState().setViewMode('features'); }}
                      >
                        <div className="activity-feature-ref-header">
                          <span className="activity-feature-ref-kind">Feature:</span>
                          <span className="activity-feature-ref-title">{feat.title}</span>
                        </div>
                        {feat.anchor.fileId && (
                          <div className="activity-finding-ref-meta">
                            <span className="activity-finding-ref-file">
                              {feat.anchor.fileId}{feat.anchor.lineRange ? `:${feat.anchor.lineRange.start}` : ''}
                            </span>
                          </div>
                        )}
                        {feat.description && (
                          <div className="activity-finding-ref-desc">{feat.description}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              }

              if (item.kind === 'merge') {
                const g = item.data as GraphCommit;
                const diffFrom = mergePrevMap.get(g.hash);
                const branchCommits = mergeBranchCommitsMap.get(g.hash) ?? [];
                const isMergeExpanded = expandedMerges.has(g.hash);
                const toggleMerge = (e: React.MouseEvent) => {
                  e.stopPropagation();
                  setExpandedMerges((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.hash)) next.delete(g.hash); else next.add(g.hash);
                    return next;
                  });
                };
                return (
                  <div key={`g-${g.hash}`} className="activity-item-wrap">
                    <div className="activity-event-label">
                      <span className="overview-merge-icon">
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="8" cy="3" r="2" />
                          <circle cx="8" cy="13" r="2" />
                          <path d="M8 5v6" />
                        </svg>
                      </span>
                      <span className="overview-merge-author">{g.author}</span>
                      <span className="activity-event-verb">merged</span>
                      <span className="overview-card-date" title={new Date(g.date).toISOString()}>{shortDate(g.date)}</span>
                    </div>
                    <div className="overview-merge-card-wrap">
                    <div
                      className="overview-merge-card"
                      onClick={() => diffFrom ? navigateToDiff(g.hash, diffFrom) : navigateToCommit(g.hash)}
                    >
                      <div className="overview-merge-subject">{g.subject}</div>
                      <div className="overview-card-meta">
                        {branchCommits.length > 0 && (
                          <button className="overview-merge-branch-toggle" onClick={toggleMerge}>
                            <span className={`overview-commit-group-chevron${isMergeExpanded ? ' overview-commit-group-chevron-open' : ''}`}>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 3.5L5 6.5L8 3.5" />
                              </svg>
                            </span>
                            {branchCommits.length} commit{branchCommits.length !== 1 ? 's' : ''}
                          </button>
                        )}
                        <span className="overview-card-meta-right">
                          {renderCommitBadges(g.hash)}
                          <span className="overview-commit-ref overview-commit-link">
                            {g.shortHash}
                          </span>
                        </span>
                      </div>
                    </div>
                    {isMergeExpanded && branchCommits.length > 0 && (
                      <div className="overview-commit-group-items overview-merge-branch-commits">
                        {branchCommits.map((bc) => (
                          <div
                            key={bc.hash}
                            className="overview-commit-row"
                            onClick={() => bc.parents?.length ? navigateToDiff(bc.hash, bc.parents[0]) : navigateToCommit(bc.hash)}
                          >
                            <span className="overview-commit-row-meta">
                              <span className="overview-merge-author">{bc.author}</span>
                              <span className="overview-card-date" title={new Date(bc.date).toISOString()}>{shortDate(bc.date)}</span>
                              <span className="overview-card-meta-right">
                                {renderCommitBadges(bc.hash)}
                                <span className="overview-commit-ref overview-commit-link">{bc.shortHash}</span>
                              </span>
                            </span>
                            <code className="overview-commit-row-subject">{bc.subject}</code>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  </div>
                );
              }

              if (item.kind === 'commit-group') {
                const groupCommits = item.data as GraphCommit[];
                const groupKey = groupCommits[0].hash;
                const rest = groupCommits.slice(1);
                const isExpanded = expandedGroups.has(groupKey);
                const renderCommitRow = (g: GraphCommit) => (
                  <div
                    key={g.hash}
                    className="overview-commit-row"
                    onClick={() => g.parents?.length ? navigateToDiff(g.hash, g.parents[0]) : navigateToCommit(g.hash)}
                  >
                    <span className="overview-commit-row-meta">
                      <span className="overview-merge-author">{g.author}</span>
                      <span className="overview-card-date" title={new Date(g.date).toISOString()}>{shortDate(g.date)}</span>
                      <span className="overview-card-meta-right">
                        {renderCommitBadges(g.hash)}
                        <span className="overview-commit-ref overview-commit-link">{g.shortHash}</span>
                      </span>
                    </span>
                    <code className="overview-commit-row-subject">{g.subject}</code>
                  </div>
                );
                return (
                  <div key={`cg-${groupKey}`} className="activity-item-wrap">
                    <div className="activity-event-label">
                      <span className="activity-event-label-text">{groupCommits.length} commit{groupCommits.length !== 1 ? 's' : ''}</span>
                      <span className="overview-card-date">{shortDate(groupCommits[0].date)}</span>
                    </div>
                    <div className="overview-commit-group">
                      {renderCommitRow(groupCommits[0])}
                      {rest.length > 0 && (
                        <>
                          <button
                            className="overview-commit-group-toggle"
                            onClick={() => setExpandedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
                              return next;
                            })}
                          >
                            <span className={`overview-commit-group-chevron${isExpanded ? ' overview-commit-group-chevron-open' : ''}`}>
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 3.5L5 6.5L8 3.5" />
                              </svg>
                            </span>
                            <span className="overview-commit-group-label">
                              {rest.length} more commit{rest.length !== 1 ? 's' : ''}
                            </span>
                          </button>
                          {isExpanded && (
                            <div className="overview-commit-group-items">
                              {rest.map(renderCommitRow)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              }

              // finding-opened
              const f = item.data;
              return (
                <div key={`fo-${f.id}`} className="activity-finding-wrap">
                  <div className="activity-event-label">
                    <span className="activity-event-label-text">New finding</span>
                    {f.source && <span className="activity-event-label-actor">{f.source}</span>}
                    {f.createdAt && <span className="overview-card-date">{shortDate(f.createdAt)}</span>}
                  </div>
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

      </div>

      {showBaselineModal && (
        <SetBaselineModal
          branches={branches}
          headCommit={gitHead}
          defaultToHead={true}
          onClose={() => setShowBaselineModal(false)}
          onConfirm={async (commitHash) => {
            await setBaseline(undefined, undefined, commitHash);
            setShowBaselineModal(false);
          }}
        />
      )}
    </div>
  );
};
