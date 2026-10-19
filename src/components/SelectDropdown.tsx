import React, { useState, useEffect, useRef, useId } from 'react';

/**
 * Pick-one dropdown with the same option list as MultiSelectDropdown, for toolbars, headers and
 * cards where a native <select> would look out of place. The trigger shows the selected option;
 * `label` names the control for assistive tech.
 *
 * Appearances:
 *  - "pill" (default): the filters' grey pill, for toolbar choices.
 *  - "tinted": the value's own colour (option `tone`; grey when it has none): a tinted chip with a
 *    dot. The status control: severity, status, kind — on pages (size "md") and on list cards
 *    (size "sm", the mini version).
 */
export function SelectDropdown<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
  appearance = 'pill',
  size = 'md',
  tabIndex,
}: {
  label: string;
  options: { value: T; label: string; dot?: string; tone?: string }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
  appearance?: 'pill' | 'tinted';
  size?: 'md' | 'sm';
  /** For list cards whose controls are reachable only while the card is open. */
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) setFocusedIndex(Math.max(0, options.findIndex((o) => o.value === value)));
    else setFocusedIndex(-1);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (i: number) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (options[i].value !== value) onChange(options[i].value);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { stop(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { stop(); setFocusedIndex((i) => Math.min(i + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { stop(); setFocusedIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Home') { stop(); setFocusedIndex(0); }
    else if (e.key === 'End') { stop(); setFocusedIndex(options.length - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0) { stop(); pick(focusedIndex); }
    else if (e.key === 'Escape') { stop(); setOpen(false); }
  };

  const dot = (color?: string) => color && <span className="select-dropdown-dot" style={{ background: color }} aria-hidden="true" />;
  const tinted = appearance === 'tinted';
  const tone = current?.tone ?? current?.dot;
  const chevron = (
    <svg className="select-dropdown-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={open ? 'M2.5 6.5 5 4l2.5 2.5' : 'M2.5 4 5 6.5 7.5 4'} />
    </svg>
  );
  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={tinted ? `select-tinted select-tinted--${size}${tone ? '' : ' select-tinted--neutral'}` : 'multi-select-trigger'}
      style={tinted && tone ? ({ '--tone': tone } as React.CSSProperties) : undefined}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      onKeyDown={handleTriggerKeyDown}
      aria-label={`${label}: ${current?.label ?? value}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? `${baseId}-list` : undefined}
      aria-activedescendant={open && focusedIndex >= 0 ? optionId(focusedIndex) : undefined}
      tabIndex={tabIndex}
    >
      {tinted ? tone && <span className="select-dropdown-dot" aria-hidden="true" /> : dot(current?.dot)}
      {current?.label ?? value}
      {tinted ? chevron : <span className="multi-select-chevron">{open ? '\u25B4' : '\u25BE'}</span>}
    </button>
  );

  return (
    <div
      className={`multi-select select-dropdown${tinted ? ' select-dropdown--tinted' : ''}${className ? ` ${className}` : ''}`}
      onClick={(e) => e.stopPropagation()}
      ref={ref}
      onBlur={(e) => { if (open && !ref.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      {tinted ? trigger : <div className="multi-select-pill">{trigger}</div>}
      {open && (
        <div className="multi-select-dropdown" id={`${baseId}-list`} role="listbox" aria-label={label}>
          {options.map((opt, i) => (
            <div
              key={opt.value}
              className={`multi-select-option${opt.value === value ? ' multi-select-option-active' : ''}${focusedIndex === i ? ' multi-select-option-focused' : ''}`}
              role="presentation"
              onMouseEnter={() => setFocusedIndex(i)}
            >
              <button
                type="button"
                className="multi-select-option-toggle"
                id={optionId(i)}
                role="option"
                aria-selected={opt.value === value}
                tabIndex={-1}
                onClick={() => pick(i)}
              >
                {dot(opt.tone ?? opt.dot)}
                {opt.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The status control's read-only form: the same tinted chip, for a value shown but not changed
 *  here (e.g. a finding's severity on its list card). */
export function ToneChip({ label, tone, size = 'sm', title }: { label: string; tone?: string; size?: 'md' | 'sm'; title?: string }) {
  return (
    <span className={`select-tinted select-tinted--${size} select-tinted--static${tone ? '' : ' select-tinted--neutral'}`}
      style={tone ? ({ '--tone': tone } as React.CSSProperties) : undefined} title={title}>
      {tone && <span className="select-dropdown-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}
