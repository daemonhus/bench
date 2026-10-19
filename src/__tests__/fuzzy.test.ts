import { describe, it, expect } from 'vitest';
import { matchText } from '../core/fuzzy';

describe('matchText', () => {
  it('ranks a prefix over a word start over a match inside a word', () => {
    const prefix = matchText('sql', 'SQL injection in login');
    const word = matchText('sql', 'Blind SQL injection');
    const inside = matchText('sql', 'NoSQL injection');
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(0);
  });

  it('matches every query word in any order', () => {
    expect(matchText('login sql', 'SQL injection in login')).toBe(60);
  });

  it('tolerates skipped letters in short text, preferring tight clusters', () => {
    const tight = matchText('sqli', 'SQL injection');
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBeLessThan(60); // a loose match never beats real words
    expect(matchText('pymnt', 'payment-service')).toBeGreaterThan(0);
  });

  it('rejects scattered letters and loose matches in long text', () => {
    expect(matchText('xyz', 'x marks the spot, y not, z')).toBe(0);
    const paragraph = 'a'.repeat(60) + ' s q l ' + 'b'.repeat(80);
    expect(matchText('sql', paragraph)).toBe(0);
    expect(matchText('sql', `${'word '.repeat(40)}sql`)).toBeGreaterThan(0); // the word itself still counts
  });

  it('is empty-safe and case-insensitive', () => {
    expect(matchText('', 'anything')).toBe(0);
    expect(matchText('x', undefined)).toBe(0);
    expect(matchText('AUTH', 'auth bypass')).toBeGreaterThan(90);
  });
});
