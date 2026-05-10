import React, { useMemo, useRef, useState } from 'react';

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}

// Normalises a user-typed tag fragment. Tags are case-sensitive on the wire
// but trimmed of surrounding whitespace and rejected if empty.
function normalise(raw: string): string {
  return raw.trim();
}

export const TagInput: React.FC<TagInputProps> = ({
  value,
  onChange,
  suggestions = [],
  placeholder = 'Add tag…',
}) => {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const tag = normalise(raw);
    if (!tag) return;
    if (value.includes(tag)) {
      setDraft('');
      return;
    }
    onChange([...value, tag]);
    setDraft('');
  };

  const remove = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  const filteredSuggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    const taken = new Set(value);
    const pool = suggestions.filter((s) => !taken.has(s));
    if (!q) return pool.slice(0, 8);
    return pool.filter((s) => s.toLowerCase().includes(q)).slice(0, 8);
  }, [draft, suggestions, value]);

  const showSuggestions = open && filteredSuggestions.length > 0;
  const exactMatch = filteredSuggestions.some((s) => s.toLowerCase() === draft.trim().toLowerCase());
  const showCreateHint = open && draft.trim() !== '' && !exactMatch && !value.includes(normalise(draft));

  // Highlightable rows = visible suggestions, plus the create hint if shown.
  const rowCount = filteredSuggestions.length + (showCreateHint ? 1 : 0);
  // Clamp highlight if the list shrinks under us.
  const safeHighlight = rowCount === 0 ? 0 : Math.min(highlight, rowCount - 1);
  const commitRowAt = (i: number) => {
    if (i < filteredSuggestions.length) commit(filteredSuggestions[i]);
    else if (showCreateHint) commit(draft);
  };

  return (
    <div className="tag-input">
      <div className="tag-input-chip-row" onClick={() => inputRef.current?.focus()}>
        {value.map((tag) => (
          <span key={tag} className="tag-input-chip">
            {tag}
            <button
              type="button"
              className="tag-input-chip-remove"
              aria-label={`Remove ${tag}`}
              onClick={(e) => { e.stopPropagation(); remove(tag); }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tag-input-field"
          type="text"
          value={draft}
          placeholder={value.length === 0 ? placeholder : ''}
          onChange={(e) => { setDraft(e.target.value); setHighlight(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Defer so suggestion clicks register before the dropdown unmounts.
            setTimeout(() => setOpen(false), 120);
            // Commit any pending input on blur so the user doesn't lose typing.
            if (draft.trim() !== '') commit(draft);
          }}
          onKeyDown={(e) => {
            const popoverOpen = open && rowCount > 0;
            if (e.key === 'ArrowDown' && popoverOpen) {
              e.preventDefault();
              setHighlight((h) => (h + 1) % rowCount);
            } else if (e.key === 'ArrowUp' && popoverOpen) {
              e.preventDefault();
              setHighlight((h) => (h - 1 + rowCount) % rowCount);
            } else if (e.key === 'Escape' && open) {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'Enter') {
              // If the popover is open with a highlighted row, take it.
              // Otherwise fall back to committing the draft, or letting bare
              // Enter bubble to the outer form.
              if (popoverOpen) {
                e.preventDefault();
                commitRowAt(safeHighlight);
              } else if (draft.trim() !== '') {
                e.preventDefault();
                commit(draft);
              }
            } else if (e.key === ',' || e.key === ' ') {
              if (draft.trim() !== '') {
                e.preventDefault();
                commit(draft);
              }
            } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
              // Backspace at the start removes the last chip — standard chip-input UX.
              e.preventDefault();
              remove(value[value.length - 1]);
            }
          }}
        />
      </div>
      {(showSuggestions || showCreateHint) && (
        <div className="tag-input-popover" role="listbox">
          {filteredSuggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={i === safeHighlight}
              className={`tag-input-suggestion${i === safeHighlight ? ' tag-input-suggestion-active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(s); }}
            >
              {s}
            </button>
          ))}
          {showCreateHint && (
            <button
              type="button"
              role="option"
              aria-selected={safeHighlight === filteredSuggestions.length}
              className={`tag-input-suggestion tag-input-suggestion-create${safeHighlight === filteredSuggestions.length ? ' tag-input-suggestion-active' : ''}`}
              onMouseEnter={() => setHighlight(filteredSuggestions.length)}
              onMouseDown={(e) => { e.preventDefault(); commit(draft); }}
            >
              Create <span className="tag-input-suggestion-emphasis">{normalise(draft)}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
