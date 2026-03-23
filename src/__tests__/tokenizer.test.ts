import { describe, it, expect } from 'vitest';
import {
  highlight,
  extractText,
  markEdits,
  convertRefractorTree,
} from '../core/tokenizer';

describe('highlight', () => {
  it('returns Token[] for valid Python code', () => {
    const tokens = highlight('import os', 'python');
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('returns syntax tokens with classNames', () => {
    const tokens = highlight('def login():', 'python');
    // Should have at least one syntax token for the "def" keyword
    const hasSyntax = tokens.some(
      t => t.type === 'syntax' && t.className && t.className.length > 0,
    );
    expect(hasSyntax).toBe(true);
  });

  it('falls back to plain text for unknown languages', () => {
    const tokens = highlight('hello world', 'nonexistent_lang_xyz');
    expect(tokens).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('handles empty string', () => {
    const tokens = highlight('', 'python');
    expect(tokens).toBeDefined();
  });
});

describe('extractText', () => {
  it('extracts plain text from flat tokens', () => {
    const tokens = [
      { type: 'text' as const, value: 'hello ' },
      { type: 'text' as const, value: 'world' },
    ];
    expect(extractText(tokens)).toBe('hello world');
  });

  it('extracts text from nested tokens', () => {
    const tokens = [
      {
        type: 'syntax' as const,
        className: 'keyword',
        children: [{ type: 'text' as const, value: 'def' }],
      },
      { type: 'text' as const, value: ' login()' },
    ];
    expect(extractText(tokens)).toBe('def login()');
  });

  it('returns empty string for empty array', () => {
    expect(extractText([])).toBe('');
  });
});

describe('convertRefractorTree', () => {
  it('converts text nodes', () => {
    const nodes = [{ type: 'text', value: 'hello' }];
    const result = convertRefractorTree(nodes);
    expect(result).toEqual([{ type: 'text', value: 'hello' }]);
  });

  it('converts element nodes with classNames', () => {
    const nodes = [
      {
        type: 'element',
        properties: { className: ['keyword'] },
        children: [{ type: 'text', value: 'def' }],
      },
    ];
    const result = convertRefractorTree(nodes);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('syntax');
    expect(result[0].className).toBe('keyword');
    expect(result[0].children).toEqual([{ type: 'text', value: 'def' }]);
  });
});

describe('markEdits', () => {
  it('marks character-level differences between old and new tokens', () => {
    const oldTokens = [{ type: 'text' as const, value: 'import hashlib' }];
    const newTokens = [{ type: 'text' as const, value: 'import bcrypt' }];

    const { oldMarked, newMarked } = markEdits(oldTokens, newTokens);

    // The "import " prefix should remain as plain text
    const oldText = extractText(oldMarked);
    const newText = extractText(newMarked);
    expect(oldText).toBe('import hashlib');
    expect(newText).toBe('import bcrypt');

    // There should be at least one edit token in each result
    const hasOldEdit = oldMarked.some(
      t => t.type === 'edit' || (t.children?.some(c => c.type === 'edit') ?? false),
    );
    const hasNewEdit = newMarked.some(
      t => t.type === 'edit' || (t.children?.some(c => c.type === 'edit') ?? false),
    );
    expect(hasOldEdit).toBe(true);
    expect(hasNewEdit).toBe(true);
  });

  it('preserves text when lines are identical', () => {
    const tokens = [{ type: 'text' as const, value: 'same line' }];
    const { oldMarked, newMarked } = markEdits(tokens, tokens);

    expect(extractText(oldMarked)).toBe('same line');
    expect(extractText(newMarked)).toBe('same line');

    // No edit tokens when content is identical
    const hasEdit = oldMarked.some(t => t.type === 'edit');
    expect(hasEdit).toBe(false);
  });

  it('handles syntax-highlighted tokens', () => {
    const oldTokens = highlight('SECRET_KEY = "supersecretkey123"', 'python');
    const newTokens = highlight('SECRET_KEY = os.environ.get("JWT_SECRET", "fallback")', 'python');

    const { oldMarked, newMarked } = markEdits(oldTokens, newTokens);

    expect(extractText(oldMarked)).toBe('SECRET_KEY = "supersecretkey123"');
    expect(extractText(newMarked)).toBe('SECRET_KEY = os.environ.get("JWT_SECRET", "fallback")');
  });
});
