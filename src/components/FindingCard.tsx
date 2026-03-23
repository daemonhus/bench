import React, { useState, useMemo, useEffect } from 'react';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { useReconcileStore } from '../stores/reconcile-store';
import type { Finding, Comment, Severity, FindingStatus } from '../core/types';
import { FINDING_CATEGORIES, getEffectiveLineRange, getConfidence } from '../core/types';
import { InlineMarkdown } from '../core/markdown';
import { useBranchMap } from '../core/use-branch-map';

interface FindingCardProps {
  finding: Finding;
  isExpanded: boolean;
  isFocused?: boolean;
  onToggle: () => void;
  onScrollTo: () => void;
}

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
  const branches = useRepoStore((s) => s.branches);
  const reconciledHead = useReconcileStore((s) => s.head);
  const gitHead = reconciledHead?.gitHead ?? null;

  const branchMap = useBranchMap();

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [idCopied, setIdCopied] = useState(false);

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
  const [score, setScore] = useState(finding.score);
  const [category, setCategory] = useState(finding.category ?? '');

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
    setScore(finding.score);
    setCategory(finding.category ?? '');
    setEditing(true);
  };

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    updateFinding(finding.id, {
      title: trimmedTitle,
      description: description.trim(),
      severity,
      status,
      source,
      cwe: cwe.trim(),
      cve: cve.trim(),
      vector: vector.trim(),
      score,
      category: category,
    });
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
              onChange={(e) => setScore(parseFloat(e.target.value) || 0)}
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
        <span className="finding-title">{finding.title}</span>
      </div>

      <div className="finding-card-meta">
        {finding.cwe && <span className="finding-cwe">{finding.cwe}</span>}
        {finding.cve && <span className="finding-cve">{finding.cve}</span>}
        <span className="finding-severity-label">{finding.severity}</span>
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
        </div>
      )}

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

      <div className="overview-card-meta">
        {fileId && (
          <span className="overview-comment-file" title={fileId} onClick={(e) => { e.stopPropagation(); onScrollTo(); }}>
            {fileId.split('/').pop()}
            {lineRange && `:${lineRange.start}`}
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
