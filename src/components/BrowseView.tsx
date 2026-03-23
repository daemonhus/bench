import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import { useRepoStore } from '../stores/repo-store';
import { useAnnotationStore } from '../stores/annotation-store';
import { useReconcileStore } from '../stores/reconcile-store';
import { useUIStore } from '../stores/ui-store';
import { useCommentDrag } from '../hooks/useCommentDrag';
import { useBreakpoint, useIsNarrow } from '../hooks/useBreakpoint';
import { highlight, applySearchRanges } from '../core/tokenizer';
import type { DiffChange, Token, Finding } from '../core/types';
import { getEffectiveLineRange } from '../core/types';
import { CodeRow } from './CodeRow';
import { InlineFindingCard } from './InlineFindingCard';
import { SelectionToolbar } from './SelectionToolbar';
import type { FindingBarInfo } from './CodeRow';

function computeFindingBars(findings: Finding[], lineNum: number): FindingBarInfo[] {
  return findings.map((f) => {
    const range = getEffectiveLineRange(f);
    if (!range) return { severity: f.severity, position: 'single' as const };
    if (range.start === range.end) return { severity: f.severity, position: 'single' as const };
    if (lineNum === range.start) return { severity: f.severity, position: 'first' as const };
    if (lineNum === range.end) return { severity: f.severity, position: 'last' as const };
    return { severity: f.severity, position: 'middle' as const };
  });
}

export const BrowseView: React.FC = () => {
  const fileContent = useRepoStore((s) => s.fileContent);
  const fileLanguage = useRepoStore((s) => s.fileLanguage);
  const isLoading = useRepoStore((s) => s.isLoading);

  const getFindingsForLine = useAnnotationStore((s) => s.getFindingsForLine);
  const getCommentsForLine = useAnnotationStore((s) => s.getCommentsForLine);
  const hasReconciliationData = useAnnotationStore((s) => s.hasReconciliationData);
  const isFullyReconciled = useReconcileStore((s) => s.head?.isFullyReconciled ?? false);
  const positionsTrusted = hasReconciliationData || isFullyReconciled;
  const scrollTargetLine = useUIStore((s) => s.scrollTargetLine);
  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);
  const commentDrag = useUIStore((s) => s.commentDrag);
  const annotationAction = useUIStore((s) => s.annotationAction);
  const highlightRange = useUIStore((s) => s.highlightRange);
  const inFileSearch = useUIStore((s) => s.inFileSearch);

  const isMobile = useBreakpoint() === 'mobile';
  const showInlineFindings = useIsNarrow();
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    onIconMouseDown,
    onRowMouseEnter,
    isInRange,
    rangePosition,
  } = useCommentDrag();

  // Split file content into lines and create DiffChange-compatible objects
  const lines: DiffChange[] = useMemo(() => {
    if (!fileContent) return [];
    return fileContent.split('\n').map((content, i) => ({
      id: `B-${i}`,
      type: 'normal' as const,
      content,
      oldLine: i + 1,
      newLine: i + 1,
    }));
  }, [fileContent]);

  // Pre-compute syntax tokens (with optional search highlights)
  const tokenMap = useMemo(() => {
    const map = new Map<string, Token[]>();
    const lang = fileLanguage ?? '';
    for (const line of lines) {
      let tokens = highlight(line.content, lang);
      const lineMatches = inFileSearch?.get(line.newLine ?? 0);
      if (lineMatches && lineMatches.length > 0) {
        tokens = applySearchRanges(tokens, lineMatches);
      }
      map.set(line.id, tokens);
    }
    return map;
  }, [lines, fileLanguage, inFileSearch]);

  // Scroll to target line (retries when content loads via `lines` dep)
  useEffect(() => {
    if (scrollTargetLine === null || !containerRef.current) return;

    const rows = containerRef.current.querySelectorAll('.diff-row');
    let found = false;
    for (const row of rows) {
      const newLine = row.getAttribute('data-new-line');
      if (newLine && parseInt(newLine, 10) === scrollTargetLine) {
        const container = containerRef.current!;
        const el = row as HTMLElement;
        container.scrollTo({
          top: el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2,
          behavior: 'smooth',
        });
        row.classList.add('scroll-highlight');
        setTimeout(() => row.classList.remove('scroll-highlight'), 2000);
        found = true;
        break;
      }
    }

    if (found) setScrollTargetLine(null);
  }, [scrollTargetLine, setScrollTargetLine, lines]);

  const handleActionGutterMouseDown = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId);
      if (!line) return;
      onIconMouseDown(line.newLine ?? 0, 'new');
    },
    [lines, onIconMouseDown],
  );

  const handleActionGutterMouseEnter = useCallback(
    (lineId: string) => {
      const line = lines.find((l) => l.id === lineId);
      if (!line) return;
      onRowMouseEnter(line.newLine ?? 0);
    },
    [lines, onRowMouseEnter],
  );

  if (isLoading) {
    return <div className="empty-state">Loading...</div>;
  }

  if (!fileContent) {
    return <div className="empty-state">Select a file from the tree to begin.</div>;
  }

  const showToolbar = commentDrag.isActive && commentDrag.startLine !== null && annotationAction === null;

  // Compute toolbar position from actual DOM so it tracks the real rendered line height,
  // not a hardcoded constant that drifts over many lines.
  let toolbarTop = 0;
  if (showToolbar && containerRef.current && commentDrag.endLine !== null) {
    const row = containerRef.current.querySelector(`[data-new-line="${commentDrag.endLine}"]`) as HTMLElement | null;
    if (row) toolbarTop = row.offsetTop + row.offsetHeight + 2;
  }

  return (
    <div className="diff-view browse-mode" ref={containerRef} style={{ position: 'relative' }}>
      {showToolbar && (
        <SelectionToolbar startLine={commentDrag.startLine!} endLine={commentDrag.endLine!} top={toolbarTop} />
      )}
      {lines.map((line) => {
        const ln = line.newLine ?? 0;
        const findings = ln > 0 ? getFindingsForLine(ln) : [];
        const tokens = tokenMap.get(line.id) ?? null;
        const inRange = isInRange(ln);
        const rangePos = rangePosition(ln);

        const findingBars = positionsTrusted ? computeFindingBars(findings, ln) : [];
        const hasComments = positionsTrusted && ln > 0 ? getCommentsForLine(ln).length > 0 : false;
        const highlighted = highlightRange !== null && ln >= highlightRange.start && ln <= highlightRange.end;

        // On mobile, inject finding cards after the last line of their range.
        // Uses the raw `findings` from getFindingsForLine (which already falls back
        // to anchor.lineRange without reconciliation), so we don't gate on positionsTrusted.
        const inlineFindings = showInlineFindings
          ? findings.filter((f) => {
              const range = getEffectiveLineRange(f);
              return range ? range.end === ln : true;
            })
          : [];

        return (
          <React.Fragment key={line.id}>
            <CodeRow
              change={line}
              tokens={tokens}
              findings={findings}
              findingBars={findingBars}
              hasComments={hasComments}
              isInCommentRange={inRange}
              isHighlighted={highlighted}
              commentRangePosition={rangePos}
              onActionGutterMouseDown={handleActionGutterMouseDown}
              onActionGutterMouseEnter={handleActionGutterMouseEnter}
              browseMode
            />
            {inlineFindings.map((f) => (
              <InlineFindingCard key={f.id} finding={f} />
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
};
