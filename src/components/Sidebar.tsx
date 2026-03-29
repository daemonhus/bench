import React, { useState, useEffect, useMemo, useRef, useLayoutEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useAnnotationStore } from '../stores/annotation-store';
import { useUIStore } from '../stores/ui-store';
import { useRepoStore } from '../stores/repo-store';
import { useReconcileStore } from '../stores/reconcile-store';
import { FindingCard } from './FindingCard';
import { FeatureCard } from './FeatureCard';
import type { Finding, Comment, Feature, CommentType, Severity, FindingStatus, FeatureKind, ReconciledHead, JobSnapshot } from '../core/types';
import { getEffectiveLineRange, COMMENT_TYPE_ICON, COMMENT_TYPE_LABEL } from '../core/types';
import { featuresApi } from '../core/api';
import { InlineMarkdown } from '../core/markdown';
import { useBranchMap } from '../core/use-branch-map';

const ReconcileIndicator: React.FC<{
  reconciledHead: ReconciledHead | null;
  activeJob: JobSnapshot | null;
}> = ({ reconciledHead, activeJob }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Compute fixed position from trigger element
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (tooltipRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const isRunning = activeJob && (activeJob.status === 'pending' || activeJob.status === 'running');
  const isOk = reconciledHead?.isFullyReconciled;
  const isWarn = reconciledHead && !reconciledHead.isFullyReconciled && !isRunning;
  const isFailed = activeJob?.status === 'failed';

  if (!isRunning && !isOk && !isWarn && !isFailed) return null;

  let icon: string;
  let cls: string;
  if (isRunning) { icon = '\u21bb'; cls = 'reconcile-status-running'; }
  else if (isOk) { icon = '\u2713'; cls = 'reconcile-status-ok'; }
  else { icon = '\u26A0'; cls = 'reconcile-status-warn'; }

  const tooltipContent = open && pos ? ReactDOM.createPortal(
    <div className="reconcile-tooltip" ref={tooltipRef} style={{ top: pos.top, right: pos.right }}>
      {isRunning && (
        <>
          <div className="reconcile-tooltip-title">Reconciling...</div>
          <div className="reconcile-tooltip-row">
            <span className="reconcile-tooltip-label">Target</span>
            <span className="reconcile-tooltip-value">{activeJob.targetCommit.slice(0, 8)}</span>
          </div>
          {activeJob.progress.filesTotal > 0 && (
            <div className="reconcile-tooltip-row">
              <span className="reconcile-tooltip-label">Progress</span>
              <span className="reconcile-tooltip-value">
                {activeJob.progress.filesDone}/{activeJob.progress.filesTotal} files
              </span>
            </div>
          )}
          {activeJob.progress.currentFile && (
            <div className="reconcile-tooltip-row">
              <span className="reconcile-tooltip-label">Current</span>
              <span className="reconcile-tooltip-value reconcile-tooltip-file">
                {activeJob.progress.currentFile.split('/').pop()}
              </span>
            </div>
          )}
        </>
      )}
      {isOk && (
        <>
          <div className="reconcile-tooltip-title">All reconciled</div>
          <div className="reconcile-tooltip-detail">
            All annotation positions are up to date with the current HEAD.
          </div>
        </>
      )}
      {isWarn && reconciledHead && (
        <>
          <div className="reconcile-tooltip-title">Needs reconciliation</div>
          {reconciledHead.reconciledHead && (
            <div className="reconcile-tooltip-row">
              <span className="reconcile-tooltip-label">Reconciled to</span>
              <span className="reconcile-tooltip-value">{reconciledHead.reconciledHead.slice(0, 8)}</span>
            </div>
          )}
          <div className="reconcile-tooltip-row">
            <span className="reconcile-tooltip-label">HEAD</span>
            <span className="reconcile-tooltip-value">{reconciledHead.gitHead.slice(0, 8)}</span>
          </div>
          {reconciledHead.unreconciled.length > 0 && (
            <div className="reconcile-tooltip-files">
              <span className="reconcile-tooltip-label">
                {reconciledHead.unreconciled.length} file{reconciledHead.unreconciled.length !== 1 ? 's' : ''} behind
              </span>
              <ul className="reconcile-tooltip-list">
                {reconciledHead.unreconciled.slice(0, 8).map((f) => (
                  <li key={f.fileId}>
                    {f.fileId.split('/').pop()}
                    {f.commitsAhead > 0 && <span className="reconcile-tooltip-ahead">+{f.commitsAhead}</span>}
                  </li>
                ))}
                {reconciledHead.unreconciled.length > 8 && (
                  <li className="reconcile-tooltip-more">
                    +{reconciledHead.unreconciled.length - 8} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </>
      )}
      {isFailed && activeJob && (
        <>
          <div className="reconcile-tooltip-title reconcile-tooltip-error">Reconciliation failed</div>
          <div className="reconcile-tooltip-detail reconcile-tooltip-error-detail">
            {activeJob.error || 'Unknown error'}
          </div>
        </>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <span className={`reconcile-status ${cls}`} ref={triggerRef} onClick={() => setOpen(!open)}>
        {icon}
      </span>
      {tooltipContent}
    </>
  );
};

type ActivityItem =
  | { kind: 'finding'; data: Finding; sortKey: string }
  | { kind: 'comment'; data: Comment; sortKey: string }
  | { kind: 'feature'; data: Feature; sortKey: string };

const GAP = 4;

function rowOffsetTop(line: number): number {
  const codeViewer = document.querySelector('.diff-view');
  if (!codeViewer) return 0;
  const row = codeViewer.querySelector(`[data-new-line="${line}"]`) as HTMLElement | null;
  return row ? row.offsetTop : 0;
}

export const Sidebar: React.FC = () => {
  const findings = useAnnotationStore((s) => s.findings);
  const comments = useAnnotationStore((s) => s.comments);
  const features = useAnnotationStore((s) => s.features);
  const addComment = useAnnotationStore((s) => s.addComment);
  const addFinding = useAnnotationStore((s) => s.addFinding);
  const updateComment = useAnnotationStore((s) => s.updateComment);
  const deleteComment = useAnnotationStore((s) => s.deleteComment);
  const expandedFindingId = useUIStore((s) => s.expandedFindingId);
  const setExpandedFinding = useUIStore((s) => s.setExpandedFinding);
  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);
  const setHighlightRange = useUIStore((s) => s.setHighlightRange);
  const commentDrag = useUIStore((s) => s.commentDrag);
  const setCommentDrag = useUIStore((s) => s.setCommentDrag);
  const annotationAction = useUIStore((s) => s.annotationAction);
  const setAnnotationAction = useUIStore((s) => s.setAnnotationAction);
  const viewMode = useUIStore((s) => s.viewMode);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);
  const currentCommit = useRepoStore((s) => s.currentCommit);
  const isLoading = useRepoStore((s) => s.isLoading);
  const hasReconciliationData = useAnnotationStore((s) => s.hasReconciliationData);
  const branches = useRepoStore((s) => s.branches);
  const reconciledHead = useReconcileStore((s) => s.head);
  const activeJob = useReconcileStore((s) => s.activeJob);
  const gitHead = reconciledHead?.gitHead ?? null;

  const branchMap = useBranchMap();

  // New comment form state
  const [newCommentText, setNewCommentText] = useState('');
  const [newCommentType, setNewCommentType] = useState<CommentType>('');
  const [showNewComment, setShowNewComment] = useState(false);

  // New finding form state
  const [showNewFinding, setShowNewFinding] = useState(false);
  const [newFindingTitle, setNewFindingTitle] = useState('');
  const [newFindingDescription, setNewFindingDescription] = useState('');
  const [newFindingSeverity, setNewFindingSeverity] = useState<Severity>('medium');
  const [newFindingStatus, setNewFindingStatus] = useState<FindingStatus>('draft');

  // New feature form state
  const [showNewFeature, setShowNewFeature] = useState(false);
  const [newFeatureTitle, setNewFeatureTitle] = useState('');
  const [newFeatureKind, setNewFeatureKind] = useState<FeatureKind>('interface');
  const [newFeatureDescription, setNewFeatureDescription] = useState('');
  const [newFeatureOperation, setNewFeatureOperation] = useState('');
  const [newFeatureProtocol, setNewFeatureProtocol] = useState('');
  const [newFeatureDirection, setNewFeatureDirection] = useState<'in' | 'out' | ''>('');
  const [newFeatureTags, setNewFeatureTags] = useState('');

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editCommentType, setEditCommentType] = useState<CommentType>('');

  // Severity filter (empty = show all)
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(new Set());
  const toggleSeverity = useCallback((sev: Severity) => {
    setSeverityFilter(prev => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      return next;
    });
  }, []);

  // Scroll sync and positioning state
  const [codeViewHeight, setCodeViewHeight] = useState(0);
  const [cardsBottom, setCardsBottom] = useState(0);
  const [topOffset, setTopOffset] = useState(0);
  const [positions, setPositions] = useState<Map<string, number>>(new Map());
  const [positionsReady, setPositionsReady] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const syncingScroll = useRef(false);

  // When annotationAction changes, show the appropriate form
  useEffect(() => {
    if (annotationAction === 'comment') {
      setShowNewComment(true);
      setNewCommentText('');
      setShowNewFinding(false);
      setShowNewFeature(false);
    } else if (annotationAction === 'finding') {
      setShowNewFinding(true);
      setNewFindingTitle('');
      setNewFindingDescription('');
      setNewFindingSeverity('medium');
      setNewFindingStatus('draft');
      setShowNewComment(false);
      setShowNewFeature(false);
    } else if (annotationAction === 'feature') {
      setShowNewFeature(true);
      setNewFeatureTitle('');
      setNewFeatureKind('interface');
      setNewFeatureDescription('');
      setNewFeatureProtocol('');
      setNewFeatureDirection('');
      setNewFeatureTags('');
      setShowNewComment(false);
      setShowNewFinding(false);
    } else {
      setShowNewComment(false);
      setShowNewFinding(false);
      setShowNewFeature(false);
    }
  }, [annotationAction]);

  // Clear unsaved forms when switching files
  useEffect(() => {
    setShowNewComment(false);
    setNewCommentText('');
    setShowNewFinding(false);
    setNewFindingTitle('');
    setNewFindingDescription('');
    setNewFindingStatus('draft');
    setShowNewFeature(false);
    setNewFeatureTitle('');
    setEditingId(null);
    setEditText('');
    setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
    setAnnotationAction(null);
    setHighlightRange(null);
  }, [selectedFilePath, setCommentDrag, setAnnotationAction, setHighlightRange]);

  // Filter annotations to the currently selected file
  const fileFindings = useMemo(() => {
    if (!selectedFilePath) return [];
    return findings.filter((f) => f.anchor.fileId === selectedFilePath);
  }, [findings, selectedFilePath]);

  const fileComments = useMemo(() => {
    if (!selectedFilePath) return [];
    return comments.filter((c) => c.anchor.fileId === selectedFilePath);
  }, [comments, selectedFilePath]);

  const fileFeatures = useMemo(() => {
    if (!selectedFilePath) return [];
    return features.filter((f) => f.anchor.fileId === selectedFilePath);
  }, [features, selectedFilePath]);

  // Merge findings + standalone comments + features into unified stream, sorted by line number
  // Comments linked to a finding are rendered inside FindingCard, not as separate items
  const activityItems: ActivityItem[] = useMemo(() => {
    const items: ActivityItem[] = [];
    const hasSevFilter = severityFilter.size > 0;
    for (const f of fileFindings) {
      if (hasSevFilter && !severityFilter.has(f.severity)) continue;
      const line = getEffectiveLineRange(f)?.start ?? 0;
      items.push({ kind: 'finding', data: f, sortKey: `${String(line).padStart(6, '0')}-0-${f.id}` });
    }
    const standaloneComments = fileComments.filter((c) => !c.findingId && !c.featureId);
    if (!hasSevFilter) {
      for (const c of standaloneComments) {
        const line = getEffectiveLineRange(c)?.start ?? 0;
        items.push({ kind: 'comment', data: c, sortKey: `${String(line).padStart(6, '0')}-1-${c.id}` });
      }
      for (const feat of fileFeatures) {
        const line = (feat as Feature & { effectiveAnchor?: { lineRange?: { start: number } } }).effectiveAnchor?.lineRange?.start ?? feat.anchor.lineRange?.start ?? 0;
        items.push({ kind: 'feature', data: feat, sortKey: `${String(line).padStart(6, '0')}-2-${feat.id}` });
      }
    }
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return items;
  }, [fileFindings, fileComments, fileFeatures, severityFilter]);

  // Measure actual card heights and compute collision-free positions
  useLayoutEffect(() => {
    if (isLoading) {
      setPositionsReady(false);
      return;
    }
    if (activityItems.length === 0) {
      setPositions(new Map());
      setPositionsReady(true);
      return;
    }

    const newPositions = new Map<string, number>();
    let lastBottom = 0;

    for (const item of activityItems) {
      const id = item.data.id;
      const line = getEffectiveLineRange(item.data)?.start ?? 1;
      const idealTop = rowOffsetTop(line);
      const top = Math.max(idealTop, lastBottom);
      newPositions.set(id, top);

      const el = cardRefs.current.get(id);
      const height = el?.offsetHeight ?? 72;
      lastBottom = top + height + GAP;
    }

    setCardsBottom(lastBottom);
    setPositions(prev => {
      if (prev.size !== newPositions.size) return newPositions;
      for (const [id, top] of newPositions) {
        if (prev.get(id) !== top) return newPositions;
      }
      return prev;
    });
    setPositionsReady(true);
  }, [activityItems, expandedFindingId, editingId, isLoading, layoutTick]);

  // Re-layout when any card grows/shrinks (e.g. async comment/file-preview loads after expansion)
  useEffect(() => {
    if (activityItems.length === 0) return;
    const observer = new ResizeObserver(() => setLayoutTick((t) => t + 1));
    for (const el of cardRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [activityItems, expandedFindingId]);

  // Measure top offset (header height difference between code viewer and sidebar)
  // and sync scroll bidirectionally
  useEffect(() => {
    if (!sidebarOpen) return;

    const codeViewer = document.querySelector('.diff-view');
    const sidebar = contentRef.current;
    if (!codeViewer || !sidebar) return;

    // Measure offset and height
    const measure = () => {
      const codeRect = codeViewer.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      setTopOffset(Math.max(0, codeRect.top - sidebarRect.top));
      setCodeViewHeight(codeViewer.scrollHeight);
    };
    measure();

    // Sync: code viewer scroll → sidebar scroll
    const onCodeScroll = () => {
      if (syncingScroll.current) return;
      syncingScroll.current = true;
      sidebar.scrollTop = codeViewer.scrollTop;
      requestAnimationFrame(() => { syncingScroll.current = false; });
    };

    // Sync: sidebar scroll → code viewer scroll
    const onSidebarScroll = () => {
      if (syncingScroll.current) return;
      syncingScroll.current = true;
      codeViewer.scrollTop = sidebar.scrollTop;
      requestAnimationFrame(() => { syncingScroll.current = false; });
    };

    codeViewer.addEventListener('scroll', onCodeScroll, { passive: true });
    sidebar.addEventListener('scroll', onSidebarScroll, { passive: true });

    // Re-measure when code viewer resizes (e.g., switching browse/diff mode)
    const observer = new ResizeObserver(measure);
    observer.observe(codeViewer);

    return () => {
      codeViewer.removeEventListener('scroll', onCodeScroll);
      sidebar.removeEventListener('scroll', onSidebarScroll);
      observer.disconnect();
    };
  }, [sidebarOpen, activityItems, viewMode, selectedFilePath, isLoading]);

  // Position helper: adds topOffset to computed position
  const getTop = (id: string, fallbackLine: number) => {
    return topOffset + (positions.get(id) ?? rowOffsetTop(fallbackLine));
  };

  // New comment form position
  const newCommentTop = topOffset + rowOffsetTop(commentDrag.startLine ?? 1);

  const handleSubmitNewComment = () => {
    const trimmed = newCommentText.trim();
    if (!trimmed || !commentDrag.startLine) return;
    const startLine = commentDrag.startLine;
    const endLine = commentDrag.endLine ?? commentDrag.startLine;

    // Auto-link to finding or feature if the comment overlaps one
    let findingId: string | undefined;
    let featureId: string | undefined;
    for (const f of fileFindings) {
      const range = getEffectiveLineRange(f);
      if (range && startLine <= range.end && endLine >= range.start) {
        findingId = f.id;
        break;
      }
    }
    if (!findingId) {
      for (const feat of fileFeatures) {
        const range = feat.anchor.lineRange;
        if (range && startLine <= range.end && endLine >= range.start) {
          featureId = feat.id;
          break;
        }
      }
    }

    addComment({
      id: `CMT-${Date.now()}`,
      anchor: {
        fileId: selectedFilePath ?? '',
        commitId: currentCommit ?? '',
        lineRange: { start: startLine, end: endLine },
      },
      author: 'you',
      text: trimmed,
      commentType: newCommentType || undefined,
      timestamp: new Date().toISOString(),
      threadId: findingId ? `T-${findingId}` : featureId ? `T-${featureId}` : `T-${Date.now()}`,
      findingId,
      featureId,
    });
    setNewCommentText('');
    setNewCommentType('');
    setShowNewComment(false);
    setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
    setAnnotationAction(null);
  };

  const handleCancelNewComment = () => {
    setShowNewComment(false);
    setNewCommentText('');
    setNewCommentType('');
    setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
    setAnnotationAction(null);
  };

  const handleSubmitNewFinding = () => {
    const trimmedTitle = newFindingTitle.trim();
    if (!trimmedTitle || !commentDrag.startLine) return;
    addFinding({
      id: `FND-${Date.now()}`,
      anchor: {
        fileId: selectedFilePath ?? '',
        commitId: currentCommit ?? '',
        lineRange: {
          start: commentDrag.startLine,
          end: commentDrag.endLine ?? commentDrag.startLine,
        },
      },
      severity: newFindingSeverity,
      title: trimmedTitle,
      description: newFindingDescription.trim(),
      cwe: '',
      cve: '',
      vector: '',
      score: 0,
      status: newFindingStatus,
      source: 'manual',
    });
    setNewFindingTitle('');
    setNewFindingDescription('');
    setNewFindingStatus('draft');
    setShowNewFinding(false);
    setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
    setAnnotationAction(null);
  };

  const handleCancelNewFinding = () => {
    setShowNewFinding(false);
    setNewFindingTitle('');
    setNewFindingDescription('');
    setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
    setAnnotationAction(null);
  };

  const handleSaveFeature = async () => {
    if (!newFeatureTitle.trim() || !selectedFilePath || !currentCommit) return;
    const tags = newFeatureTags.split(',').map(t => t.trim()).filter(Boolean);
    const anchor = {
      fileId: selectedFilePath,
      commitId: currentCommit,
      lineRange: commentDrag.startLine != null && commentDrag.endLine != null
        ? { start: commentDrag.startLine, end: commentDrag.endLine }
        : undefined,
    };
    await featuresApi.create({
      title: newFeatureTitle.trim(),
      kind: newFeatureKind,
      description: newFeatureDescription.trim() || undefined,
      operation: newFeatureOperation.trim() || undefined,
      protocol: newFeatureProtocol.trim() || undefined,
      direction: (newFeatureDirection || undefined) as 'in' | 'out' | undefined,
      tags,
      anchor,
      status: 'draft',
    });
    setShowNewFeature(false);
    setAnnotationAction(null);
    setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
  };

  const handleStartEdit = (comment: Comment) => {
    setEditingId(comment.id);
    setEditText(comment.text);
    setEditCommentType(comment.commentType ?? '');
  };

  const handleSaveEdit = () => {
    if (editingId && editText.trim()) {
      updateComment(editingId, editText.trim(), editCommentType);
    }
    setEditingId(null);
    setEditText('');
    setEditCommentType('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
    setEditCommentType('');
  };

  const handleDelete = (id: string) => {
    deleteComment(id);
  };

  if (!sidebarOpen) {
    return (
      <div className="sidebar-collapsed" onClick={toggleSidebar}>
        <span className="sidebar-collapsed-icon">&lsaquo;</span>
      </div>
    );
  }

  // Content height: enough to cover all positioned cards + code view
  const contentHeight = topOffset + Math.max(codeViewHeight, cardsBottom + 48);

  const hasAnnotations = fileFindings.length > 0 || fileComments.length > 0 || fileFeatures.length > 0;
  const isUnreconciled = hasAnnotations && !hasReconciliationData
    && reconciledHead !== null && !reconciledHead.isFullyReconciled;
  const hasItems = activityItems.length > 0 || showNewComment || showNewFinding || showNewFeature;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Activity</span>
        <span className="sidebar-count">{activityItems.length}{fileFeatures.length > 0 ? ` · ${fileFeatures.length}f` : ''}</span>
        <ReconcileIndicator reconciledHead={reconciledHead} activeJob={activeJob} />
        <button className="panel-drawer-btn" onClick={toggleSidebar} data-tooltip="Collapse sidebar">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1" y="2" width="14" height="12" rx="1" />
            <line x1="10.5" y1="2" x2="10.5" y2="14" />
          </svg>
        </button>
      </div>

      {fileFindings.length > 0 && (
        <div className="sidebar-severity-filter">
          {(['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((sev) => (
            <button
              key={sev}
              className={`sidebar-sev-btn sidebar-sev-${sev}${severityFilter.has(sev) ? ' active' : ''}${severityFilter.size > 0 && !severityFilter.has(sev) ? ' dimmed' : ''}`}
              onClick={() => toggleSeverity(sev)}
            >
              {sev.charAt(0).toUpperCase() + sev.slice(1)}
            </button>
          ))}
        </div>
      )}

      <div className="sidebar-content" ref={contentRef}>
        {isUnreconciled ? (
          <div className="sidebar-unreconciled">
            <div className="sidebar-unreconciled-icon">&#x26A0;</div>
            <div className="sidebar-unreconciled-text">
              This commit has not been reconciled yet. Annotation positions may not reflect the current code.
            </div>
            {activeJob && (activeJob.status === 'pending' || activeJob.status === 'running') && (
              <div className="sidebar-unreconciled-progress">Reconciliation in progress...</div>
            )}
          </div>
        ) : hasItems ? (
          <div style={{ height: contentHeight, position: 'relative' }}>
            {/* New comment form (positioned at target line) */}
            {showNewComment && commentDrag.startLine !== null && (
              <div
                className="comment-card comment-card-new"
                style={{ position: 'absolute', top: newCommentTop, left: 12, right: 12, zIndex: 10 }}
              >
                <div className="comment-card-header">
                  <span className="comment-card-line-label">
                    New comment on L{commentDrag.startLine}
                    {commentDrag.endLine && commentDrag.endLine !== commentDrag.startLine
                      ? `\u2013L${commentDrag.endLine}`
                      : ''}
                  </span>
                </div>
                <div className="comment-type-toggle-row">
                  <div className="comment-type-toggle">
                    {(['feature', 'improvement', 'question', 'concern'] as const).map((t) => (
                      <button
                        key={t}
                        className={`comment-type-toggle-btn${newCommentType === t ? ' active' : ''}`}
                        onClick={() => setNewCommentType(newCommentType === t ? '' : t)}
                        title={t.charAt(0).toUpperCase() + t.slice(1)}
                      >
                        {COMMENT_TYPE_ICON[t]}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="comment-textarea"
                    style={{ flex: 1 }}
                    value={newCommentText}
                    onChange={(e) => setNewCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmitNewComment();
                      if (e.key === 'Escape' && !newCommentText.trim()) { e.stopPropagation(); handleCancelNewComment(); }
                    }}
                    rows={3}
                    autoFocus
                  />
                </div>
                <div className="comment-form-actions">
                  <button className="comment-btn comment-btn-cancel" onClick={handleCancelNewComment}>
                    Cancel
                  </button>
                  <button
                    className="comment-btn comment-btn-submit"
                    onClick={handleSubmitNewComment}
                    disabled={!newCommentText.trim()}
                  >
                    Comment
                  </button>
                </div>
              </div>
            )}

            {/* New finding form (positioned at target line) */}
            {showNewFinding && commentDrag.startLine !== null && (
              <div
                className="finding-card finding-card-new"
                style={{ position: 'absolute', top: newCommentTop, left: 12, right: 12, zIndex: 10 }}
              >
                <div className="comment-card-header">
                  <span className="comment-card-line-label">
                    New finding on L{commentDrag.startLine}
                    {commentDrag.endLine && commentDrag.endLine !== commentDrag.startLine
                      ? `\u2013L${commentDrag.endLine}`
                      : ''}
                  </span>
                </div>
                <div className="finding-form-fields">
                  <input
                    className="finding-input"
                    type="text"
                    placeholder="Finding title"
                    value={newFindingTitle}
                    onChange={(e) => setNewFindingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmitNewFinding();
                      if (e.key === 'Escape' && !newFindingTitle.trim()) { e.stopPropagation(); handleCancelNewFinding(); }
                    }}
                    autoFocus
                  />
                  <div className="finding-form-row">
                    <select
                      className="finding-severity-select"
                      value={newFindingSeverity}
                      onChange={(e) => setNewFindingSeverity(e.target.value as Severity)}
                    >
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                      <option value="info">Info</option>
                    </select>
                    <select
                      className="finding-status-select"
                      value={newFindingStatus}
                      onChange={(e) => setNewFindingStatus(e.target.value as FindingStatus)}
                    >
                      <option value="draft">Draft</option>
                      <option value="open">Open</option>
                      <option value="in-progress">In Progress</option>
                      <option value="false-positive">False Positive</option>
                      <option value="accepted">Accepted</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <textarea
                    className="comment-textarea"
                    placeholder="Description (optional)"
                    value={newFindingDescription}
                    onChange={(e) => setNewFindingDescription(e.target.value)}
                    rows={2}
                  />
                </div>
                <div className="comment-form-actions">
                  <button className="comment-btn comment-btn-cancel" onClick={handleCancelNewFinding}>
                    Cancel
                  </button>
                  <button
                    className="comment-btn comment-btn-submit"
                    onClick={handleSubmitNewFinding}
                    disabled={!newFindingTitle.trim()}
                  >
                    Add Finding
                  </button>
                </div>
              </div>
            )}

            {/* New feature form (positioned at target line) */}
            {showNewFeature && commentDrag.startLine !== null && (
              <div
                className="finding-card feature-card-new"
                style={{ position: 'absolute', top: newCommentTop, left: 12, right: 12, zIndex: 10 }}
              >
                <div className="comment-card-header">
                  <span className="comment-card-line-label">
                    New feature on L{commentDrag.startLine}
                    {commentDrag.endLine && commentDrag.endLine !== commentDrag.startLine
                      ? `\u2013L${commentDrag.endLine}`
                      : ''}
                  </span>
                </div>
                <div className="finding-form-fields">
                  <div className="finding-form-row">
                    <label className="finding-form-label">Kind</label>
                    <select
                      className="finding-edit-select"
                      value={newFeatureKind}
                      onChange={e => setNewFeatureKind(e.target.value as FeatureKind)}
                    >
                      <option value="interface">Interface</option>
                      <option value="source">Source</option>
                      <option value="sink">Sink</option>
                      <option value="dependency">Dependency</option>
                      <option value="externality">Externality</option>
                    </select>
                  </div>
                  <div className="finding-form-row">
                    <label className="finding-form-label">Title</label>
                    <input
                      className="finding-input"
                      placeholder="e.g. GET /api/users"
                      value={newFeatureTitle}
                      onChange={e => setNewFeatureTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSaveFeature(); if (e.key === 'Escape') { setShowNewFeature(false); setAnnotationAction(null); }}}
                      autoFocus
                    />
                  </div>
                  <div className="finding-form-row">
                    <label className="finding-form-label">Description</label>
                    <textarea
                      className="finding-input"
                      placeholder="Optional details..."
                      value={newFeatureDescription}
                      onChange={e => setNewFeatureDescription(e.target.value)}
                      rows={2}
                      style={{ resize: 'vertical' }}
                    />
                  </div>
                  {newFeatureKind === 'interface' && (
                    <div className="finding-form-row">
                      <label className="finding-form-label">Operation</label>
                      <input
                        className="finding-input"
                        placeholder="GET, POST, query, rpc GetUser…"
                        value={newFeatureOperation}
                        onChange={e => setNewFeatureOperation(e.target.value)}
                      />
                    </div>
                  )}
                  {(newFeatureKind === 'interface' || newFeatureKind === 'source' || newFeatureKind === 'sink') && (
                    <div className="finding-form-row">
                      <label className="finding-form-label">Protocol</label>
                      <input
                        className="finding-input"
                        placeholder="rest, grpc, graphql, kafka…"
                        value={newFeatureProtocol}
                        onChange={e => setNewFeatureProtocol(e.target.value)}
                      />
                    </div>
                  )}
                  {(newFeatureKind === 'source' || newFeatureKind === 'sink') && (
                    <div className="finding-form-row">
                      <label className="finding-form-label">Direction</label>
                      <select
                        className="finding-edit-select"
                        value={newFeatureDirection}
                        onChange={e => setNewFeatureDirection(e.target.value as 'in' | 'out' | '')}
                      >
                        <option value="">—</option>
                        <option value="in">← In (source)</option>
                        <option value="out">→ Out (sink)</option>
                      </select>
                    </div>
                  )}
                  <div className="finding-form-row">
                    <label className="finding-form-label">Tags</label>
                    <input
                      className="finding-input"
                      placeholder="pii, auth, public (comma separated)"
                      value={newFeatureTags}
                      onChange={e => setNewFeatureTags(e.target.value)}
                    />
                  </div>
                </div>
                <div className="comment-form-actions">
                  <button className="comment-btn comment-btn-cancel" onClick={() => { setShowNewFeature(false); setAnnotationAction(null); }}>
                    Cancel
                  </button>
                  <button
                    className="comment-btn comment-btn-submit"
                    onClick={handleSaveFeature}
                    disabled={!newFeatureTitle.trim()}
                  >
                    Save
                  </button>
                </div>
              </div>
            )}

            {/* Positioned activity cards */}
            {activityItems.map((item) => {
              const id = item.data.id;
              const effectiveRange = getEffectiveLineRange(item.data);
              const line = effectiveRange?.start ?? 1;
              const top = getTop(id, line);
              const visibility = positionsReady ? 'visible' : 'hidden';

              if (item.kind === 'finding') {
                return (
                  <div
                    key={id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(id, el);
                      else cardRefs.current.delete(id);
                    }}
                    style={{ position: 'absolute', top, left: 12, right: 12, visibility }}
                  >
                    <FindingCard
                      finding={item.data}
                      isExpanded={expandedFindingId === id}
                      isFocused={expandedFindingId === id}
                      onToggle={() => {
                        const expanding = expandedFindingId !== id;
                        setExpandedFinding(expanding ? id : null);
                        setHighlightRange(expanding && effectiveRange ? effectiveRange : null);
                        if (expanding && effectiveRange) setScrollTargetLine(effectiveRange.start);
                      }}
                      onScrollTo={() => {
                        if (effectiveRange) setScrollTargetLine(effectiveRange.start);
                      }}
                    />
                  </div>
                );
              }

              if (item.kind === 'feature') {
                return (
                  <div
                    key={id}
                    ref={(el) => {
                      if (el) cardRefs.current.set(id, el);
                      else cardRefs.current.delete(id);
                    }}
                    style={{ position: 'absolute', top, left: 12, right: 12, visibility }}
                  >
                    <FeatureCard
                      feature={item.data}
                      isExpanded={expandedFindingId === id}
                      compact
                      onToggle={() => {
                        const expanding = expandedFindingId !== id;
                        setExpandedFinding(expanding ? id : null);
                        setHighlightRange(expanding && effectiveRange ? effectiveRange : null);
                        if (expanding && effectiveRange) setScrollTargetLine(effectiveRange.start);
                      }}
                      onScrollTo={() => {
                        if (effectiveRange) setScrollTargetLine(effectiveRange.start);
                      }}
                    />
                  </div>
                );
              }

              const comment = item.data;
              const isEditing = editingId === comment.id;
              const commentRange = getEffectiveLineRange(comment);

              return (
                <div
                  key={id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(id, el);
                    else cardRefs.current.delete(id);
                  }}
                  className="comment-card comment-card-clickable"
                  style={{ position: 'absolute', top, left: 12, right: 12, cursor: 'pointer', visibility }}
                  onClick={() => {
                    if (commentRange) {
                      setScrollTargetLine(commentRange.start);
                      setHighlightRange(commentRange);
                    }
                  }}
                >
                  <div className="comment-card-header">
                    <span className="comment-card-author">{comment.author}</span>
                    {comment.timestamp && (
                      <span className="finding-comment-time">
                        {new Date(comment.timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{' '}{new Date(comment.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {!isEditing && (
                      <div className="comment-card-header-right">
                        <button
                          className="comment-icon-btn"
                          onClick={(e) => { e.stopPropagation(); handleStartEdit(comment); }}
                          title="Edit"
                        >
                          &#x270E;
                        </button>
                        <button
                          className="comment-icon-btn comment-icon-btn-danger"
                          onClick={(e) => { e.stopPropagation(); handleDelete(comment.id); }}
                          title="Delete"
                        >
                          &#x2715;
                        </button>
                      </div>
                    )}
                  </div>
                  {isEditing ? (
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
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEdit();
                            if (e.key === 'Escape') handleCancelEdit();
                          }}
                          rows={2}
                          autoFocus
                        />
                      </div>
                      <div className="comment-form-actions">
                        <button className="comment-btn comment-btn-cancel" onClick={handleCancelEdit}>
                          Cancel
                        </button>
                        <button
                          className="comment-btn comment-btn-submit"
                          onClick={handleSaveEdit}
                          disabled={!editText.trim()}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="comment-card-text">
                      {comment.commentType && COMMENT_TYPE_ICON[comment.commentType] && (
                        <span className="comment-type-icon" title={COMMENT_TYPE_LABEL[comment.commentType]}>{COMMENT_TYPE_ICON[comment.commentType]}</span>
                      )}
                      <InlineMarkdown text={comment.text} />
                    </div>
                  )}
                  <div className="overview-card-meta">
                    {comment.anchor.fileId && (
                      <span
                        className="overview-comment-file"
                        title={comment.anchor.fileId}
                        onClick={(e) => {
                          e.stopPropagation();
                          window.location.hash = `#/browse/${comment.anchor.fileId}`;
                        }}
                      >
                        {comment.anchor.fileId.split('/').pop()}
                        {commentRange && `:${commentRange.start}`}
                      </span>
                    )}
                    <span className="overview-card-meta-right">
                      {comment.anchor.commitId && gitHead === comment.anchor.commitId && (
                        <span className="commit-head-badge">HEAD</span>
                      )}
                      {comment.anchor.commitId && branchMap.get(comment.anchor.commitId)?.map((name) => (
                        <span key={name} className="commit-branch-badge">{name}</span>
                      ))}
                      {comment.anchor.commitId && (
                        <span
                          className="overview-commit-ref overview-commit-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            useRepoStore.getState().selectCommit(comment.anchor.commitId);
                            window.location.hash = comment.anchor.fileId ? `#/browse/${comment.anchor.fileId}` : '#/browse';
                          }}
                        >
                          {comment.anchor.commitId.slice(0, 7)}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="sidebar-empty">No activity yet</div>
        )}
      </div>

    </aside>
  );
};
