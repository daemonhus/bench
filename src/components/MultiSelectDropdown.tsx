import React, { useState, useEffect, useRef, useId } from 'react';

export function MultiSelectDropdown<T extends string>({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  /** `icon`: a mark drawn before the label (a colour dot, a line style). */
  options: { value: T; label: string; icon?: React.ReactNode }[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const optionId = (i: number) => `${baseId}-opt-${i}`;

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

  const toggleAt = (i: number) => {
    const opt = options[i];
    const next = new Set(selected);
    if (next.has(opt.value)) next.delete(opt.value); else next.add(opt.value);
    onChange(next);
  };

  // Focus stays on the trigger; Up/Down move a highlighted option, announced via
  // aria-activedescendant (menu-button pattern).
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
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { stop(); setFocusedIndex(i => Math.min(i + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { stop(); setFocusedIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Home') { stop(); setFocusedIndex(0); }
    else if (e.key === 'End') { stop(); setFocusedIndex(options.length - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0) { stop(); toggleAt(focusedIndex); }
    else if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && !e.altKey && focusedIndex >= 0) {
      stop(); // keyboard equivalent of the hover-only "only" button
      onChange(new Set([options[focusedIndex].value]));
    }
    else if (e.key === 'Escape') { stop(); setOpen(false); }
  };

  return (
    <div
      className="multi-select"
      ref={ref}
      // Close when focus leaves (Tab is consumed by the app's area cycling, so the
      // trigger's own Tab handler never sees it).
      onBlur={(e) => { if (open && !ref.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      // A mouse click on an option moves focus into the list, out of the trigger's key handler:
      // Escape from there still closes the list and puts focus back on the trigger.
      onKeyDown={(e) => {
        if (open && e.key === 'Escape' && e.target !== triggerRef.current) {
          e.preventDefault(); e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <div className="multi-select-pill">
        <button
          ref={triggerRef}
          className={`multi-select-trigger${!allSelected ? ' multi-select-trigger-active' : ''}`}
          onClick={() => setOpen(!open)}
          onKeyDown={handleTriggerKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? `${baseId}-list` : undefined}
          aria-activedescendant={open && focusedIndex >= 0 ? optionId(focusedIndex) : undefined}
        >
          {summary}
          <span className="multi-select-chevron">{open ? '\u25B4' : '\u25BE'}</span>
        </button>
      </div>
      {open && (
        <div className="multi-select-dropdown" id={`${baseId}-list`} role="listbox" aria-multiselectable="true" aria-label={label}>
          {options.map((opt, i) => {
            const isOn = selected.has(opt.value);
            const isFocused = focusedIndex === i;
            return (
              <div
                key={opt.value}
                className={`multi-select-option${isOn ? ' multi-select-option-active' : ''}${isFocused ? ' multi-select-option-focused' : ''}`}
                role="presentation"
                onMouseEnter={() => setFocusedIndex(i)}
              >
                <button
                  className="multi-select-option-toggle"
                  id={optionId(i)}
                  role="option"
                  aria-selected={isOn}
                  tabIndex={-1}
                  onClick={() => toggleAt(i)}
                >
                  <span className="multi-select-check" />
                  {opt.icon}
                  {opt.label}
                </button>
                <button
                  className="multi-select-only"
                  tabIndex={-1}
                  aria-label={`Only ${opt.label}`}
                  title="Only this one (o)"
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
