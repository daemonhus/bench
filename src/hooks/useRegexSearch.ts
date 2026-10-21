import { useState, useEffect, useMemo } from 'react';

export function useRegexSearch(storageKey: string) {
  const [query, setQuery] = useState<string>(() => {
    try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; }
  });

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, query); } catch {}
  }, [query, storageKey]);

  const { matcher, isRegexValid } = useRegexMatcher(query);

  return { query, setQuery, matcher, isRegexValid };
}

/** A search box's matcher: the text as a case-insensitive regex, or as plain text when it isn't
 *  one (isRegexValid false). For a query kept elsewhere, e.g. in the address. */
export function useRegexMatcher(query: string) {
  return useMemo(() => {
    const q = query.trim();
    if (!q) return { matcher: null, isRegexValid: true };
    try {
      const re = new RegExp(q, 'i');
      return { matcher: (text: string) => re.test(text), isRegexValid: true };
    } catch {
      const lower = q.toLowerCase();
      return { matcher: (text: string) => text.toLowerCase().includes(lower), isRegexValid: false };
    }
  }, [query]);
}
