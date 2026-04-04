import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { gitApi } from '../core/api';
import { detectLanguage, ensureLanguageRegistered } from '../core/language-map';
import { highlight, renderToken } from '../core/tokenizer';
import { InlineMarkdown } from '../core/markdown';
import type { Feature, FeatureKind, FeatureStatus, FeatureParameter } from '../core/types';
import { RefProviderIcon } from './RefProviderIcon';
import { RefManageModal } from './RefManageModal';

interface FeatureCardProps {
  feature: Feature;
  isExpanded: boolean;
  onToggle: () => void;
  onScrollTo?: () => void;
  compact?: boolean;
}

const PARAM_TYPE_COLORS: Record<string, string> = {
  string:  '#16a34a',
  integer: '#2563eb',
  number:  '#2563eb',
  boolean: '#7c3aed',
  object:  '#d97706',
  array:   '#0891b2',
  file:    '#db2777',
};

const KIND_COLORS: Record<FeatureKind, string> = {
  interface:   '#2563eb',
  source:      '#16a34a',
  sink:        '#ea580c',
  dependency:  '#7c3aed',
  externality: '#6b7280',
};

const KIND_LABELS: Record<FeatureKind, string> = {
  interface:   'Interface',
  source:      'Source',
  sink:        'Sink',
  dependency:  'Dependency',
  externality: 'Externality',
};

const STATUS_LABELS: Record<FeatureStatus, string> = {
  draft:       'Draft',
  active:      'Active',
  deprecated:  'Deprecated',
  removed:     'Removed',
  orphaned:    'Orphaned',
};

const ALL_KINDS: FeatureKind[] = ['interface', 'source', 'sink', 'dependency', 'externality'];
const ALL_STATUSES: FeatureStatus[] = ['draft', 'active', 'deprecated', 'removed', 'orphaned'];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_COLORS: Record<string, string> = {
  GET: '#16a34a',
  POST: '#2563eb',
  PUT: '#d97706',
  PATCH: '#7c3aed',
  DELETE: '#dc2626',
  HEAD: '#6b7280',
  OPTIONS: '#6b7280',
};

function extractMethod(title: string): { method: string; path: string } | null {
  const upper = title.toUpperCase();
  for (const m of HTTP_METHODS) {
    if (upper.startsWith(m + ' ')) {
      return { method: m, path: title.slice(m.length + 1) };
    }
  }
  return null;
}

export const FeatureCard: React.FC<FeatureCardProps> = ({
  feature,
  isExpanded,
  onToggle,
  onScrollTo,
  compact = false,
}) => {
  const updateFeature = useAnnotationStore((s) => s.updateFeature);
  const deleteFeature = useAnnotationStore((s) => s.deleteFeature);
  const addComment = useAnnotationStore((s) => s.addComment);
  const updateComment = useAnnotationStore((s) => s.updateComment);
  const deleteComment = useAnnotationStore((s) => s.deleteComment);
  const fetchCommentsForFeature = useAnnotationStore((s) => s.fetchCommentsForFeature);
  const featureComments = useAnnotationStore((s) => s.getCommentsForFeature(feature.id));
  // Local refs state so the card header updates immediately after modal operations,
  // without depending on the parent view re-rendering with new props.
  const [cardRefs, setCardRefs] = useState(feature.refs ?? []);
  const refs = cardRefs;

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [managingRefs, setManagingRefs] = useState(false);
  const [managingRefsCommentId, setManagingRefsCommentId] = useState<string | null>(null);

  // Comment state
  const [replyText, setReplyText] = useState('');
  const [submittingReply, setSubmittingReply] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentText, setEditCommentText] = useState('');
  const [showAllComments, setShowAllComments] = useState(false);

  // Edit state
  const [title, setTitle] = useState(feature.title);
  const [description, setDescription] = useState(feature.description ?? '');
  const [kind, setKind] = useState<FeatureKind>(feature.kind);
  const [status, setStatus] = useState<FeatureStatus>(feature.status);
  const [operation, setOperation] = useState(feature.operation ?? '');
  const [direction, setDirection] = useState(feature.direction ?? '');
  const [protocol, setProtocol] = useState(feature.protocol ?? '');
  const [tagsInput, setTagsInput] = useState((feature.tags ?? []).join(', '));
  const [source, setSource] = useState(feature.source ?? '');
  const [anchorFileId, setAnchorFileId] = useState(feature.anchor.fileId ?? '');
  const [anchorLineStart, setAnchorLineStart] = useState(feature.anchor.lineRange?.start?.toString() ?? '');
  const [anchorLineEnd, setAnchorLineEnd] = useState(feature.anchor.lineRange?.end?.toString() ?? '');
  const [editParams, setEditParams] = useState<Array<{id?: string; name: string; type: string; required: boolean; description: string; pattern: string}>>(
    (feature.parameters ?? []).map((p) => ({ id: p.id, name: p.name, type: p.type ?? '', required: p.required, description: p.description ?? '', pattern: p.pattern ?? '' })),
  );

  const fp = feature as Feature & { effectiveAnchor?: { fileId?: string; commitId?: string; lineRange?: { start: number; end: number } }; confidence?: string };
  const lineRange = fp.effectiveAnchor?.lineRange ?? feature.anchor.lineRange;
  const confidence = fp.confidence;
  const isOrphaned = feature.status === 'orphaned' || confidence === 'orphaned';

  const [fileLines, setFileLines] = useState<{ lines: string[]; lang: string } | null>(null);
  const [extraBefore, setExtraBefore] = useState(0);
  const [extraAfter, setExtraAfter] = useState(0);

  useEffect(() => {
    if (!isExpanded || !lineRange || !feature.anchor.fileId) { setFileLines(null); return; }
    const commitId = fp.effectiveAnchor?.commitId ?? feature.anchor.commitId;
    if (!commitId) return;
    const lang = detectLanguage(feature.anchor.fileId) ?? '';
    let cancelled = false;
    setExtraBefore(0);
    setExtraAfter(0);
    gitApi.getFileContent(commitId, feature.anchor.fileId)
      .then(async ({ content }) => {
        if (lang) await ensureLanguageRegistered(lang);
        if (cancelled) return;
        setFileLines({ lines: content.split('\n'), lang });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isExpanded, lineRange?.start, lineRange?.end, feature.anchor.fileId, feature.anchor.commitId]);

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

  // Fetch comments when expanded
  useEffect(() => {
    if (isExpanded) {
      fetchCommentsForFeature(feature.id);
    }
  }, [isExpanded, feature.id, fetchCommentsForFeature]);

  const sortedComments = useMemo(
    () => [...featureComments].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [featureComments],
  );

  const handleSubmitReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    setSubmittingReply(true);
    addComment({
      id: `CMT-${Date.now()}`,
      anchor: { ...feature.anchor },
      author: 'you',
      text: trimmed,
      timestamp: new Date().toISOString(),
      threadId: `T-${feature.id}`,
      featureId: feature.id,
    });
    setReplyText('');
    setSubmittingReply(false);
  };

  const handleSave = () => {
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    const startNum = parseInt(anchorLineStart, 10);
    const endNum = parseInt(anchorLineEnd, 10);
    const parameters: FeatureParameter[] = editParams
      .filter((p) => p.name.trim())
      .map((p) => ({
        id: p.id ?? '',
        featureId: feature.id,
        name: p.name.trim(),
        type: p.type || undefined,
        required: p.required,
        description: p.description.trim() || undefined,
        pattern: p.pattern.trim() || undefined,
      } as FeatureParameter));
    const updates: Record<string, unknown> = { title, description, kind, status, operation: operation || undefined, direction: (direction || undefined) as 'in' | 'out' | undefined, protocol: protocol || undefined, tags, source: source || undefined, parameters };
    if (anchorFileId.trim()) updates['file_id'] = anchorFileId.trim();
    if (startNum > 0 && endNum > 0) { updates['line_start'] = startNum; updates['line_end'] = endNum; }
    updateFeature(feature.id, updates as unknown as Partial<Feature>);
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setTitle(feature.title);
    setDescription(feature.description ?? '');
    setKind(feature.kind);
    setStatus(feature.status);
    setOperation(feature.operation ?? '');
    setDirection(feature.direction ?? '');
    setProtocol(feature.protocol ?? '');
    setTagsInput((feature.tags ?? []).join(', '));
    setSource(feature.source ?? '');
    setAnchorFileId(feature.anchor.fileId ?? '');
    setAnchorLineStart(feature.anchor.lineRange?.start?.toString() ?? '');
    setAnchorLineEnd(feature.anchor.lineRange?.end?.toString() ?? '');
    setEditParams((feature.parameters ?? []).map((p) => ({ id: p.id, name: p.name, type: p.type ?? '', required: p.required, description: p.description ?? '', pattern: p.pattern ?? '' })));
    setEditing(false);
  };

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
    setConfirmDelete(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) { setConfirmDelete(true); return; }
    deleteFeature(feature.id);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const handleCommitClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!feature.anchor.commitId) return;
    useRepoStore.getState().selectCommit(feature.anchor.commitId);
    useUIStore.getState().setViewMode('browse');
    if (feature.anchor.fileId) useRepoStore.getState().selectFile(feature.anchor.fileId);
  };

  const kindColor = KIND_COLORS[feature.kind] ?? '#6b7280';

  const headerRight = (
    <div className="comment-card-header-right feature-header-right" onClick={(e) => e.stopPropagation()}>
      {!compact && feature.direction && (
        <span className={`feature-direction-badge feature-direction-badge--${feature.direction}`}>
          {feature.direction === 'in' ? '← IN' : '→ OUT'}
        </span>
      )}
      <span className={`feature-status-badge feature-status-badge--${feature.status}`}>
        {STATUS_LABELS[feature.status] ?? feature.status}
      </span>
      <button
        className="comment-icon-btn"
        onClick={(e) => { e.stopPropagation(); setManagingRefs(true); }}
        title="Manage web links"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 10L10 2M10 2H5M10 2v5"/>
        </svg>
      </button>
      <button className="comment-icon-btn" onClick={handleStartEdit} title="Edit">&#x270E;</button>
      {!confirmDelete ? (
        <button className="comment-icon-btn comment-icon-btn-danger" onClick={handleDelete} title="Delete">&#x2715;</button>
      ) : (
        <span className="finding-delete-confirm">
          <button className="finding-delete-yes" onClick={handleDelete}>Delete</button>
          <button className="finding-delete-no" onClick={handleCancelDelete}>No</button>
        </span>
      )}
    </div>
  );

  const kindBadge = feature.kind === 'interface' ? (() => {
    const op = feature.operation?.toUpperCase();
    const parsed = op ? null : extractMethod(feature.title);
    const method = op ?? parsed?.method;
    return method ? (
      <span className="feature-method-badge" style={{ background: METHOD_COLORS[method] ?? kindColor }}>{method}</span>
    ) : (
      <span className="feature-kind-badge" style={{ background: kindColor }}>{KIND_LABELS[feature.kind]}</span>
    );
  })() : (
    <span className="feature-kind-badge" style={{ background: kindColor }}>
      {KIND_LABELS[feature.kind as FeatureKind] ?? feature.kind}
    </span>
  );

  const titleEl = feature.kind === 'interface' ? (() => {
    const op = feature.operation?.toUpperCase();
    const parsed = op ? null : extractMethod(feature.title);
    const method = op ?? parsed?.method;
    const displayTitle = method ? (op ? feature.title : parsed?.path ?? feature.title) : feature.title;
    return <code className="feature-endpoint-path">{displayTitle}</code>;
  })() : (
    <span className="feature-title">{feature.title}</span>
  );

  return (
    <div className={`feature-card${isExpanded ? ' feature-card-expanded' : ''}${isOrphaned ? ' feature-card-orphaned' : ''}`}>

      {/* Collapsed header */}
      {!isExpanded && (
        <div className="feature-card-header" onClick={onToggle}>
          <div className="feature-card-header-top">
            <span className="feature-expand-chevron">&#9658;</span>
            {kindBadge}
            {titleEl}
            {!compact && feature.protocol && <span className="feature-chip">{feature.protocol}</span>}
            {!compact && feature.kind === 'interface' && feature.parameters && feature.parameters.length > 0 && (
              <span className="feature-params-badge">{feature.parameters.length} params</span>
            )}
            {headerRight}
          </div>
          {feature.description && (
            <p className="feature-description feature-description-collapsed">{feature.description}</p>
          )}
        </div>
      )}

      {/* Expanded header */}
      {isExpanded && (
        <div className="feature-card-header" onClick={onToggle}>
          <div className="feature-card-header-top">
            <span className="feature-expand-chevron feature-expand-chevron--open">&#9658;</span>
            {kindBadge}
            {titleEl}
            {!compact && feature.protocol && <span className="feature-chip">{feature.protocol}</span>}
            {headerRight}
          </div>
        </div>
      )}

      {(refs.length > 0 || (confidence && confidence !== 'exact')) && (
        <div className="finding-card-meta">
          {refs.length > 0 && (
            <span className="ref-icons" onClick={(e) => e.stopPropagation()}>
              <span className="ref-icons-label">Links</span>
              {refs.map((ref) => (
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
          {confidence && confidence !== 'exact' && (
            <span className={`finding-confidence finding-confidence-${confidence}`}>
              {confidence === 'moved' ? 'Moved' : 'Orphaned'}
            </span>
          )}
        </div>
      )}

      {isExpanded && (
        <div className="feature-card-body">
          {!editing ? (
            <>
              {feature.description && (
                <div className="feature-description">
                  {feature.description}
                </div>
              )}

              {feature.tags && feature.tags.length > 0 && (
                <div className="feature-meta-row" style={{ marginBottom: 4 }}>
                  {feature.tags.map((tag) => (
                    <span key={tag} className="feature-tag-pill">{tag}</span>
                  ))}
                </div>
              )}

              {feature.kind === 'interface' && feature.parameters && feature.parameters.length > 0 && (
                <div className="feature-params-section">
                  <div className="feature-params-heading">Parameters</div>
                  <div className="feature-params-list">
                    {feature.parameters.map((p) => (
                      <div key={p.id} className="feature-param-row">
                        <span className="feature-param-field">
                          <span className="feature-param-label">Name</span>
                          <span className="feature-param-name">{p.name}</span>
                        </span>
                        <span className="feature-param-field">
                          <span className="feature-param-label">Type</span>
                          {p.type ? (
                            <span className="feature-param-type-badge" style={{ color: PARAM_TYPE_COLORS[p.type] ?? 'var(--text-muted)', borderColor: `color-mix(in srgb, ${PARAM_TYPE_COLORS[p.type] ?? 'var(--text-muted)'} 30%, transparent)`, background: `color-mix(in srgb, ${PARAM_TYPE_COLORS[p.type] ?? 'var(--text-muted)'} 10%, transparent)` }}>{p.type}</span>
                          ) : <span className="feature-param-empty">—</span>}
                        </span>
                        <span className="feature-param-field">
                          <span className="feature-param-label">Required</span>
                          <span className={`feature-param-required-val${p.required ? ' feature-param-required-val--yes' : ''}`}>{p.required ? 'true' : 'false'}</span>
                        </span>
                        <span className="feature-param-field feature-param-field--desc">
                          <span className="feature-param-label">Description</span>
                          {p.description ? <span className="feature-param-desc">{p.description}</span> : <span className="feature-param-empty">—</span>}
                        </span>
                        <span className="feature-param-field">
                          <span className="feature-param-label">Pattern</span>
                          {p.pattern ? <span className="feature-params-pattern">{p.pattern}</span> : <span className="feature-param-empty">—</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {snippet && lineRange && (
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
            </>
          ) : (
            <div className="finding-edit-form">
              <div className="finding-form-row">
                <input
                  className="finding-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Title"
                />
              </div>
              <div className="finding-form-row">
                <textarea
                  className="finding-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description"
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
              </div>
              <div className="finding-form-row" style={{ display: 'flex', gap: 6 }}>
                <select className="finding-edit-select" value={kind} onChange={(e) => setKind(e.target.value as FeatureKind)}>
                  {ALL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select>
                <select className="finding-edit-select" value={status} onChange={(e) => setStatus(e.target.value as FeatureStatus)}>
                  {ALL_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </select>
              </div>
              {(kind === 'interface') && (
                <div className="finding-form-row">
                  <input
                    className="finding-input"
                    value={operation}
                    onChange={(e) => setOperation(e.target.value)}
                    placeholder="Operation (GET, POST, query, rpc GetUser…)"
                  />
                </div>
              )}
              <div className="finding-form-row" style={{ display: 'flex', gap: 6 }}>
                <input
                  className="finding-input"
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value)}
                  placeholder="Protocol (rest, grpc, ...)"
                  style={{ flex: 1 }}
                />
                <select className="finding-edit-select" value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="">Direction</option>
                  <option value="in">in</option>
                  <option value="out">out</option>
                </select>
              </div>
              {kind === 'interface' && (
                <div className="feature-params-edit-section">
                  <div className="feature-params-edit-header">
                    <span className="feature-params-heading">Parameters</span>
                    <button
                      type="button"
                      className="feature-params-add-row"
                      onClick={() => setEditParams((ps) => [...ps, { name: '', type: '', required: false, description: '', pattern: '' }])}
                    >+ Add parameter</button>
                  </div>
                  {editParams.map((p, i) => (
                    <div key={i} className="feature-params-edit-row">
                      <input
                        className="finding-input feature-params-input-name"
                        value={p.name}
                        onChange={(e) => setEditParams((ps) => ps.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="Name"
                      />
                      <select
                        className="finding-edit-select feature-params-input-type"
                        value={p.type}
                        onChange={(e) => setEditParams((ps) => ps.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}
                      >
                        <option value="">type</option>
                        {['string', 'integer', 'boolean', 'object', 'array', 'file'].map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <label className="feature-params-req-label" title="Required">
                        <input
                          type="checkbox"
                          checked={p.required}
                          onChange={(e) => setEditParams((ps) => ps.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))}
                        />
                        req
                      </label>
                      <input
                        className="finding-input feature-params-input-desc"
                        value={p.description}
                        onChange={(e) => setEditParams((ps) => ps.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                        placeholder="Description"
                      />
                      <input
                        className="finding-input feature-params-input-pattern"
                        value={p.pattern}
                        onChange={(e) => setEditParams((ps) => ps.map((x, j) => j === i ? { ...x, pattern: e.target.value } : x))}
                        placeholder="pattern / constraint"
                      />
                      <button
                        type="button"
                        className="comment-icon-btn comment-icon-btn-danger"
                        onClick={() => setEditParams((ps) => ps.filter((_, j) => j !== i))}
                        title="Remove"
                      >&#x2715;</button>
                    </div>
                  ))}
                </div>
              )}

              <div className="finding-form-row">
                <input
                  className="finding-input"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder="Tags (comma-separated)"
                />
              </div>
              <div className="finding-form-row">
                <input
                  className="finding-input"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Source (e.g. manual, semgrep)"
                />
              </div>
              <div className="finding-form-row">
                <input
                  className="finding-input"
                  value={anchorFileId}
                  onChange={(e) => setAnchorFileId(e.target.value)}
                  placeholder="Anchor file path"
                />
              </div>
              <div className="finding-form-row" style={{ display: 'flex', gap: 6 }}>
                <input
                  className="finding-input"
                  type="number"
                  min="1"
                  value={anchorLineStart}
                  onChange={(e) => setAnchorLineStart(e.target.value)}
                  placeholder="Line start"
                  style={{ flex: 1 }}
                />
                <input
                  className="finding-input"
                  type="number"
                  min="1"
                  value={anchorLineEnd}
                  onChange={(e) => setAnchorLineEnd(e.target.value)}
                  placeholder="Line end"
                  style={{ flex: 1 }}
                />
              </div>
              <div className="finding-edit-actions">
                <button className="finding-edit-save" onClick={handleSave}>Save</button>
                <button className="finding-edit-cancel" onClick={handleCancelEdit}>Cancel</button>
              </div>
            </div>
          )}

          <div className="finding-comments" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const hiddenCount = sortedComments.length > 1 && !showAllComments ? sortedComments.length - 1 : 0;
              const visibleComments = hiddenCount > 0 ? sortedComments.slice(-1) : sortedComments;

              const renderComment = (c: typeof sortedComments[0]) => (
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
                    <button className="finding-comments-toggle" onClick={() => setShowAllComments(true)}>
                      {hiddenCount} previous {hiddenCount === 1 ? 'comment' : 'comments'}
                    </button>
                  )}
                  {showAllComments && sortedComments.length > 1 && (
                    <button className="finding-comments-toggle" onClick={() => setShowAllComments(false)}>
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
                onChange={(e) => setReplyText(e.target.value)}
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
        </div>
      )}

      {managingRefs && createPortal(
        <RefManageModal
          entityType="feature"
          entityId={feature.id}
          refs={refs}
          onClose={() => setManagingRefs(false)}
          onRefsChange={setCardRefs}
        />,
        document.body
      )}

      {managingRefsCommentId && createPortal(
        <RefManageModal
          entityType="comment"
          entityId={managingRefsCommentId}
          refs={featureComments.find((c) => c.id === managingRefsCommentId)?.refs ?? []}
          onClose={() => setManagingRefsCommentId(null)}
        />,
        document.body
      )}

      <div className="overview-card-meta">
        {feature.anchor.fileId && (
          <span className="overview-comment-file" title={feature.anchor.fileId} onClick={(e) => { e.stopPropagation(); onScrollTo?.(); }}>
            {feature.anchor.fileId.split('/').pop()}
            {lineRange && `:${lineRange.start}${lineRange.end !== lineRange.start ? `-${lineRange.end}` : ''}`}
          </span>
        )}
        <span className="overview-card-meta-right">
          {feature.anchor.commitId && (
            <span className="overview-commit-ref overview-commit-link" onClick={handleCommitClick}>
              {feature.anchor.commitId.slice(0, 7)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
};
