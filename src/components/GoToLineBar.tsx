import React, { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../stores/ui-store';

interface GoToLineBarProps {
  maxLine: number;
  onClose: () => void;
}

export const GoToLineBar: React.FC<GoToLineBarProps> = ({ maxLine, onClose }) => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);
  const setCodeviewFocusedLine = useUIStore((s) => s.setCodeviewFocusedLine);
  const setCodeviewSelectAnchor = useUIStore((s) => s.setCodeviewSelectAnchor);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parsed = (() => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(n, maxLine);
  })();

  const submit = () => {
    if (parsed !== null) {
      setScrollTargetLine(parsed);
      setCodeviewSelectAnchor(null);
      setCodeviewFocusedLine(parsed);
      // Return focus to the codeview so Up/Down keep navigating from here.
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-nav-area="codeview"]') as HTMLElement | null;
        el?.focus({ preventScroll: true });
      });
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };

  const handleBarKeyDown = (e: React.KeyboardEvent) => {
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const targetTag = (e.target as HTMLElement).tagName;
    if (targetTag === 'INPUT' && e.key === 'ArrowDown') {
      const firstBtn = barRef.current?.querySelector<HTMLElement>('button:not([disabled])');
      if (firstBtn) {
        e.preventDefault();
        e.stopPropagation();
        firstBtn.focus();
      }
      return;
    }
    if (isArrow && targetTag === 'INPUT') return;
    if (targetTag === 'BUTTON' && e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' && !isArrow) return;
    const root = barRef.current;
    if (!root) return;
    const focusables = Array.from(
      root.querySelectorAll<HTMLElement>('input, button:not([disabled])'),
    );
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement as HTMLElement);
    const forward = e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey);
    const next = idx === -1
      ? 0
      : forward
        ? (idx + 1) % focusables.length
        : (idx - 1 + focusables.length) % focusables.length;
    e.preventDefault();
    e.stopPropagation();
    focusables[next].focus();
  };

  return (
    <div className="in-file-search-bar" ref={barRef} onKeyDown={handleBarKeyDown}>
      <input
        ref={inputRef}
        className="in-file-search-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder={`Go to line (1–${maxLine})`}
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
        onKeyDown={handleKeyDown}
        name="bench-goto-line"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
      />
      <span className="in-file-search-counter">
        {value === '' ? '' : parsed !== null ? `→ ${parsed}` : '-'}
      </span>
      <button className="in-file-search-close" title="Close (Esc)" onClick={onClose}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
};
