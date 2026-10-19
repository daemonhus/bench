import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useModal } from '../hooks/useModal';
import type { FileEntry } from '../core/types';
import { fuzzyMatch } from '../core/fuzzy';

interface FileSearchModalProps {
  files: FileEntry[];
  onSelect: (path: string) => void;
  onClose: () => void;
}

export const FileSearchModal: React.FC<FileSearchModalProps> = ({ files, onSelect, onClose }) => {
  const modal = useModal<HTMLDivElement>({ label: 'Go to file', onClose: onClose });
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
      <div className="file-search-modal" {...modal.props} onClick={(e) => e.stopPropagation()}>
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
