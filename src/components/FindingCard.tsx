import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { useReconcileStore } from '../stores/reconcile-store';
import type { Finding, Comment, Feature, Severity, FindingStatus } from '../core/types';
import { FINDING_CATEGORIES, getEffectiveLineRange, getConfidence } from '../core/types';
import { featuresApi } from '../core/api';
import { InlineMarkdown } from '../core/markdown';
import { useBranchMap } from '../core/use-branch-map';
import { gitApi } from '../core/api';
import { detectLanguage, ensureLanguageRegistered } from '../core/language-map';
import { highlight, renderToken } from '../core/tokenizer';
import { RefProviderIcon } from './RefProviderIcon';
import { RefManageModal } from './RefManageModal';

interface FindingCardProps {
  finding: Finding;
  isExpanded: boolean;
  isFocused?: boolean;
  onToggle: () => void;
  onScrollTo: () => void;
}

const KIND_COLORS: Record<string, string> = {
  interface:   '#2563eb',
  source:      '#16a34a',
  sink:        '#ea580c',
  dependency:  '#7c3aed',
  externality: '#6b7280',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
  info: '#6b7280',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  open: 'Open',
  'in-progress': 'In Progress',
  'false-positive': 'False Positive',
  accepted: 'Accepted',
  closed: 'Closed',
};

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const STATUSES: FindingStatus[] = ['draft', 'open', 'in-progress', 'false-positive', 'accepted', 'closed'];
const SOURCES = ['pentest', 'tool', 'manual'] as const;
const KINDS_ORDER = ['interface', 'source', 'sink', 'dependency', 'externality'] as const;
const PER_KIND_LIMIT = 5;

export const FindingCard: React.FC<FindingCardProps> = ({
  finding,
  isExpanded,
  isFocused,
  onToggle,
  onScrollTo,
}) => {
  const updateFinding = useAnnotationStore((s) => s.updateFinding);
  const deleteFinding = useAnnotationStore((s) => s.deleteFinding);
  const addComment = useAnnotationStore((s) => s.addComment);
  const updateComment = useAnnotationStore((s) => s.updateComment);
  const deleteComment = useAnnotationStore((s) => s.deleteComment);
  const fetchCommentsForFinding = useAnnotationStore((s) => s.fetchCommentsForFinding);
  const findingComments = useAnnotationStore((s) => s.getCommentsForFinding(finding.id));
  const allFeatures = useAnnotationStore((s) => s.features);
  const branches = useRepoStore((s) => s.branches);
  const viewMode = useUIStore((s) => s.viewMode);
  const reconciledHead = useReconcileStore((s) => s.head);
  const gitHead = reconciledHead?.gitHead ?? null;

  const branchMap = useBranchMap();

  // Local refs so the meta row updates immediately after modal operations
  const [cardRefs, setCardRefs] = useState(finding.refs ?? []);

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [linking, setLinking] = useState(false);
  const [managingRefs, setManagingRefs] = useState(false);
  const [managingRefsCommentId, setManagingRefsCommentId] = useState<string | null>(null);
  const [linkDraftIds, setLinkDraftIds] = useState<string[]>([]);
  const [modalFeatures, setModalFeatures] = useState<Feature[]>([]);
  const [linkSearch, setLinkSearch] = useState('');

  // Comment state — consume draft carried from another view (e.g. Overview → Browse)
  const draftComment = useUIStore((s) => s.draftComment);
  const setDraftComment = useUIStore((s) => s.setDraftComment);
  const consumedDraft = draftComment?.findingId === finding.id ? draftComment.text : '';
  const [replyText, setReplyText] = useState(consumedDraft);
  const [submittingReply, setSubmittingReply] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentText, setEditCommentText] = useState('');
  const [showAllComments, setShowAllComments] = useState(false);

  // Clear consumed draft once hydrated into local state
  useEffect(() => {
    if (draftComment?.findingId === finding.id) {
      setDraftComment(null);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch comments when expanded
  useEffect(() => {
    if (isExpanded) {
      fetchCommentsForFinding(finding.id);
    }
  }, [isExpanded, finding.id, fetchCommentsForFinding]);

  const sortedComments = useMemo(
    () => [...findingComments].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [findingComments],
  );

  // Edit form state
  const [title, setTitle] = useState(finding.title);
  const [description, setDescription] = useState(finding.description);
  const [severity, setSeverity] = useState<Severity>(finding.severity);
  const [status, setStatus] = useState<FindingStatus>(finding.status);
  const [source, setSource] = useState(finding.source);
  const [cwe, setCwe] = useState(finding.cwe);
  const [cve, setCve] = useState(finding.cve);
  const [vector, setVector] = useState(finding.vector);
  const [score, setScore] = useState(finding.score?.toString() ?? '');
  const [category, setCategory] = useState(finding.category ?? '');
  const [anchorFileId, setAnchorFileId] = useState(finding.anchor.fileId ?? '');
  const [anchorLineStart, setAnchorLineStart] = useState(finding.anchor.lineRange?.start?.toString() ?? '');
  const [anchorLineEnd, setAnchorLineEnd] = useState(finding.anchor.lineRange?.end?.toString() ?? '');

  const lineRange = getEffectiveLineRange(finding);
  const confidence = getConfidence(finding);
  const lineLabel = lineRange
    ? lineRange.start === lineRange.end
      ? `L${lineRange.start}`
      : `L${lineRange.start}\u2013${lineRange.end}`
    : null;

  const fileId = finding.anchor.fileId;
  const fileName = fileId ? fileId.split('/').pop() : null;
  const parentDir = fileId && fileId.includes('/') ? fileId.split('/').slice(-2, -1)[0] : null;

  // Snippet state
  const [fileLines, setFileLines] = useState<{ lines: string[]; lang: string } | null>(null);
  const [extraBefore, setExtraBefore] = useState(0);
  const [extraAfter, setExtraAfter] = useState(0);

  useEffect(() => {
    if (!isExpanded || !lineRange || !finding.anchor.fileId) { setFileLines(null); return; }
    const commitId = finding.anchor.commitId;
    if (!commitId) return;
    const lang = detectLanguage(finding.anchor.fileId) ?? '';
    let cancelled = false;
    setExtraBefore(0);
    setExtraAfter(0);
    gitApi.getFileContent(commitId, finding.anchor.fileId)
      .then(async ({ content }) => {
        if (lang) await ensureLanguageRegistered(lang);
        if (cancelled) return;
        setFileLines({ lines: content.split('\n'), lang });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isExpanded, lineRange?.start, lineRange?.end, finding.anchor.fileId, finding.anchor.commitId]);

  const [fetchedFeatures, setFetchedFeatures] = useState<Feature[] | null>(null);

  useEffect(() => {
    if (!isExpanded || !finding.features?.length) return;
    featuresApi.list().then((f) => setFetchedFeatures(f as Feature[])).catch(() => {});
  }, [isExpanded, finding.features]);

  const linkedFeatures = useMemo(() => {
    if (!finding.features?.length) return [] as Feature[];
    const source = fetchedFeatures ?? allFeatures;
    const byId = new Map(source.map((f) => [f.id, f]));
    return finding.features.map((id) => byId.get(id)).filter((f): f is Feature => f !== undefined);
  }, [finding.features, fetchedFeatures, allFeatures]);

  const snippet = useMemo(() => {
    if (!fileLines || !lineRange) return null;
    const CONTEXT = 1;
    const from = Math.max(0, lineRange.start - 1 - CONTEXT - extraBefore);
    const to = Math.min(fileLines.lines.length, lineRange.end + CONTEXT + extraAfter);
    return {
      lines: fileLines.lines.slice(from, to),
      startLine: from + 1,
      lang: fileLines.lang,
      canExpandUp: from > 0,
      canExpandDown: to < fileLines.lines.length,
    };
  }, [fileLines, lineRange, extraBefore, extraAfter]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTitle(finding.title);
    setDescription(finding.description);
    setSeverity(finding.severity);
    setStatus(finding.status);
    setSource(finding.source);
    setCwe(finding.cwe);
    setCve(finding.cve);
    setVector(finding.vector);
    setScore(finding.score?.toString() ?? '');
    setCategory(finding.category ?? '');
    setAnchorFileId(finding.anchor.fileId ?? '');
    setAnchorLineStart(finding.anchor.lineRange?.start?.toString() ?? '');
    setAnchorLineEnd(finding.anchor.lineRange?.end?.toString() ?? '');
    setEditing(true);
  };

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const startNum = parseInt(anchorLineStart, 10);
    const endNum = parseInt(anchorLineEnd, 10);
    const updates: Record<string, unknown> = {
      title: trimmedTitle,
      description: description.trim(),
      severity,
      status,
      source,
      cwe: cwe.trim(),
      cve: cve.trim(),
      vector: vector.trim(),
      score: score !== '' ? parseFloat(score) : undefined,
      category,
    };
    if (anchorFileId.trim()) updates['file_id'] = anchorFileId.trim();
    if (startNum > 0 && endNum > 0) { updates['line_start'] = startNum; updates['line_end'] = endNum; }
    updateFinding(finding.id, updates);
    setEditing(false);
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteFinding(finding.id);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const handleOpenLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLinkDraftIds(finding.features ?? []);
    setModalFeatures(allFeatures);
    setLinkSearch('');
    setLinking(true);
    featuresApi.list().then((f) => setModalFeatures(f as Feature[])).catch(() => {});
  };

  const handleLinkSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateFinding(finding.id, { features: linkDraftIds } as any);
    setLinking(false);
  };

  const handleLinkClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLinking(false);
  };

  // Quick status cycle from header (no full edit needed)
  const handleStatusCycle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const idx = STATUSES.indexOf(finding.status);
    const next = STATUSES[(idx + 1) % STATUSES.length];
    updateFinding(finding.id, { status: next });
  };

  const handleSubmitReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    setSubmittingReply(true);
    addComment({
      id: `CMT-${Date.now()}`,
      anchor: { ...finding.anchor },
      author: 'you',
      text: trimmed,
      timestamp: new Date().toISOString(),
      threadId: `T-${finding.id}`,
      findingId: finding.id,
    });
    setReplyText('');
    setDraftComment(null);
    setSubmittingReply(false);
  };

  if (editing) {
    return (
      <div
        className="finding-card finding-card-editing"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
      >
        <div className="finding-edit-form">
          <input
            className="finding-edit-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            autoFocus
          />

          <textarea
            className="finding-edit-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            rows={3}
          />

          <div className="finding-edit-row">
            <label className="finding-edit-label">Severity</label>
            <div className="finding-severity-toggle">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`finding-severity-toggle-btn severity-${s}${severity === s ? ' active' : ''}`}
                  onClick={() => setSeverity(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">Status</label>
            <div className="finding-status-toggle">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`finding-status-toggle-btn status-${s}${status === s ? ' active' : ''}`}
                  onClick={() => setStatus(s)}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">Source</label>
            <select
              className="finding-edit-select"
              value={source}
              onChange={(e) => setSource(e.target.value as typeof SOURCES[number])}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">Category</label>
            <select
              className="finding-edit-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">None</option>
              {FINDING_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">CWE</label>
            <input
              className="finding-edit-input-sm"
              value={cwe}
              onChange={(e) => setCwe(e.target.value)}
              placeholder="e.g. CWE-79"
            />
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">CVE</label>
            <input
              className="finding-edit-input-sm"
              value={cve}
              onChange={(e) => setCve(e.target.value)}
              placeholder="e.g. CVE-2024-1234"
            />
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">Vector</label>
            <input
              className="finding-edit-input-sm"
              value={vector}
              onChange={(e) => setVector(e.target.value)}
              placeholder="CVSS vector string"
            />
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">Score</label>
            <input
              className="finding-edit-input-sm"
              type="number"
              min="0"
              max="10"
              step="0.1"
              value={score}
              onChange={(e) => setScore(e.target.value)}
            />
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">File</label>
            <input
              className="finding-edit-input-sm"
              value={anchorFileId}
              onChange={(e) => setAnchorFileId(e.target.value)}
              placeholder="src/api/auth.go"
              style={{ flex: 1 }}
            />
          </div>

          <div className="finding-edit-row">
            <label className="finding-edit-label">Lines</label>
            <input
              className="finding-edit-input-sm"
              type="number"
              min="1"
              value={anchorLineStart}
              onChange={(e) => setAnchorLineStart(e.target.value)}
              placeholder="start"
              style={{ width: 64 }}
            />
            <span style={{ padding: '0 4px', color: 'var(--text-muted)' }}>–</span>
            <input
              className="finding-edit-input-sm"
              type="number"
              min="1"
              value={anchorLineEnd}
              onChange={(e) => setAnchorLineEnd(e.target.value)}
              placeholder="end"
              style={{ width: 64 }}
            />
          </div>

          <div className="finding-edit-actions">
            <button className="finding-edit-save" onClick={handleSave}>Save</button>
            <button className="finding-edit-cancel" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`finding-card ${isExpanded ? 'finding-card-expanded' : ''} ${isFocused ? 'finding-card-focused' : ''}`}
      style={{ '--card-severity': `var(--severity-${finding.severity})` } as React.CSSProperties}
    >
      <div className="finding-card-header" onClick={onToggle}>
        <div className="finding-card-header-top">
          <span
            className="severity-dot"
            style={{ backgroundColor: SEVERITY_COLORS[finding.severity] }}
            title={finding.severity}
          />
          <span className="finding-severity-label">{finding.severity}</span>
          <span className={`finding-id-badge${idCopied ? ' finding-id-copied' : ''}`} title="Click to copy ID" onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(finding.id);
            setIdCopied(true);
            setTimeout(() => setIdCopied(false), 1200);
          }}>
            {idCopied ? 'Copied!' : finding.id.slice(0, 8)}
            {!idCopied && <span className="finding-id-copy">&#x2398;</span>}
          </span>
          <span className="finding-source-badge">{finding.source}</span>
          <span
            className={`finding-status-label status-${finding.status}`}
            onClick={handleStatusCycle}
            title="Click to cycle status"
            role="button"
          >
            {STATUS_LABELS[finding.status]}
          </span>
          <div className="comment-card-header-right">
            <button
              className="comment-icon-btn"
              onClick={(e) => { e.stopPropagation(); setManagingRefs(true); }}
              title="Manage web links"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 10L10 2M10 2H5M10 2v5"/>
              </svg>
            </button>
            <button
              className="comment-icon-btn"
              onClick={handleOpenLink}
              title="Manage feature links"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z"/>
              </svg>
            </button>
            <button
              className="comment-icon-btn"
              onClick={handleStartEdit}
              title="Edit"
            >&#x270E;</button>
            {!confirmDelete ? (
              <button
                className="comment-icon-btn comment-icon-btn-danger"
                onClick={handleDelete}
                title="Delete"
              >&#x2715;</button>
            ) : (
              <span className="finding-delete-confirm">
                <button className="finding-delete-yes" onClick={handleDelete}>Delete</button>
                <button className="finding-delete-no" onClick={handleCancelDelete}>No</button>
              </span>
            )}
          </div>
        </div>
        <div className="finding-title-row">
          <span className={`finding-expand-chevron${isExpanded ? ' finding-expand-chevron--open' : ''}`}>&#9658;</span>
          <span className="finding-title">{finding.title}</span>
        </div>
        {!isExpanded && finding.description && (
          <p className="finding-description feature-description-collapsed">{finding.description}</p>
        )}
      </div>

      <div className="finding-card-meta">
        {cardRefs.length > 0 && (
          <span className="ref-icons" onClick={(e) => e.stopPropagation()}>
            <span className="ref-icons-label">Links</span>
            {cardRefs.map((ref) => (
              <a
                key={ref.id}
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ref-icon-link"
                title={ref.title || ref.url}
              >
                <RefProviderIcon provider={ref.provider} size={14} />
              </a>
            ))}
          </span>
        )}
        {finding.cve && <span className="finding-cve">{finding.cve}</span>}
        {finding.score > 0 && <span className="finding-score">{finding.score.toFixed(1)}</span>}
        {confidence && confidence !== 'exact' && (
          <span className={`finding-confidence finding-confidence-${confidence}`}>
            {confidence === 'moved' ? 'Moved' : 'Orphaned'}
          </span>
        )}
      </div>

      {isExpanded && (
        <div className="finding-card-body">
          <p className="finding-description"><InlineMarkdown text={finding.description} /></p>

          {finding.vector && (
            <div className="finding-detail-row">
              <span className="finding-detail-label">Vector</span>
              <span className="finding-detail-value finding-vector-value">{finding.vector}</span>
            </div>
          )}

          {snippet && lineRange && viewMode !== 'browse' && (
            <div className="feature-snippet">
              {snippet.canExpandUp && (
                <button className="feature-snippet-expand" onClick={() => setExtraBefore((n) => n + 5)}>
                  ▲ 5 more
                </button>
              )}
              {snippet.lines.map((line, i) => {
                const lineNum = snippet.startLine + i;
                const isHighlighted = lineNum >= lineRange.start && lineNum <= lineRange.end;
                const tokens = snippet.lang ? highlight(line, snippet.lang) : [{ type: 'text' as const, value: line }];
                return (
                  <div key={i} className={`feature-snippet-row${isHighlighted ? ' feature-snippet-row-highlight' : ''}`}>
                    <span className="feature-snippet-ln">{lineNum}</span>
                    <code className="feature-snippet-code">{tokens.map((t, ti) => renderToken(t, ti))}</code>
                  </div>
                );
              })}
              {snippet.canExpandDown && (
                <button className="feature-snippet-expand" onClick={() => setExtraAfter((n) => n + 5)}>
                  ▼ 5 more
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {isExpanded && linkedFeatures.length > 0 && linkedFeatures.map((feat) => (
        <div
          key={feat.id}
          className="activity-feature-ref finding-feature-ref"
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
      ))}

      {isExpanded && (sortedComments.length > 0 || true) && (
        <div className="finding-comments" onClick={(e) => e.stopPropagation()}>
          {(() => {
            const hiddenCount = sortedComments.length > 1 && !showAllComments ? sortedComments.length - 1 : 0;
            const visibleComments = hiddenCount > 0 ? sortedComments.slice(-1) : sortedComments;

            const renderComment = (c: Comment) => (
              <div key={c.id} className={`finding-comment${editingCommentId === c.id ? ' finding-comment-editing' : ''}`}>
                <div className="finding-comment-header">
                  <span className="finding-comment-author">{c.author}</span>
                  <span className="finding-comment-time">
                    {new Date(c.timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{' '}{new Date(c.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {editingCommentId !== c.id && (
                    <div className="comment-card-header-right" style={{ marginLeft: 'auto' }}>
                      <button
                        className="comment-icon-btn"
                        onClick={() => setManagingRefsCommentId(c.id)}
                        title="Manage web links"
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 10L10 2M10 2H5M10 2v5"/>
                        </svg>
                      </button>
                      <button
                        className="comment-icon-btn"
                        onClick={() => { setEditingCommentId(c.id); setEditCommentText(c.text); }}
                        title="Edit"
                      >&#x270E;</button>
                      <button
                        className="comment-icon-btn comment-icon-btn-danger"
                        onClick={() => deleteComment(c.id)}
                        title="Delete"
                      >&#x2715;</button>
                    </div>
                  )}
                </div>
                {c.refs && c.refs.length > 0 && editingCommentId !== c.id && (
                  <div className="comment-ref-icons">
                    {c.refs.map((ref) => (
                      <a
                        key={ref.id}
                        href={ref.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ref-icon-link"
                        title={ref.title || ref.url}
                      >
                        <RefProviderIcon provider={ref.provider} size={11} />
                      </a>
                    ))}
                  </div>
                )}
                {editingCommentId === c.id ? (
                  <div>
                    <textarea
                      className="comment-textarea"
                      value={editCommentText}
                      onChange={(e) => setEditCommentText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          updateComment(editingCommentId!, editCommentText.trim());
                          setEditingCommentId(null);
                        }
                        if (e.key === 'Escape') setEditingCommentId(null);
                      }}
                      rows={2}
                      autoFocus
                    />
                    <div className="comment-form-actions">
                      <button className="comment-btn comment-btn-cancel" onClick={() => setEditingCommentId(null)}>Cancel</button>
                      <button
                        className="comment-btn comment-btn-submit"
                        onClick={() => {
                          if (editCommentText.trim()) {
                            updateComment(editingCommentId!, editCommentText.trim());
                            setEditingCommentId(null);
                          }
                        }}
                        disabled={!editCommentText.trim()}
                      >Save</button>
                    </div>
                  </div>
                ) : (
                  <div className="finding-comment-text">
                    <InlineMarkdown text={c.text} />
                  </div>
                )}
              </div>
            );

            return (
              <>
                {hiddenCount > 0 && (
                  <button
                    className="finding-comments-toggle"
                    onClick={() => setShowAllComments(true)}
                  >
                    {hiddenCount} previous {hiddenCount === 1 ? 'comment' : 'comments'}
                  </button>
                )}
                {showAllComments && sortedComments.length > 1 && (
                  <button
                    className="finding-comments-toggle"
                    onClick={() => setShowAllComments(false)}
                  >
                    Hide previous comments
                  </button>
                )}
                {visibleComments.map(renderComment)}
              </>
            );
          })()}

          <div className="finding-comment-compose">
            <textarea
              placeholder="Reply..."
              value={replyText}
              onChange={(e) => {
                setReplyText(e.target.value);
                setDraftComment(e.target.value.trim() ? { text: e.target.value, findingId: finding.id } : null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && replyText.trim()) {
                  handleSubmitReply();
                }
              }}
              rows={1}
            />
            <button
              disabled={!replyText.trim() || submittingReply}
              onClick={handleSubmitReply}
            >
              &rarr;
            </button>
          </div>
        </div>
      )}

      {linking && createPortal(
        <div className="overlay-backdrop" onClick={handleLinkClose}>
          <div className="feature-link-modal" onClick={(e) => e.stopPropagation()}>
            <div className="feature-link-modal-header">
              <span>Feature Links</span>
              <button className="shortcuts-close" onClick={handleLinkClose}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </button>
            </div>
            <div className="feature-link-modal-body">
              <div>
                <div className="feature-link-section-label">Linked</div>
                {linkDraftIds.length === 0 && (
                  <div className="feature-link-empty">No features linked</div>
                )}
                {linkDraftIds.map((fid) => {
                  const feat = modalFeatures.find((f) => f.id === fid);
                  if (!feat) return null;
                  return (
                    <div key={fid} className="feature-link-row" style={{ marginBottom: 6 }}>
                      <span className="feature-link-kind-badge" style={{ background: KIND_COLORS[feat.kind] ?? '#6b7280' }}>
                        {feat.kind}
                      </span>
                      <span className="feature-link-title">{feat.title}</span>
                      {feat.anchor.fileId && (
                        <span className="feature-link-file">{feat.anchor.fileId.split('/').pop()}</span>
                      )}
                      <button
                        className="feature-link-remove"
                        title="Remove"
                        onClick={() => setLinkDraftIds((ids) => ids.filter((id) => id !== fid))}
                      >&#x2715;</button>
                    </div>
                  );
                })}
              </div>
              <div>
                <div className="feature-link-section-label">Add</div>
                <input
                  className="feature-link-search"
                  type="text"
                  placeholder="Search features…"
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                {(() => {
                  const available = modalFeatures.filter((f) => !linkDraftIds.includes(f.id));
                  if (available.length === 0) {
                    return <div className="feature-link-empty">All features already linked</div>;
                  }
                  const searchLower = linkSearch.toLowerCase().trim();
                  let addList: Feature[];
                  let hiddenCount = 0;
                  if (searchLower) {
                    addList = available.filter(
                      (f) =>
                        f.title.toLowerCase().includes(searchLower) ||
                        f.kind.toLowerCase().includes(searchLower) ||
                        (f.anchor.fileId && f.anchor.fileId.toLowerCase().includes(searchLower)),
                    );
                  } else {
                    addList = KINDS_ORDER.flatMap((kind) =>
                      available.filter((f) => f.kind === kind).slice(0, PER_KIND_LIMIT),
                    );
                    hiddenCount = available.length - addList.length;
                  }
                  if (addList.length === 0) {
                    return <div className="feature-link-empty">No features match</div>;
                  }
                  return (
                    <>
                      {addList.map((feat) => (
                        <div key={feat.id} className="feature-link-row feature-link-row-add" style={{ marginBottom: 6 }} onClick={() => setLinkDraftIds((ids) => [...ids, feat.id])}>
                          <span className="feature-link-kind-badge" style={{ background: KIND_COLORS[feat.kind] ?? '#6b7280' }}>
                            {feat.kind}
                          </span>
                          <span className="feature-link-title">{feat.title}</span>
                          {feat.anchor.fileId && (
                            <span className="feature-link-file">{feat.anchor.fileId.split('/').pop()}</span>
                          )}
                          <button className="feature-link-add-btn" title="Add" onClick={(e) => { e.stopPropagation(); setLinkDraftIds((ids) => [...ids, feat.id]); }}>+</button>
                        </div>
                      ))}
                      {hiddenCount > 0 && (
                        <div className="feature-link-hidden-count">{hiddenCount} more — search to filter</div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>
            <div className="feature-link-modal-footer">
              <button className="baseline-action-btn" onClick={handleLinkClose}>Cancel</button>
              <button className="baseline-action-btn baseline-action-btn-primary" onClick={handleLinkSave}>Save</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {managingRefs && createPortal(
        <RefManageModal
          entityType="finding"
          entityId={finding.id}
          refs={cardRefs}
          onClose={() => setManagingRefs(false)}
          onRefsChange={setCardRefs}
        />,
        document.body
      )}

      {managingRefsCommentId && createPortal(
        <RefManageModal
          entityType="comment"
          entityId={managingRefsCommentId}
          refs={findingComments.find((c) => c.id === managingRefsCommentId)?.refs ?? []}
          onClose={() => setManagingRefsCommentId(null)}
        />,
        document.body
      )}

      <div className="overview-card-meta">
        {fileId && (
          <span className="overview-comment-file" title={fileId} onClick={(e) => { e.stopPropagation(); onScrollTo(); }}>
            {fileId.split('/').pop()}
            {lineRange && `:${lineRange.start}${lineRange.end !== lineRange.start ? `-${lineRange.end}` : ''}`}
          </span>
        )}
        <span className="overview-card-meta-right">
          {finding.anchor.commitId && gitHead === finding.anchor.commitId && (
            <span className="commit-head-badge">HEAD</span>
          )}
          {finding.anchor.commitId && branchMap.get(finding.anchor.commitId)?.map((name) => (
            <span key={name} className="commit-branch-badge">{name}</span>
          ))}
          {finding.anchor.commitId && (
            <span
              className="overview-commit-ref overview-commit-link"
              onClick={(e) => {
                e.stopPropagation();
                useRepoStore.getState().selectCommit(finding.anchor.commitId);
                useUIStore.getState().setViewMode('browse');
                if (fileId) useRepoStore.getState().selectFile(fileId);
              }}
            >
              {finding.anchor.commitId.slice(0, 7)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
};
