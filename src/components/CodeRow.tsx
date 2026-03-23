import React from 'react';
import type { DiffChange, Token, Finding } from '../core/types';
import { renderToken } from '../core/tokenizer';

export interface FindingBarInfo {
  severity: string;
  position: 'first' | 'middle' | 'last' | 'single';
}

interface CodeRowProps {
  change: DiffChange;
  tokens: Token[] | null;
  findings: Finding[];
  findingBars: FindingBarInfo[];
  hasComments: boolean;
  isInCommentRange: boolean;
  isHighlighted: boolean;
  commentRangePosition: 'first' | 'middle' | 'last' | 'single' | null;
  onActionGutterMouseDown: (lineId: string) => void;
  onActionGutterMouseEnter: (lineId: string) => void;
  browseMode?: boolean;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
  info: '#6b7280',
};

export const CodeRow: React.FC<CodeRowProps> = React.memo(
  ({
    change,
    tokens,
    findings,
    findingBars,
    hasComments,
    isInCommentRange,
    isHighlighted,
    commentRangePosition,
    onActionGutterMouseDown,
    onActionGutterMouseEnter,
    browseMode,
  }) => {
    const typeClass =
      change.type === 'insert'
        ? 'diff-row-insert'
        : change.type === 'delete'
          ? 'diff-row-delete'
          : 'diff-row-normal';

    const rangeClass = commentRangePosition
      ? `comment-range-${commentRangePosition}`
      : '';

    const gutterSymbol =
      change.type === 'insert' ? '+' : change.type === 'delete' ? '-' : '';

    // Highest-severity finding bar for the gutter indicator
    const topBar = findingBars.length > 0 ? findingBars[0] : null;

    // Hide comment dot during active drag range
    const showCommentDot = hasComments && !commentRangePosition;

    return (
      <div
        className={`diff-row ${typeClass} ${rangeClass} ${isInCommentRange ? 'in-comment-range' : ''} ${isHighlighted ? 'highlight-range' : ''} ${browseMode ? 'browse-row' : ''}`}
        data-line-id={change.id}
        data-old-line={change.oldLine ?? undefined}
        data-new-line={change.newLine ?? undefined}
        onMouseEnter={() => onActionGutterMouseEnter(change.id)}
      >
        {/* Action gutter */}
        <div
          className={`action-gutter ${topBar ? `finding-bar finding-bar-${topBar.position}` : ''} ${showCommentDot ? 'has-comment' : ''}`}
          style={topBar ? { '--finding-bar-color': SEVERITY_COLORS[topBar.severity] ?? SEVERITY_COLORS.info } as React.CSSProperties : undefined}
          onMouseDown={(e) => {
            e.preventDefault();
            onActionGutterMouseDown(change.id);
          }}
        >
          {commentRangePosition ? (
            <span className={`comment-drag-bar comment-drag-bar-${commentRangePosition}`} />
          ) : findings.length > 0 && (topBar?.position === 'first' || topBar?.position === 'single') ? (
            <span className="finding-dots">
              {findings.map((f) => (
                <span
                  key={f.id}
                  className="finding-dot"
                  style={{ backgroundColor: SEVERITY_COLORS[f.severity] }}
                  title={`${f.severity}: ${f.title}`}
                />
              ))}
            </span>
          ) : gutterSymbol && !topBar ? (
            <span className="gutter-symbol">{gutterSymbol}</span>
          ) : !topBar ? (
            <span className="gutter-add-icon" title="Add comment">+</span>
          ) : null}
        </div>

        {browseMode ? (
          /* Browse mode: single line number column */
          <div className="line-number browse-line-number">
            {change.newLine ?? change.oldLine ?? ''}
          </div>
        ) : (
          <>
            {/* Diff mode: old + new line number columns */}
            <div className="line-number old-line-number">
              {change.oldLine ?? ''}
            </div>
            <div className="line-number new-line-number">
              {change.newLine ?? ''}
            </div>
          </>
        )}

        {/* Code content */}
        <div className="code-content">
          <code>
            {tokens
              ? tokens.map((token, i) => renderToken(token, i))
              : change.content}
          </code>
        </div>
      </div>
    );
  },
);

CodeRow.displayName = 'CodeRow';
