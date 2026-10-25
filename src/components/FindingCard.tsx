import React, { useState, useMemo, useEffect, useRef } from 'react';
import { buttonProps } from '../core/a11y';
import { createPortal } from 'react-dom';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { useReconcileStore } from '../stores/reconcile-store';
import type { Finding, Feature, FindingStatus } from '../core/types';
import { getEffectiveLineRange, getConfidence } from '../core/types';
import { featuresApi } from '../core/api';
import { InlineMarkdown } from '../core/markdown';
import { useBranchMap } from '../core/use-branch-map';
import { useSnippetState } from '../core/use-snippet-state';
import { gitApi } from '../core/api';
import { detectLanguage, ensureLanguageRegistered } from '../core/language-map';
import { highlight, renderToken } from '../core/tokenizer';
import { RefProviderIcon } from './RefProviderIcon';
import { LinkManageModal } from './LinkManageModal';
import { CommentThread } from './CommentThread';
import { SelectDropdown, ToneChip } from './SelectDropdown';
import { SEVERITY_OPTIONS, FINDING_STATUS_OPTIONS, METHOD_COLORS } from '../core/status-options';
import { OriginHover, originHasContent } from './origin';
import { useLinkedFeatures, useOpenRef } from '../core/cross-refs';

interface FindingCardProps {
  finding: Finding;
  isExpanded: boolean;
  isFocused?: boolean;
  isNavFocused?: boolean;
  expandSnippetsTick?: number;
  collapseSnippetsTick?: number;
  onSnippetCollapsedChange?: (collapsed: boolean) => void;
  onToggle: () => void;
  onScrollTo: () => void;
  /** Set when the finding isn't on the review branch: that branch's name. */
  notOnBranch?: string;
}

const NO_IDS: string[] = [];

const KIND_COLORS: Record<string, string> = {
  interface:   'var(--kind-interface)',
  source:      'var(--kind-source)',
  sink:        'var(--kind-sink)',
  dependency:  'var(--kind-dependency)',
  externality: 'var(--kind-externality)',
};

const KIND_LABELS: Record<string, string> = {
  interface:   'Interface',
  source:      'Source',
  sink:        'Sink',
  dependency:  'Dependency',
  externality: 'Externality',
};


export const FindingCard: React.FC<FindingCardProps> = ({
  finding,
  isExpanded,
  isFocused,
  isNavFocused,
  expandSnippetsTick,
  collapseSnippetsTick,
  onSnippetCollapsedChange,
  onToggle,
  onScrollTo,
  notOnBranch,
}) => {
  const updateFinding = useAnnotationStore((s) => s.updateFinding);
  const deleteFinding = useAnnotationStore((s) => s.deleteFinding);
  const fetchCommentsForFinding = useAnnotationStore((s) => s.fetchCommentsForFinding);
  const findingComments = useAnnotationStore((s) => s.getCommentsForFinding(finding.id));
  const allFeatures = useAnnotationStore((s) => s.features);
  const viewMode = useUIStore((s) => s.viewMode);
  const reconciledHead = useReconcileStore((s) => s.head);
  const gitHead = reconciledHead?.gitHead ?? null;

  const branchMap = useBranchMap();

  // Local refs so the meta row updates immediately after modal operations
  const [cardRefs, setCardRefs] = useState(finding.refs ?? []);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [managingRefs, setManagingRefs] = useState(false);

  // Comment state - consume draft carried from another view (e.g. Overview → Browse)
  const draftComment = useUIStore((s) => s.draftComment);
  const setDraftComment = useUIStore((s) => s.setDraftComment);
  const consumedDraft = draftComment?.findingId === finding.id ? draftComment.text : '';

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


  const lineRange = getEffectiveLineRange(finding);
  const confidence = getConfidence(finding);

  const fileId = finding.anchor.fileId;

  // Snippet state
  const [fileLines, setFileLines] = useState<{ lines: string[]; lang: string } | null>(null);
  const { collapsed: snippetCollapsed, setCollapsed: setSnippetCollapsed, extraBefore, setExtraBefore, extraAfter, setExtraAfter } = useSnippetState(finding.id);

  const seenExpandTick = useRef(expandSnippetsTick ?? 0);
  const seenCollapseTick = useRef(collapseSnippetsTick ?? 0);
  useEffect(() => {
    if ((expandSnippetsTick ?? 0) > seenExpandTick.current) {
      seenExpandTick.current = expandSnippetsTick ?? 0;
      setSnippetCollapsed(false);
    }
  }, [expandSnippetsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ((collapseSnippetsTick ?? 0) > seenCollapseTick.current) {
      seenCollapseTick.current = collapseSnippetsTick ?? 0;
      setSnippetCollapsed(true);
    }
  }, [collapseSnippetsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onSnippetCollapsedChange?.(snippetCollapsed);
  }, [snippetCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // This project's features, and other projects' (a "<project>:<id>" reference) resolved by the host.
  const linkedFeatures = useLinkedFeatures(finding.features ?? NO_IDS, fetchedFeatures ?? allFeatures);
  const openRef = useOpenRef();

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

  return (
    <div
      className={`finding-card ${isExpanded ? 'finding-card-expanded' : ''} ${isFocused ? 'finding-card-focused' : ''}`}
    >
      <div className="finding-card-header" onClick={onToggle}>
        <div className="finding-card-header-top">
          <ToneChip label={SEVERITY_OPTIONS.find((o) => o.value === finding.severity)?.label ?? finding.severity}
            tone={SEVERITY_OPTIONS.find((o) => o.value === finding.severity)?.tone} title="Severity" />
          <span className={`finding-id-badge${idCopied ? ' finding-id-copied' : ''}`} title="Copy ID" {...buttonProps((e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(finding.id).catch(() => {});
            setIdCopied(true);
            setTimeout(() => setIdCopied(false), 1200);
          }, 'Copy finding ID')}>
            {idCopied ? 'Copied!' : finding.id.slice(0, 8)}
            {!idCopied && <span className="finding-id-copy">&#x2398;</span>}
          </span>
          <ToneChip label={finding.source} title="Source" />
          {notOnBranch && <ToneChip label={`Not on ${notOnBranch}`} title={`Anchored on a commit that isn't in ${notOnBranch}'s history`} />}
          <SelectDropdown<FindingStatus> appearance="tinted" size="sm" label="Status" className="finding-status-control"
            options={FINDING_STATUS_OPTIONS} value={finding.status}
            onChange={(status) => updateFinding(finding.id, { status })}
            tabIndex={isExpanded ? 0 : -1} />
          <div className="comment-card-header-right">
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
          <span
            className="finding-title finding-title-link"
            onClick={(e) => {
              e.stopPropagation();
              window.location.hash = `#/finding/${finding.id}`;
            }}
            title="Open finding"
          >{finding.title}</span>
          {originHasContent(finding.origin) && <OriginHover origin={finding.origin} />}
        </div>
        {!isExpanded && finding.description && (
          <p className="finding-description feature-description-collapsed"><InlineMarkdown text={finding.description} /></p>
        )}
      </div>

      <div className="finding-card-meta">
        {finding.cve && <span className="finding-cve">{finding.cve}</span>}
        {finding.score > 0 && <span className="finding-score">{finding.score.toFixed(1)}</span>}
        {finding.vector && <span className="finding-vector" title={finding.vector}>{finding.vector}</span>}
        {confidence && confidence !== 'exact' && (
          <span className={`finding-confidence finding-confidence-${confidence}`}>
            {confidence === 'moved' ? 'Moved' : 'Orphaned'}
          </span>
        )}
      </div>

      {isExpanded && (
        <div className="finding-card-body">
          <p className="finding-description"><InlineMarkdown text={finding.description} /></p>

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
        </div>
      )}

      {(cardRefs.length > 0 || linkedFeatures.length > 0) && (
        <div className="feature-links-row feature-links-row-inline" onClick={(e) => e.stopPropagation()}>
          <span className="feature-params-heading feature-links-heading-inline">Links<span className="section-count-badge">{cardRefs.length + linkedFeatures.length}</span></span>
          {cardRefs.map((ref) => (
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
          {linkedFeatures.map((feat) => {
            const fKindColor = KIND_COLORS[feat.kind] ?? 'var(--kind-externality)';
            const isInterface = feat.kind === 'interface';
            const method = feat.operation?.toUpperCase();
            const filename = feat.anchor.fileId?.split('/').pop();
            const tooltipParts = [feat.description, filename ? `(${filename})` : null].filter(Boolean);
            return (
              <button
                key={feat.id}
                type="button"
                className="feature-linked-badge"
                title={tooltipParts.join(' ')}
                onClick={(e) => {
                  e.stopPropagation();
                  openRef(feat.id, 'feature');
                }}
              >
                {feat.projectName && <span className="feature-linked-badge-project">{feat.projectName}</span>}
                {isInterface && method ? (
                  <span className="feature-method-badge" style={{ background: METHOD_COLORS[method] ?? fKindColor, fontSize: 9 }}>{method}</span>
                ) : (
                  <span className="feature-kind-badge" style={{ background: fKindColor, fontSize: 9 }}>{KIND_LABELS[feat.kind] ?? feat.kind}</span>
                )}
                {isInterface ? (
                  <code className="feature-linked-badge-title feature-endpoint-path">{feat.title}</code>
                ) : (
                  <span className="feature-linked-badge-title">{feat.title}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {isExpanded && (
        <CommentThread
          comments={findingComments}
          target={{ anchor: finding.anchor, findingId: finding.id }}
          collapse
          heading
          placeholder={isNavFocused ? 'Reply... (⏎)' : 'Reply...'}
          initialReply={consumedDraft}
          onReplyChange={(text) => setDraftComment(text.trim() ? { text, findingId: finding.id } : null)}
        />
      )}

      {managingRefs && createPortal(
        <LinkManageModal
          entityType="finding"
          entityId={finding.id}
          refs={cardRefs}
          linkedFeatureIds={finding.features ?? []}
          allFeatures={allFeatures}
          onClose={() => setManagingRefs(false)}
          onRefsChange={setCardRefs}
        />,
        document.body
      )}

      <div className="overview-card-meta">
        {fileId && (
          <span className="overview-comment-file" title={fileId} {...buttonProps((e) => { e.stopPropagation(); onScrollTo(); }, `Go to ${fileId}`)}>
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
