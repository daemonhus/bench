import React, { useRef, useState, useEffect } from 'react';

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  placeholder?: string;
  shortcut?: string[];
  /** Extra class on the wrapper (e.g. to set a width). */
  className?: string;
  /** Accessible name when the placeholder alone isn't enough. */
  ariaLabel?: string;
  /** Expanding search: compact at rest with a leading icon, grows to fill the free space in
   *  its row while focused or holding a query. Put it last in a flex row (it pushes right). */
  expand?: boolean;
}

export const SearchBox: React.FC<SearchBoxProps> = ({
  value,
  onChange,
  invalid = false,
  placeholder = 'Search…',
  shortcut,
  className,
  ariaLabel,
  expand = false,
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
    <div
      className={`annotation-search${invalid ? ' annotation-search-invalid' : ''}${expand ? ' annotation-search--expand' : ''}${expand && (focused || value) ? ' annotation-search--open' : ''}${className ? ` ${className}` : ''}`}
      onMouseDown={expand ? (e) => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); } } : undefined}
    >
      {expand && (
        <svg className="annotation-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.75" />
          <path d="M10.5 10.5 14 14" />
        </svg>
      )}
      <input
        ref={inputRef}
        type="search"
        className={`annotation-search-input${showHint ? ' annotation-search-input--hinted' : ''}`}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
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
