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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const allSelected = selected.size === options.length;
  const summary = allSelected ? label : `${label} (${selected.size})`;

  return (
    <div className="multi-select" ref={ref}>
      <div className="multi-select-pill">
        <button
          className={`multi-select-trigger${!allSelected ? ' multi-select-trigger-active' : ''}`}
          onClick={() => setOpen(!open)}
        >
          {summary}
          <span className="multi-select-chevron">{open ? '\u25B4' : '\u25BE'}</span>
        </button>
      </div>
      {open && (
        <div className="multi-select-dropdown">
          {options.map((opt) => {
            const isOn = selected.has(opt.value);
            return (
              <div key={opt.value} className={`multi-select-option${isOn ? ' multi-select-option-active' : ''}`}>
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
