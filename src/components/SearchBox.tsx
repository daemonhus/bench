import React, { useRef, useState, useEffect } from 'react';

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  placeholder?: string;
  shortcut?: string[];
}

export const SearchBox: React.FC<SearchBoxProps> = ({
  value,
  onChange,
  invalid = false,
  placeholder = 'Search…',
  shortcut,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!shortcut) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (inEditable) return;
      if (e.key === '/') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcut]);

  const showHint = shortcut && !value && !focused;

  return (
    <div className={`annotation-search${invalid ? ' annotation-search-invalid' : ''}`}>
      <input
        ref={inputRef}
        type="search"
        className={`annotation-search-input${showHint ? ' annotation-search-input--hinted' : ''}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {showHint && (
        <span className="annotation-search-hint" aria-hidden>
          {shortcut.map((key, i) => (
            <kbd key={i} className="annotation-search-kbd">{key}</kbd>
          ))}
        </span>
      )}
      {value && (
        <button
          className="annotation-search-clear"
          onClick={() => onChange('')}
          title="Clear search"
          tabIndex={-1}
        >
          &#x2715;
        </button>
      )}
    </div>
  );
};
