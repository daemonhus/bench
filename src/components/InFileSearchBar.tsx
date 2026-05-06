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
  const barRef = useRef<HTMLDivElement>(null);
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

  // Cycle focus among the bar's controls. Without this, Tab on a button inside
  // the bar bubbles up to App's global Tab handler and yanks focus to the next
  // nav-area; arrows have no effect at all.
  const handleBarKeyDown = (e: React.KeyboardEvent) => {
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const targetTag = (e.target as HTMLElement).tagName;
    // From the input, ArrowDown jumps focus into the button row (the input's
    // dedicated escape hatch that isn't Tab). Caret-movement arrows are left
    // to the browser.
    if (targetTag === 'INPUT' && e.key === 'ArrowDown') {
      const root = barRef.current;
      const firstBtn = root?.querySelector<HTMLElement>('button:not([disabled])');
      if (firstBtn) {
        e.preventDefault();
        e.stopPropagation();
        firstBtn.focus();
      }
      return;
    }
    if (isArrow && targetTag === 'INPUT') return;
    // ArrowUp from a button returns focus to the input.
    if (targetTag === 'BUTTON' && e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' && !isArrow) return;
    const root = barRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>('input, button:not([disabled])'),
    );
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement as HTMLElement);
    const forward = e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey);
    const next = idx === -1
      ? 0
      : forward
        ? (idx + 1) % focusables.length
        : (idx - 1 + focusables.length) % focusables.length;
    e.preventDefault();
    e.stopPropagation();
    focusables[next].focus();
  };

  return (
    <div className="in-file-search-bar" ref={barRef} onKeyDown={handleBarKeyDown}>
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
