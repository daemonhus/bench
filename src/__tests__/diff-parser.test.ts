import { describe, it, expect } from 'vitest';
import { parseDiff, validateHunk } from '../core/diff-parser';

const simpleDiff = `--- a/file.py
+++ b/file.py
@@ -1,4 +1,5 @@
 import os
-import hashlib
+import bcrypt
+import re
 from datetime import datetime
 from db import get_connection`;

describe('parseDiff', () => {
  it('parses a single hunk', () => {
    const hunks = parseDiff(simpleDiff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldCount).toBe(4);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newCount).toBe(5);
  });

  it('classifies change types correctly', () => {
    const hunks = parseDiff(simpleDiff);
    const types = hunks[0].changes.map(c => c.type);
    expect(types).toEqual(['normal', 'delete', 'insert', 'insert', 'normal', 'normal']);
  });

  it('strips prefix characters from content', () => {
    const hunks = parseDiff(simpleDiff);
    const changes = hunks[0].changes;
    expect(changes[0].content).toBe('import os');
    expect(changes[1].content).toBe('import hashlib');
    expect(changes[2].content).toBe('import bcrypt');
  });

  it('tracks old line numbers correctly', () => {
    const hunks = parseDiff(simpleDiff);
    const oldLines = hunks[0].changes.map(c => c.oldLine);
    // normal(1), delete(2), insert(null), insert(null), normal(3), normal(4)
    expect(oldLines).toEqual([1, 2, null, null, 3, 4]);
  });

  it('tracks new line numbers correctly', () => {
    const hunks = parseDiff(simpleDiff);
    const newLines = hunks[0].changes.map(c => c.newLine);
    // normal(1), delete(null), insert(2), insert(3), normal(4), normal(5)
    expect(newLines).toEqual([1, null, 2, 3, 4, 5]);
  });

  it('generates stable IDs for changes', () => {
    const hunks = parseDiff(simpleDiff);
    const ids = hunks[0].changes.map(c => c.id);
    expect(ids).toEqual([
      'C-0-0', 'C-0-1', 'C-0-2', 'C-0-3', 'C-0-4', 'C-0-5',
    ]);
  });

  it('parses multiple hunks', () => {
    const multiHunkDiff = `--- a/file.py
+++ b/file.py
@@ -1,3 +1,3 @@
 line one
-old line
+new line
 line three
@@ -10,3 +10,4 @@
 context
-removed
+added one
+added two
 more context`;
    const hunks = parseDiff(multiHunkDiff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[1].oldStart).toBe(10);
    expect(hunks[1].changes).toHaveLength(5);
  });

  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('handles diff with no file headers', () => {
    const bare = `@@ -1,2 +1,2 @@
 same
-old
+new
`;
    const hunks = parseDiff(bare);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].changes).toHaveLength(3);
  });
});

describe('validateHunk', () => {
  it('returns true for a valid hunk', () => {
    const hunks = parseDiff(simpleDiff);
    expect(validateHunk(hunks[0])).toBe(true);
  });

  it('returns false for mismatched counts', () => {
    const badHunk = {
      oldStart: 1,
      oldCount: 10, // way off
      newStart: 1,
      newCount: 10,
      changes: [
        { id: 'C-0-0', type: 'normal' as const, content: 'x', oldLine: 1, newLine: 1 },
      ],
    };
    expect(validateHunk(badHunk)).toBe(false);
  });
});
