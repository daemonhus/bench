import React, { useState, useEffect, useRef, useMemo } from 'react';
import { buttonProps } from '../core/a11y';
import { createPortal } from 'react-dom';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { gitApi } from '../core/api';
import { useSnippetState } from '../core/use-snippet-state';
import { detectLanguage, ensureLanguageRegistered } from '../core/language-map';
import { highlight, renderToken } from '../core/tokenizer';
import { InlineMarkdown } from '../core/markdown';
import type { Feature, FeatureKind, FeatureStatus } from '../core/types';
import { RefProviderIcon } from './RefProviderIcon';
import { CommentThread } from './CommentThread';
import { SelectDropdown } from './SelectDropdown';
import { FEATURE_STATUS_OPTIONS, METHOD_COLORS, HTTP_METHODS } from '../core/status-options';
import { LinkManageModal } from './LinkManageModal';
import { OriginHover, originHasContent } from './origin';
import { useLinkedFeatures, useOpenRef } from '../core/cross-refs';

interface FeatureCardProps {
  feature: Feature;
  /** Open findings linked to this feature (renders a filtered-findings link). */
  openFindingsCount?: number;
  isExpanded: boolean;
  isNavFocused?: boolean;
  expandSnippetsTick?: number;
  collapseSnippetsTick?: number;
  onSnippetCollapsedChange?: (collapsed: boolean) => void;
  onToggle: () => void;
  onScrollTo?: () => void;
  compact?: boolean;
  allFeatures?: Feature[];
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

// Values resolve from tokens.css so theme retunes propagate; safe anywhere
// CSS is parsed (inline style, SVG presentation attributes).
export const KIND_COLORS: Record<FeatureKind, string> = {
  interface:   'var(--kind-interface)',
  source:      'var(--kind-source)',
  sink:        'var(--kind-sink)',
  dependency:  'var(--kind-dependency)',
  externality: 'var(--kind-externality)',
};

const KIND_LABELS: Record<FeatureKind, string> = {
  interface:   'Interface',
  source:      'Source',
  sink:        'Sink',
  dependency:  'Dependency',
  externality: 'Externality',
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
  openFindingsCount,
  isExpanded,
  isNavFocused,
  expandSnippetsTick,
  collapseSnippetsTick,
  onSnippetCollapsedChange,
  onToggle,
  onScrollTo,
  compact = false,
  allFeatures: allFeaturesProp,
}) => {
  const storeFeatures = useAnnotationStore((s) => s.features);
  const allFeatures = allFeaturesProp ?? storeFeatures;
  // Linked features: this project's, and other projects' ("<project>:<id>") resolved by the host.
  const linkIds = useMemo(() => (feature.linkedFeatures ?? []).map((lf) => lf.id), [feature.linkedFeatures]);
  const linkedViews = useLinkedFeatures(linkIds, allFeatures);
  const openRef = useOpenRef();
  const viewMode = useUIStore((s) => s.viewMode);
  const deleteFeature = useAnnotationStore((s) => s.deleteFeature);
  const updateFeature = useAnnotationStore((s) => s.updateFeature);
  const fetchCommentsForFeature = useAnnotationStore((s) => s.fetchCommentsForFeature);
  const featureComments = useAnnotationStore((s) => s.getCommentsForFeature(feature.id));
  // Local refs state so the card header updates immediately after modal operations,
  // without depending on the parent view re-rendering with new props.
  const [cardRefs, setCardRefs] = useState(feature.refs ?? []);
  const refs = cardRefs;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [managingRefs, setManagingRefs] = useState(false);

  // Comment state

  const fp = feature as Feature & { effectiveAnchor?: { fileId?: string; commitId?: string; lineRange?: { start: number; end: number } }; confidence?: string };
  const lineRange = fp.effectiveAnchor?.lineRange ?? feature.anchor.lineRange;
  const confidence = fp.confidence;
  const isOrphaned = feature.status === 'orphaned' || confidence === 'orphaned';

  const [fileLines, setFileLines] = useState<{ lines: string[]; lang: string } | null>(null);
  const { collapsed: snippetCollapsed, setCollapsed: setSnippetCollapsed, extraBefore, setExtraBefore, extraAfter, setExtraAfter } = useSnippetState(feature.id);
  const [paramsCollapsed, setParamsCollapsed] = useState(false);

  const seenExpandTick = useRef(expandSnippetsTick ?? 0);
  const seenCollapseTick = useRef(collapseSnippetsTick ?? 0);
  useEffect(() => {
    if ((expandSnippetsTick ?? 0) > seenExpandTick.current) {
      seenExpandTick.current = expandSnippetsTick ?? 0;
      setSnippetCollapsed(false);
      setParamsCollapsed(false);
    }
  }, [expandSnippetsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((collapseSnippetsTick ?? 0) > seenCollapseTick.current) {
      seenCollapseTick.current = collapseSnippetsTick ?? 0;
      setSnippetCollapsed(true);
      setParamsCollapsed(true);
    }
  }, [collapseSnippetsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onSnippetCollapsedChange?.(snippetCollapsed);
  }, [snippetCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const MAX_RANGE_LINES = 5;
    // Cap displayed range so long annotations don't balloon the card. The
    // "N more" button still extends via extraAfter.
    const cappedRangeEnd = Math.min(lineRange.end, lineRange.start + MAX_RANGE_LINES - 1);
    const from = Math.max(0, lineRange.start - 1 - CONTEXT - extraBefore);
    const to = Math.min(fileLines.lines.length, cappedRangeEnd + CONTEXT + extraAfter);
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


  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) { setConfirmDelete(true); return; }
    deleteFeature(feature.id);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  const handleCommitClick = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    if (!feature.anchor.commitId) return;
    useRepoStore.getState().selectCommit(feature.anchor.commitId);
    useUIStore.getState().setViewMode('browse');
    if (feature.anchor.fileId) useRepoStore.getState().selectFile(feature.anchor.fileId);
  };

  const kindColor = KIND_COLORS[feature.kind] ?? 'var(--kind-externality)';

  const headerRight = (
    <div className="comment-card-header-right feature-header-right" onClick={(e) => e.stopPropagation()}>
      {(openFindingsCount ?? 0) > 0 && (
        <a
          className="feature-open-findings-link"
          href={`#/findings/feature/${feature.id}`}
          data-tooltip="View these findings"
        >
          {openFindingsCount} open finding{openFindingsCount === 1 ? '' : 's'}
        </a>
      )}
      {!compact && feature.direction && (
        <span className={`feature-direction-badge feature-direction-badge--${feature.direction}`}>
          {feature.direction === 'in' ? '← IN' : '→ OUT'}
        </span>
      )}
      <SelectDropdown<FeatureStatus> appearance="tinted" size="sm" label="Status" className="feature-status-control"
        options={FEATURE_STATUS_OPTIONS} value={feature.status}
        onChange={(status) => updateFeature(feature.id, { status })} />
      <button
        className="comment-icon-btn"
        onClick={(e) => { e.stopPropagation(); setManagingRefs(true); }}
        title="Manage links"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z"/>
        </svg>
      </button>
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

  // The title is the card's link to the feature's own page.
  const titleNavProps = {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      window.location.hash = `#/feature/${feature.id}`;
    },
    title: 'Open feature',
  };
  const titleEl = feature.kind === 'interface' ? (() => {
    const op = feature.operation?.toUpperCase();
    const parsed = op ? null : extractMethod(feature.title);
    const method = op ?? parsed?.method;
    const displayTitle = method ? (op ? feature.title : parsed?.path ?? feature.title) : feature.title;
    return <code className="feature-endpoint-path feature-title-link" {...titleNavProps}>{displayTitle}</code>;
  })() : (
    <span className="feature-title feature-title-link" {...titleNavProps}>{feature.title}</span>
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
            {originHasContent(feature.origin) && <OriginHover origin={feature.origin} />}
            {!compact && feature.protocol && <span className="feature-chip">{feature.protocol}</span>}
            {!compact && feature.kind === 'interface' && feature.parameters && feature.parameters.length > 0 && (
              <span className="feature-params-badge">{feature.parameters.length} params</span>
            )}
            {headerRight}
          </div>
          {feature.description && (
            <p className="feature-description feature-description-collapsed"><InlineMarkdown text={feature.description} /></p>
          )}
          {!compact && (() => {
            const linked = (feature.linkedFeatures ?? [])
              .map((lf) => ({ lf, feat: linkedViews.find((f) => f.id === lf.id) }))
              .filter((item): item is { lf: NonNullable<typeof item.lf>; feat: NonNullable<typeof item.feat> } => item.feat != null);
            if (refs.length === 0 && linked.length === 0) return null;
            return (
              <div className="feature-links-row feature-links-row-inline" onClick={(e) => e.stopPropagation()}>
                <span className="feature-params-heading feature-links-heading-inline">Links<span className="section-count-badge">{refs.length + linked.length}</span></span>
                {refs.map((ref) => (
                  <a
                    key={ref.id}
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="feature-links-ref-chip"
                    title={ref.title || ref.url}
                  >
                    <RefProviderIcon provider={ref.provider} size={13} />
                    <span>{ref.title || ref.url}</span>
                  </a>
                ))}
                {linked.map(({ lf, feat: f }) => {
                  const fKindColor = KIND_COLORS[f.kind] ?? 'var(--kind-externality)';
                  const isInterface = f.kind === 'interface';
                  const method = f.operation?.toUpperCase();
                  const displayDesc = lf.description || f.description;
                  const filename = f.anchor.fileId?.split('/').pop();
                  const tooltipParts = [displayDesc, filename ? `(${filename})` : null].filter(Boolean);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className="feature-linked-badge"
                      title={tooltipParts.join(' ')}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRef(f.id, 'feature');
                      }}
                    >
                      {f.projectName && <span className="feature-linked-badge-project">{f.projectName}</span>}
                      {isInterface && method ? (
                        <span className="feature-method-badge" style={{ background: METHOD_COLORS[method] ?? fKindColor, fontSize: 9 }}>{method}</span>
                      ) : (
                        <span className="feature-kind-badge" style={{ background: fKindColor, fontSize: 9 }}>{KIND_LABELS[f.kind as FeatureKind] ?? f.kind}</span>
                      )}
                      {isInterface ? (
                        <code className="feature-linked-badge-title feature-endpoint-path">{f.title}</code>
                      ) : (
                        <span className="feature-linked-badge-title">{f.title}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* Expanded header */}
      {isExpanded && (
        <div className="feature-card-header" onClick={onToggle}>
          <div className="feature-card-header-top">
            <span className="feature-expand-chevron feature-expand-chevron--open">&#9658;</span>
            {kindBadge}
            {titleEl}
            {originHasContent(feature.origin) && <OriginHover origin={feature.origin} />}
            {!compact && feature.protocol && <span className="feature-chip">{feature.protocol}</span>}
            {headerRight}
          </div>
        </div>
      )}

      {confidence && confidence !== 'exact' && (
        <div className="finding-card-meta">
          <span className={`finding-confidence finding-confidence-${confidence}`}>
            {confidence === 'moved' ? 'Moved' : 'Orphaned'}
          </span>
        </div>
      )}

      {isExpanded && (
        <div className="feature-card-body">
          <>
              {feature.description && (
                <div className="feature-description">
                  <InlineMarkdown text={feature.description} />
                </div>
              )}

              {feature.tags && feature.tags.length > 0 && (
                <div className="feature-meta-row" style={{ marginBottom: 4 }}>
                  {feature.tags.map((tag) => (
                    <span key={tag} className="feature-tag-pill">{tag}</span>
                  ))}
                </div>
              )}

              {(() => {
                const linked = (feature.linkedFeatures ?? [])
                  .map((lf) => ({ lf, feat: linkedViews.find((f) => f.id === lf.id) }))
                  .filter((item): item is { lf: NonNullable<typeof item.lf>; feat: NonNullable<typeof item.feat> } => item.feat != null);
                if (refs.length === 0 && linked.length === 0) return null;
                return (
                  <div className="feature-links-row feature-links-row-inline" onClick={(e) => e.stopPropagation()}>
                    <span className="feature-params-heading feature-links-heading-inline">Links<span className="section-count-badge">{refs.length + linked.length}</span></span>
                    {refs.map((ref) => (
                        <a
                          key={ref.id}
                          href={ref.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="feature-links-ref-chip"
                          title={ref.title || ref.url}
                        >
                          <RefProviderIcon provider={ref.provider} size={13} />
                          <span>{ref.title || ref.url}</span>
                        </a>
                      ))}
                      {linked.map(({ lf, feat: f }) => {
                        const fKindColor = KIND_COLORS[f.kind] ?? 'var(--kind-externality)';
                        const isInterface = f.kind === 'interface';
                        const method = f.operation?.toUpperCase();
                        const displayDesc = lf.description || f.description;
                        const filename = f.anchor.fileId?.split('/').pop();
                        const tooltipParts = [
                          displayDesc,
                          filename ? `(${filename})` : null,
                        ].filter(Boolean);
                        return (
                          <button
                            key={f.id}
                            type="button"
                            className="feature-linked-badge"
                            title={tooltipParts.join(' ')}
                            onClick={(e) => {
                              e.stopPropagation();
                              openRef(f.id, 'feature');
                            }}
                          >
                            {f.projectName && <span className="feature-linked-badge-project">{f.projectName}</span>}
                            {isInterface && method ? (
                              <span className="feature-method-badge" style={{ background: METHOD_COLORS[method] ?? fKindColor, fontSize: 9 }}>{method}</span>
                            ) : (
                              <span className="feature-kind-badge" style={{ background: fKindColor, fontSize: 9 }}>{KIND_LABELS[f.kind as FeatureKind] ?? f.kind}</span>
                            )}
                            {isInterface ? (
                              <code className="feature-linked-badge-title feature-endpoint-path">{f.title}</code>
                            ) : (
                              <span className="feature-linked-badge-title">{f.title}</span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })()}

              {viewMode === 'features' && feature.kind === 'interface' && feature.parameters && feature.parameters.length > 0 && (
                <div className="feature-params-section">
                  <button
                    type="button"
                    className="feature-params-heading feature-params-heading-toggle"
                    onClick={() => setParamsCollapsed((c) => !c)}
                    aria-expanded={!paramsCollapsed}
                  >
                    <span className="feature-params-heading-caret">{paramsCollapsed ? '▶' : '▼'}</span>
                    Parameters
                    <span className="section-count-badge">{feature.parameters.length}</span>
                  </button>
                  {!paramsCollapsed && (
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
                          ) : <span className="feature-param-empty">-</span>}
                        </span>
                        <span className="feature-param-field">
                          <span className="feature-param-label">Required</span>
                          <span className={`feature-param-required-val${p.required ? ' feature-param-required-val--yes' : ''}`}>{p.required ? 'true' : 'false'}</span>
                        </span>
                        <span className="feature-param-field feature-param-field--desc">
                          <span className="feature-param-label">Description</span>
                          {p.description ? <span className="feature-param-desc"><InlineMarkdown text={p.description} /></span> : <span className="feature-param-empty">-</span>}
                        </span>
                        <span className="feature-param-field">
                          <span className="feature-param-label">Pattern</span>
                          {p.pattern ? <span className="feature-params-pattern">{p.pattern}</span> : <span className="feature-param-empty">-</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                  )}
                </div>
              )}

              {snippet && lineRange && viewMode !== 'browse' && (
                <div className="feature-snippet-section">
                  <button
                    type="button"
                    className="feature-params-heading feature-params-heading-toggle"
                    onClick={() => setSnippetCollapsed((c) => !c)}
                    aria-expanded={!snippetCollapsed}
                  >
                    <span className="feature-params-heading-caret">{snippetCollapsed ? '▶' : '▼'}</span>
                    Code
                  </button>
                  {!snippetCollapsed && (
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
          </>

          <CommentThread
            comments={featureComments}
            target={{ anchor: feature.anchor, featureId: feature.id }}
            collapse
            heading
            placeholder={isNavFocused ? 'Reply... (⏎)' : 'Reply...'}
          />
        </div>
      )}

      {managingRefs && createPortal(
        <LinkManageModal
          entityType="feature"
          entityId={feature.id}
          refs={refs}
          linkedFeatures={feature.linkedFeatures ?? []}
          allFeatures={allFeatures}
          onClose={() => setManagingRefs(false)}
          onRefsChange={setCardRefs}
        />,
        document.body
      )}

      <div className="overview-card-meta">
        {feature.anchor.fileId && (
          <span className="overview-comment-file" title={feature.anchor.fileId} {...buttonProps((e) => { e.stopPropagation(); onScrollTo?.(); }, `Go to ${feature.anchor.fileId}`)}>
            {feature.anchor.fileId.split('/').pop()}
            {lineRange && `:${lineRange.start}${lineRange.end !== lineRange.start ? `-${lineRange.end}` : ''}`}
          </span>
        )}
        <span className="overview-card-meta-right">
          {feature.anchor.commitId && (
            <span className="overview-commit-ref overview-commit-link" {...buttonProps(handleCommitClick, `Open commit ${feature.anchor.commitId.slice(0, 7)}`)}>
              {feature.anchor.commitId.slice(0, 7)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
};
