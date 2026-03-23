import type { DiffHunk, DiffChange } from './types';

/**
 * Parse a unified diff format string into an array of DiffHunk objects.
 *
 * Expects the raw diff body (lines beginning with @@, -, +, or space).
 * File-level headers (--- a/... and +++ b/...) are skipped if present.
 */
export function parseDiff(rawDiff: string): DiffHunk[] {
  const lines = rawDiff.split('\n');
  const hunks: DiffHunk[] = [];

  let currentHunk: DiffHunk | null = null;
  let hunkIdx = -1;
  let changeIdx = 0;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Skip file-level headers
    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/
    );

    if (hunkMatch) {
      // Finalise previous hunk
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      hunkIdx++;
      changeIdx = 0;

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      oldLine = oldStart;
      newLine = newStart;

      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        changes: [],
      };

      continue;
    }

    // Only process content lines when we are inside a hunk
    if (!currentHunk) {
      continue;
    }

    let change: DiffChange | null = null;

    if (line.startsWith('-')) {
      change = {
        id: `C-${hunkIdx}-${changeIdx}`,
        type: 'delete',
        content: line.slice(1),
        oldLine: oldLine,
        newLine: null,
      };
      oldLine++;
    } else if (line.startsWith('+')) {
      change = {
        id: `C-${hunkIdx}-${changeIdx}`,
        type: 'insert',
        content: line.slice(1),
        oldLine: null,
        newLine: newLine,
      };
      newLine++;
    } else if (line.startsWith(' ') || line === '') {
      // Context line (prefixed with a space) or empty trailing line in hunk.
      // A truly empty string at the end of the file is ignored to avoid a
      // phantom trailing change when the raw diff ends with a newline.
      if (line === '' && currentHunk.changes.length > 0) {
        // Likely a trailing newline at end of input — skip
        continue;
      }
      change = {
        id: `C-${hunkIdx}-${changeIdx}`,
        type: 'normal',
        content: line.startsWith(' ') ? line.slice(1) : line,
        oldLine: oldLine,
        newLine: newLine,
      };
      oldLine++;
      newLine++;
    } else {
      // Unknown prefix — skip (e.g. "\ No newline at end of file")
      continue;
    }

    if (change) {
      currentHunk.changes.push(change);
      changeIdx++;
    }
  }

  // Push last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Validate that a hunk's change list is consistent with its declared
 * oldCount / newCount.
 *
 * oldCount should equal the number of 'delete' + 'normal' changes.
 * newCount should equal the number of 'insert' + 'normal' changes.
 */
export function validateHunk(hunk: DiffHunk): boolean {
  let oldTotal = 0;
  let newTotal = 0;

  for (const change of hunk.changes) {
    switch (change.type) {
      case 'delete':
        oldTotal++;
        break;
      case 'insert':
        newTotal++;
        break;
      case 'normal':
        oldTotal++;
        newTotal++;
        break;
    }
  }

  return oldTotal === hunk.oldCount && newTotal === hunk.newCount;
}
