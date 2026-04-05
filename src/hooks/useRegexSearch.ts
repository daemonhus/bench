import { useState, useEffect, useMemo } from 'react';

export function useRegexSearch(storageKey: string) {
  const [query, setQuery] = useState<string>(() => {
    try { return sessionStorage.getItem(storageKey) ?? ''; } catch { return ''; }
  });

  useEffect(() => {
    try { sessionStorage.setItem(storageKey, query); } catch {}
  }, [query, storageKey]);

  const { matcher, isRegexValid } = useMemo(() => {
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

  return { query, setQuery, matcher, isRegexValid };
}
