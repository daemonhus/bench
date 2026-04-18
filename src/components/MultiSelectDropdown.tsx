import React, { useState, useEffect, useRef } from 'react';

export function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reset focused index when dropdown opens/closes
  useEffect(() => {
    if (!open) setFocusedIndex(-1);
  }, [open]);

  const allSelected = selected.size === options.length;
  const summary = allSelected ? label : `${label} (${selected.size})`;

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
        setFocusedIndex(0);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(i => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(i => Math.max(i - 1, 0));
    } else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      const opt = options[focusedIndex];
      const next = new Set(selected);
      if (next.has(opt.value)) next.delete(opt.value); else next.add(opt.value);
      onChange(next);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="multi-select" ref={ref}>
      <div className="multi-select-pill">
        <button
          className={`multi-select-trigger${!allSelected ? ' multi-select-trigger-active' : ''}`}
          onClick={() => setOpen(!open)}
          onKeyDown={handleTriggerKeyDown}
        >
          {summary}
          <span className="multi-select-chevron">{open ? '\u25B4' : '\u25BE'}</span>
        </button>
      </div>
      {open && (
        <div className="multi-select-dropdown">
          {options.map((opt, i) => {
            const isOn = selected.has(opt.value);
            const isFocused = focusedIndex === i;
            return (
              <div
                key={opt.value}
                className={`multi-select-option${isOn ? ' multi-select-option-active' : ''}${isFocused ? ' multi-select-option-focused' : ''}`}
                onMouseEnter={() => setFocusedIndex(i)}
              >
                <button
                  className="multi-select-option-toggle"
                  onClick={() => {
                    const next = new Set(selected);
                    if (isOn) next.delete(opt.value); else next.add(opt.value);
                    onChange(next);
                  }}
                >
                  <span className="multi-select-check" />
                  {opt.label}
                </button>
                <button
                  className="multi-select-only"
                  onClick={() => onChange(new Set([opt.value]))}
                >only</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
