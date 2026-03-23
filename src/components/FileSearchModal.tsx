import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { FileEntry } from '../core/types';

interface FileSearchModalProps {
  files: FileEntry[];
  onSelect: (path: string) => void;
  onClose: () => void;
}

/** Simple fuzzy match: all query chars must appear in order (case-insensitive). */
function fuzzyMatch(query: string, candidate: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatchIdx = -2;

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      // Bonus for consecutive matches
      if (ci === prevMatchIdx + 1) score += 5;
      // Bonus for match at segment boundary (after / or at start)
      if (ci === 0 || c[ci - 1] === '/') score += 10;
      // Bonus for matching near end (filename part)
      score += ci / c.length;
      prevMatchIdx = ci;
      qi++;
    }
  }

  return { match: qi === q.length, score };
}

export const FileSearchModal: React.FC<FileSearchModalProps> = ({ files, onSelect, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) {
      return files.map((f) => f.path);
    }
    return files
      .map((f) => ({ path: f.path, ...fuzzyMatch(query, f.path) }))
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.path);
  }, [files, query]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIdx(0);
  }, [results]);

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
      if (results[selectedIdx]) {
        onSelect(results[selectedIdx]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Highlight matching chars in the path
  const highlightMatch = (path: string) => {
    if (!query.trim()) return <>{path}</>;
    const q = query.toLowerCase();
    const parts: React.ReactNode[] = [];
    let qi = 0;
    for (let i = 0; i < path.length; i++) {
      if (qi < q.length && path[i].toLowerCase() === q[qi]) {
        parts.push(<span key={i} className="file-search-highlight">{path[i]}</span>);
        qi++;
      } else {
        parts.push(path[i]);
      }
    }
    return <>{parts}</>;
  };

  return (
    <div className="file-search-overlay" onClick={onClose}>
      <div className="file-search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="file-search-input"
          type="text"
          placeholder="Go to file..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="file-search-results" ref={listRef}>
          {results.slice(0, 50).map((path, i) => (
            <div
              key={path}
              className={`file-search-item ${i === selectedIdx ? 'file-search-item-selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => onSelect(path)}
            >
              {highlightMatch(path)}
            </div>
          ))}
          {results.length === 0 && query.trim() && (
            <div className="file-search-empty">No matching files</div>
          )}
        </div>
      </div>
    </div>
  );
};
