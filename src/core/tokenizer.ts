import React from 'react';
import { refractor } from 'refractor';
import DiffMatchPatch from 'diff-match-patch';
import type { Token } from './types';

// diff-match-patch singleton
const dmp = new DiffMatchPatch();

// ---------------------------------------------------------------------------
// Stage 1 — Syntax highlighting via refractor
// ---------------------------------------------------------------------------

/**
 * Convert a refractor / hast node tree into our flat Token[] structure.
 */
export function convertRefractorTree(nodes: any[]): Token[] {
  const tokens: Token[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      tokens.push({ type: 'text', value: node.value });
    } else if (node.type === 'element') {
      const className = (node.properties?.className ?? []).join(' ');
      const children = node.children
        ? convertRefractorTree(node.children)
        : undefined;
      tokens.push({ type: 'syntax', className, children });
    }
  }

  return tokens;
}

/**
 * Highlight a single line of code and return Token[].
 */
export function highlight(content: string, language: string): Token[] {
  if (!refractor.registered(language)) {
    return [{ type: 'text', value: content }];
  }
  try {
    const tree = refractor.highlight(content, language);
    return convertRefractorTree(tree.children as any[]);
  } catch {
    return [{ type: 'text', value: content }];
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — Inline edit marking via diff-match-patch
// ---------------------------------------------------------------------------

/**
 * Extract the concatenated plain text from a token tree.
 */
export function extractText(tokens: Token[]): string {
  let result = '';
  for (const token of tokens) {
    if (token.value !== undefined) {
      result += token.value;
    }
    if (token.children) {
      result += extractText(token.children);
    }
  }
  return result;
}

/**
 * Walk the token tree and wrap character ranges that correspond to edits in
 * `edit` tokens.  `diffs` is the array returned by diff-match-patch where
 * each entry is [operation, text].
 *
 * `side` determines which diff operations we highlight:
 *   - 'delete' highlights DiffMatchPatch.DIFF_DELETE (-1)
 *   - 'insert' highlights DiffMatchPatch.DIFF_INSERT (1)
 *
 * Unchanged spans (DIFF_EQUAL, 0) are skipped.
 */
export function applyEditRanges(
  tokens: Token[],
  diffs: [number, string][],
  side: 'insert' | 'delete',
): Token[] {
  // Build a flat list of { start, end } ranges that should be highlighted.
  const targetOp = side === 'delete' ? -1 : 1;
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;

  for (const [op, text] of diffs) {
    if (op === 0) {
      // equal — advance cursor on both sides
      cursor += text.length;
    } else if (op === targetOp) {
      ranges.push({ start: cursor, end: cursor + text.length });
      cursor += text.length;
    }
    // The opposite operation contributes no characters to this side, so
    // we intentionally do NOT advance the cursor.
  }

  // Now walk the token tree and split tokens at range boundaries.
  let offset = 0;
  return splitTokens(tokens, ranges, { offset });
}

interface WalkState {
  offset: number;
}

interface SplitRange {
  start: number;
  end: number;
  className?: string;
}

function splitTokens(
  tokens: Token[],
  ranges: SplitRange[],
  state: WalkState,
  wrapType: Token['type'] = 'edit',
  defaultClassName: string = 'edit-highlight',
): Token[] {
  const result: Token[] = [];

  for (const token of tokens) {
    if (token.type === 'text' && token.value !== undefined) {
      const text = token.value;
      const start = state.offset;
      const end = start + text.length;

      // Collect sub-segments that need wrapping
      const segments: { text: string; highlighted: boolean; className?: string }[] = [];
      let pos = 0;

      for (const range of ranges) {
        // Range is entirely before this text node
        if (range.end <= start) continue;
        // Range is entirely after this text node
        if (range.start >= end) continue;

        const rStart = Math.max(range.start - start, 0);
        const rEnd = Math.min(range.end - start, text.length);

        // Push unhighlighted part before this range
        if (rStart > pos) {
          segments.push({ text: text.slice(pos, rStart), highlighted: false });
        }
        segments.push({ text: text.slice(rStart, rEnd), highlighted: true, className: range.className });
        pos = rEnd;
      }

      // Push remaining unhighlighted tail
      if (pos < text.length) {
        segments.push({ text: text.slice(pos), highlighted: false });
      }

      // If no segments were created, the whole node is unhighlighted
      if (segments.length === 0) {
        segments.push({ text, highlighted: false });
      }

      for (const seg of segments) {
        if (seg.highlighted) {
          result.push({
            type: wrapType,
            className: seg.className ?? defaultClassName,
            children: [{ type: 'text', value: seg.text }],
          });
        } else {
          result.push({ type: 'text', value: seg.text });
        }
      }

      state.offset = end;
    } else if (token.children) {
      // Recursively process children, preserving the wrapper token
      const newChildren = splitTokens(token.children, ranges, state, wrapType, defaultClassName);
      result.push({ ...token, children: newChildren });
    } else {
      result.push(token);
    }
  }

  return result;
}

/**
 * Compare the text of two token arrays (old vs new) and return copies with
 * inline edit markers injected.
 */
export function markEdits(
  oldTokens: Token[],
  newTokens: Token[],
): { oldMarked: Token[]; newMarked: Token[] } {
  const oldText = extractText(oldTokens);
  const newText = extractText(newTokens);

  const rawDiffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(rawDiffs);

  // Build side-specific diff arrays.
  // For the old (delete) side, keep DIFF_EQUAL and DIFF_DELETE entries.
  // For the new (insert) side, keep DIFF_EQUAL and DIFF_INSERT entries.
  const oldDiffs: [number, string][] = rawDiffs.filter(
    ([op]) => op === 0 || op === -1,
  );
  const newDiffs: [number, string][] = rawDiffs.filter(
    ([op]) => op === 0 || op === 1,
  );

  const oldMarked = applyEditRanges(
    structuredClone(oldTokens),
    oldDiffs,
    'delete',
  );
  const newMarked = applyEditRanges(
    structuredClone(newTokens),
    newDiffs,
    'insert',
  );

  return { oldMarked, newMarked };
}

// ---------------------------------------------------------------------------
// Stage 2b — Search match highlighting
// ---------------------------------------------------------------------------

/**
 * Apply search-match highlights to a token tree.  Each match carries its own
 * className so we can distinguish the "current" match from the rest.
 */
export function applySearchRanges(
  tokens: Token[],
  matches: Array<{ start: number; end: number; isCurrent: boolean }>,
): Token[] {
  const ranges: SplitRange[] = matches.map((m) => ({
    start: m.start,
    end: m.end,
    className: m.isCurrent ? 'search-match-current' : 'search-match',
  }));
  return splitTokens(tokens, ranges, { offset: 0 }, 'search-match', 'search-match');
}

// ---------------------------------------------------------------------------
// Stage 3 — Recursive React renderer
// ---------------------------------------------------------------------------

/**
 * Render a Token tree into React elements.
 */
export function renderToken(token: Token, index: number): React.ReactNode {
  switch (token.type) {
    case 'text':
      return token.value ?? '';

    case 'syntax':
      return React.createElement(
        'span',
        { key: index, className: token.className },
        token.children?.map((child, i) => renderToken(child, i)),
      );

    case 'edit':
      return React.createElement(
        'span',
        { key: index, className: token.className ?? 'edit-highlight' },
        token.children?.map((child, i) => renderToken(child, i)),
      );

    case 'search-match':
      return React.createElement(
        'span',
        { key: index, className: token.className ?? 'search-match' },
        token.children?.map((child, i) => renderToken(child, i)),
      );

    case 'annotation':
      return React.createElement(
        'span',
        {
          key: index,
          className: token.className ?? 'annotation-highlight',
          'data-annotation-id': token.annotationId,
        },
        token.children?.map((child, i) => renderToken(child, i)),
      );

    default:
      return token.value ?? '';
  }
}
