import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useUIStore } from '../stores/ui-store';
import type { SearchMatchRange } from '../stores/ui-store';

interface Match {
  line: number;   // 1-indexed
  start: number;  // char offset within line
  end: number;    // char offset within line
}

interface InFileSearchBarProps {
  content: string;
  onClose: () => void;
  initialQuery?: string;
}

export const InFileSearchBar: React.FC<InFileSearchBarProps> = ({ content, onClose, initialQuery = '' }) => {
  const [query, setQuery] = useState(initialQuery);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const setInFileSearch = useUIStore((s) => s.setInFileSearch);
  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Re-seed query when opened again with a new selection (Cmd+F with text selected)
  const prevInitialQuery = useRef(initialQuery);
  useEffect(() => {
    if (initialQuery && initialQuery !== prevInitialQuery.current) {
      setQuery(initialQuery);
      setCurrentMatchIndex(0);
      inputRef.current?.select();
    }
    prevInitialQuery.current = initialQuery;
  }, [initialQuery]);

  // Compute all matches
  const matches: Match[] = useMemo(() => {
    if (!query.trim()) return [];
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, flags);
      const lines = content.split('\n');
      const result: Match[] = [];
      for (let i = 0; i < lines.length; i++) {
        let m: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((m = regex.exec(lines[i])) !== null) {
          result.push({ line: i + 1, start: m.index, end: m.index + m[0].length });
          if (m[0].length === 0) break; // prevent infinite loop on zero-width match
        }
      }
      return result;
    } catch {
      return [];
    }
  }, [content, query, caseSensitive]);

  // Clamp currentMatchIndex when matches change
  useEffect(() => {
    if (matches.length === 0) {
      setCurrentMatchIndex(0);
    } else if (currentMatchIndex >= matches.length) {
      setCurrentMatchIndex(0);
    }
  }, [matches.length, currentMatchIndex]);

  // Write match ranges to UI store for view highlighting
  useEffect(() => {
    if (matches.length === 0) {
      setInFileSearch(null);
      return;
    }
    const map = new Map<number, SearchMatchRange[]>();
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const arr = map.get(m.line) ?? [];
      arr.push({ start: m.start, end: m.end, isCurrent: i === currentMatchIndex });
      map.set(m.line, arr);
    }
    setInFileSearch(map);
  }, [matches, currentMatchIndex, setInFileSearch]);

  // Scroll to current match
  useEffect(() => {
    if (matches.length > 0 && currentMatchIndex < matches.length) {
      setScrollTargetLine(matches[currentMatchIndex].line);
    }
  }, [currentMatchIndex, matches, setScrollTargetLine]);

  // Clear search state on unmount
  useEffect(() => {
    return () => setInFileSearch(null);
  }, [setInFileSearch]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((i) => (i + 1) % matches.length);
  }, [matches.length]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((i) => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      goPrev();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      goNext();
    }
  };

  return (
    <div className="in-file-search-bar">
      <input
        ref={inputRef}
        className="in-file-search-input"
        type="text"
        placeholder="Find in file..."
        value={query}
        onChange={(e) => { setQuery(e.target.value); setCurrentMatchIndex(0); }}
        onKeyDown={handleKeyDown}
      />
      <span className="in-file-search-counter">
        {query.trim()
          ? matches.length > 0
            ? `${currentMatchIndex + 1} of ${matches.length}`
            : 'No matches'
          : ''}
      </span>
      <button
        className={`in-file-search-toggle ${caseSensitive ? 'in-file-search-toggle-active' : ''}`}
        title="Match case"
        onClick={() => { setCaseSensitive((v) => !v); setCurrentMatchIndex(0); }}
      >
        Aa
      </button>
      <button
        className="in-file-search-nav-btn"
        title="Previous match (Shift+Enter)"
        onClick={goPrev}
        disabled={matches.length === 0}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 10L8 6 4 10" />
        </svg>
      </button>
      <button
        className="in-file-search-nav-btn"
        title="Next match (Enter)"
        onClick={goNext}
        disabled={matches.length === 0}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <button className="in-file-search-close" title="Close (Esc)" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
};
