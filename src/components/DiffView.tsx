import React, { useEffect, useRef, useMemo, useCallback } from 'react';
import { useDiffStore } from '../stores/diff-store';
import { useRepoStore } from '../stores/repo-store';
import { useAnnotationStore } from '../stores/annotation-store';
import { useReconcileStore } from '../stores/reconcile-store';
import { useUIStore } from '../stores/ui-store';
import { useCommentDrag } from '../hooks/useCommentDrag';
import { highlight, markEdits, applySearchRanges } from '../core/tokenizer';
import type { DiffChange, Token, Finding } from '../core/types';
import { getEffectiveLineRange } from '../core/types';
import { CodeRow } from './CodeRow';
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

/**
 * Extracts the effective line number for a change (prefers newLine, falls back to oldLine).
 */
function effectiveLine(change: DiffChange): number {
  return change.newLine ?? change.oldLine ?? 0;
}

/**
 * Groups adjacent delete/insert pairs so we can run character-level markEdits on them.
 */
function pairAdjacentChanges(
  changes: DiffChange[],
): { change: DiffChange; paired: DiffChange | null }[] {
  const result: { change: DiffChange; paired: DiffChange | null }[] = [];
  let i = 0;

  while (i < changes.length) {
    const current = changes[i];

    // Look for delete immediately followed by insert
    if (
      current.type === 'delete' &&
      i + 1 < changes.length &&
      changes[i + 1].type === 'insert'
    ) {
      result.push({ change: current, paired: changes[i + 1] });
      result.push({ change: changes[i + 1], paired: current });
      i += 2;
    } else {
      result.push({ change: current, paired: null });
      i += 1;
    }
  }

  return result;
}

export const DiffView: React.FC = () => {
  const changes = useDiffStore((s) => s.changes);
  const fileLanguage = useRepoStore((s) => s.fileLanguage);
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

  const containerRef = useRef<HTMLDivElement>(null);

  const {
    onIconMouseDown,
    onRowMouseEnter,
    isInRange,
    rangePosition,
  } = useCommentDrag();

  // Pair adjacent deletes/inserts for character-level diffs
  const paired = useMemo(() => pairAdjacentChanges(changes), [changes]);

  // Pre-compute syntax tokens and edit marks (with optional search highlights)
  const tokenMap = useMemo(() => {
    const map = new Map<string, Token[]>();
    const lang = fileLanguage ?? '';

    for (const { change, paired: partner } of paired) {
      let tokens = highlight(change.content, lang);

      if (partner) {
        const partnerTokens = highlight(partner.content, lang);

        if (change.type === 'delete') {
          const { oldMarked } = markEdits(tokens, partnerTokens);
          tokens = oldMarked;
        } else {
          const { newMarked } = markEdits(partnerTokens, tokens);
          tokens = newMarked;
        }
      }

      // Apply search highlights on top of edit marks
      const ln = effectiveLine(change);
      const lineMatches = inFileSearch?.get(ln);
      if (lineMatches && lineMatches.length > 0) {
        tokens = applySearchRanges(tokens, lineMatches);
      }

      map.set(change.id, tokens);
    }

    return map;
  }, [paired, inFileSearch]);

  // Scroll to target line (retries when content loads via `changes` dep)
  useEffect(() => {
    if (scrollTargetLine === null || !containerRef.current) return;

    const rows = containerRef.current.querySelectorAll('.diff-row');
    let found = false;
    for (const row of rows) {
      const oldLine = row.getAttribute('data-old-line');
      const newLine = row.getAttribute('data-new-line');
      if (
        (oldLine && parseInt(oldLine, 10) === scrollTargetLine) ||
        (newLine && parseInt(newLine, 10) === scrollTargetLine)
      ) {
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
  }, [scrollTargetLine, setScrollTargetLine, changes]);

  const handleActionGutterMouseDown = useCallback(
    (lineId: string) => {
      const change = changes.find((c) => c.id === lineId);
      if (!change) return;
      const line = effectiveLine(change);
      const side = change.type === 'delete' ? 'old' : 'new';
      onIconMouseDown(line, side as 'old' | 'new');
    },
    [changes, onIconMouseDown],
  );

  const handleActionGutterMouseEnter = useCallback(
    (lineId: string) => {
      const change = changes.find((c) => c.id === lineId);
      if (!change) return;
      // Pass side for boundary enforcement: delete→old, insert→new, normal→undefined (matches either)
      const side = change.type === 'delete' ? 'old' : change.type === 'insert' ? 'new' : undefined;
      onRowMouseEnter(effectiveLine(change), side);
    },
    [changes, onRowMouseEnter],
  );

  const showToolbar = commentDrag.isActive && commentDrag.startLine !== null && annotationAction === null;

  let toolbarTop = 0;
  if (showToolbar && containerRef.current && commentDrag.endLine !== null) {
    const side = commentDrag.side === 'old' ? 'data-old-line' : 'data-new-line';
    const row = containerRef.current.querySelector(`[${side}="${commentDrag.endLine}"]`) as HTMLElement | null;
    if (row) toolbarTop = row.offsetTop + row.offsetHeight + 2;
  }

  return (
    <div className="diff-view" ref={containerRef} style={{ position: 'relative' }}>
      {showToolbar && (
        <SelectionToolbar startLine={commentDrag.startLine!} endLine={commentDrag.endLine!} top={toolbarTop} />
      )}
      {changes.map((change) => {
        const line = effectiveLine(change);
        const findings = line > 0 ? getFindingsForLine(line) : [];
        const tokens = tokenMap.get(change.id) ?? null;
        const inRange = isInRange(line);
        const rangePos = rangePosition(line);

        const findingBars = positionsTrusted ? computeFindingBars(findings, line) : [];
        const hasComments = positionsTrusted && line > 0 ? getCommentsForLine(line).length > 0 : false;
        const highlighted = highlightRange !== null && line >= highlightRange.start && line <= highlightRange.end;

        return (
          <CodeRow
            key={change.id}
            change={change}
            tokens={tokens}
            findings={findings}
            findingBars={findingBars}
            hasComments={hasComments}
            isInCommentRange={inRange}
            isHighlighted={highlighted}
            commentRangePosition={rangePos}
            onActionGutterMouseDown={handleActionGutterMouseDown}
            onActionGutterMouseEnter={handleActionGutterMouseEnter}
          />
        );
      })}
    </div>
  );
};
