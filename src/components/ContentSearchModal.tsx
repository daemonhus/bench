import React, { useState, useEffect, useRef, useCallback } from 'react';
import { gitApi } from '../core/api';
import type { GrepMatch } from '../core/types';

interface ContentSearchModalProps {
  currentCommit: string;
  onSelect: (file: string, line: number) => void;
  onClose: () => void;
  initialQuery?: string;
}

export const ContentSearchModal: React.FC<ContentSearchModalProps> = ({ currentCommit, onSelect, onClose, initialQuery = '' }) => {
  const [query, setQuery] = useState(initialQuery);
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [results, setResults] = useState<GrepMatch[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  const doSearch = useCallback(
    (pattern: string, ci: boolean) => {
      abortRef.current?.abort();
      if (!pattern.trim()) {
        setResults([]);
        setSearched(false);
        setLoading(false);
        return;
      }
      setLoading(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const timer = setTimeout(() => {
        gitApi
          .searchCode(pattern, currentCommit, { caseInsensitive: ci })
          .then((matches) => {
            if (!controller.signal.aborted) {
              setResults(matches);
              setSelectedIdx(0);
              setSearched(true);
              setLoading(false);
            }
          })
          .catch((err) => {
            if (!controller.signal.aborted) {
              console.error('search failed:', err);
              setResults([]);
              setSearched(true);
              setLoading(false);
            }
          });
      }, 300);
      controller.signal.addEventListener('abort', () => clearTimeout(timer));
    },
    [currentCommit],
  );

  useEffect(() => {
    doSearch(query, caseInsensitive);
    return () => abortRef.current?.abort();
  }, [query, caseInsensitive, doSearch]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const match = results[selectedIdx];
      if (match) onSelect(match.file, match.line);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const highlightPattern = (text: string, pattern: string, ci: boolean) => {
    if (!pattern.trim()) return <>{text}</>;
    try {
      const regex = new RegExp(`(${pattern})`, ci ? 'gi' : 'g');
      const parts = text.split(regex);
      return (
        <>
          {parts.map((part, i) =>
            regex.test(part) ? (
              <span key={i} className="content-search-match">{part}</span>
            ) : (
              part
            ),
          )}
        </>
      );
    } catch {
      return <>{text}</>;
    }
  };

  return (
    <div className="content-search-overlay" onClick={onClose}>
      <div className="content-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="content-search-input-row">
          <input
            ref={inputRef}
            className="content-search-input"
            type="text"
            placeholder="Search in files... (regex)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className={`content-search-case-btn ${caseInsensitive ? '' : 'content-search-case-active'}`}
            title="Match case"
            onClick={() => setCaseInsensitive((v) => !v)}
          >
            Aa
          </button>
        </div>
        <div className="content-search-results" ref={listRef}>
          {results.map((match, i) => (
            <div
              key={`${match.file}:${match.line}:${i}`}
              className={`content-search-item ${i === selectedIdx ? 'content-search-item-selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => onSelect(match.file, match.line)}
            >
              <span className="content-search-location">
                {match.file}
                <span className="content-search-line">:{match.line}</span>
              </span>
              <span className="content-search-text">
                {highlightPattern(match.text, query, caseInsensitive)}
              </span>
            </div>
          ))}
          {loading && query.trim() && (
            <div className="content-search-empty">Searching...</div>
          )}
          {!loading && searched && results.length === 0 && (
            <div className="content-search-empty">No matches found</div>
          )}
        </div>
      </div>
    </div>
  );
};
