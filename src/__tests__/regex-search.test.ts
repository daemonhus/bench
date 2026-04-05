import { describe, it, expect } from 'vitest';

/**
 * Extracted matcher logic from useRegexSearch — mirrors hook's useMemo exactly.
 */
function buildMatcher(query: string): { matcher: ((text: string) => boolean) | null; isRegexValid: boolean } {
  const q = query.trim();
  if (!q) return { matcher: null, isRegexValid: true };
  try {
    const re = new RegExp(q, 'i');
    return { matcher: (text: string) => re.test(text), isRegexValid: true };
  } catch {
    const lower = q.toLowerCase();
    return { matcher: (text: string) => text.toLowerCase().includes(lower), isRegexValid: false };
  }
}

describe('useRegexSearch — matcher', () => {
  it('returns null matcher for empty query', () => {
    const { matcher, isRegexValid } = buildMatcher('');
    expect(matcher).toBeNull();
    expect(isRegexValid).toBe(true);
  });

  it('returns null matcher for whitespace-only query', () => {
    const { matcher } = buildMatcher('   ');
    expect(matcher).toBeNull();
  });

  it('matches plain substring, case-insensitive', () => {
    const { matcher, isRegexValid } = buildMatcher('sql');
    expect(isRegexValid).toBe(true);
    expect(matcher!('SQL injection in login')).toBe(true);
    expect(matcher!('XSS vulnerability')).toBe(false);
  });

  it('matches regex alternation (requires ERE, not BRE)', () => {
    const { matcher, isRegexValid } = buildMatcher('sql|xss');
    expect(isRegexValid).toBe(true);
    expect(matcher!('SQL injection')).toBe(true);
    expect(matcher!('XSS in profile')).toBe(true);
    expect(matcher!('CSRF token missing')).toBe(false);
  });

  it('matches regex with + quantifier', () => {
    const { matcher, isRegexValid } = buildMatcher('auth.+bypass');
    expect(isRegexValid).toBe(true);
    expect(matcher!('authentication bypass via header')).toBe(true);
    expect(matcher!('authbypass')).toBe(false); // .+ requires at least one char between
  });

  it('matches regex with grouping and quantifiers', () => {
    const { matcher, isRegexValid } = buildMatcher('(sql|exec).*inject');
    expect(isRegexValid).toBe(true);
    expect(matcher!('SQL injection found')).toBe(true);
    expect(matcher!('exec injection via eval')).toBe(true);
    expect(matcher!('XSS injection')).toBe(false);
  });

  it('is case-insensitive for regex', () => {
    const { matcher } = buildMatcher('Auth');
    expect(matcher!('auth token missing')).toBe(true);
    expect(matcher!('AUTH bypass')).toBe(true);
  });

  it('falls back to substring on invalid regex, marks isRegexValid false', () => {
    const { matcher, isRegexValid } = buildMatcher('foo(');
    expect(isRegexValid).toBe(false);
    // literal substring match: "foo(" appears in the text
    expect(matcher!('calling foo(bar)')).toBe(true);
    expect(matcher!('no match here')).toBe(false);
  });

  it('fallback substring is case-insensitive', () => {
    const { matcher, isRegexValid } = buildMatcher('[unclosed');
    expect(isRegexValid).toBe(false);
    expect(matcher!('has [UNCLOSED bracket')).toBe(true);
  });

  it('matches against empty description gracefully', () => {
    const { matcher } = buildMatcher('sql');
    expect(matcher!('')).toBe(false);
  });

  it('anchored regex matches correctly', () => {
    const { matcher } = buildMatcher('^sql');
    expect(matcher!('SQL injection')).toBe(true);
    expect(matcher!('found sql injection')).toBe(false);
  });
});
