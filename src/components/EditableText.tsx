import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InlineMarkdown } from '../core/markdown';

// Always-editable fields for detail pages (flows, findings, features): text reads as text,
// a hover shows it can be edited, a click (or Enter) turns it into an input, and leaving the
// field saves. Styles: .editable* in styles/editable.css.

interface EditableTextProps {
  value: string;
  onChange: (s: string) => void;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  /** Field name for assistive tech when the placeholder is not a good label. */
  label?: string;
  /** Show the value as plain text instead of inline markdown (ids, numbers, vectors). */
  plain?: boolean;
  /** Inline style for the shown value (e.g. a badge's colour). */
  style?: React.CSSProperties;
}

export function EditableText({ value, onChange, className, placeholder, multiline, readOnly, label, plain, style }: EditableTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const displayRef = useRef<HTMLDivElement>(null);
  // Leaving edit mode by keyboard unmounts the focused input; hand focus back to the display
  // element so the user isn't dropped onto <body>. Blur-driven exits (clicked or tabbed
  // elsewhere) keep focus where the user put it.
  const refocusDisplay = useRef(false);

  useEffect(() => { setDraft(value); }, [value]);

  useEffect(() => {
    if (!editing && refocusDisplay.current) {
      refocusDisplay.current = false;
      displayRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  function commit(viaKeyboard = false) {
    refocusDisplay.current = viaKeyboard;
    setEditing(false);
    if (draft !== value) onChange(draft);
  }
  function cancel() {
    refocusDisplay.current = true;
    setDraft(value);
    setEditing(false);
  }

  const shown = plain ? value : <InlineMarkdown text={value} />;

  if (readOnly) {
    if (!value) return null;
    return <div className={className}>{shown}</div>;
  }

  if (!editing) {
    return (
      <div
        ref={displayRef}
        className={`${className ?? ''} editable${value ? '' : ' editable-empty'}`}
        style={style}
        onClick={() => setEditing(true)}
        role="textbox"
        aria-label={label || placeholder || 'Editable text'}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value ? shown : <span className="editable-placeholder">{placeholder}</span>}
      </div>
    );
  }

  if (multiline) {
    return (
      <textarea
        autoFocus
        className={`${className ?? ''} editable editable-input`}
        aria-label={label || placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit(true);
          }
        }}
        placeholder={placeholder}
      />
    );
  }

  return (
    <input
      autoFocus
      className={`${className ?? ''} editable editable-input`}
      aria-label={label || placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancel();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(true);
        }
      }}
      placeholder={placeholder}
    />
  );
}

/** "Saving…" while a change is in flight, "Saved" once one has landed. */
export function SaveIndicator({ saving, savedAt }: { saving: boolean; savedAt: number | null }) {
  if (saving) return <span className="save-indicator save-indicator--saving" role="status">Saving…</span>;
  if (savedAt == null) return <span className="save-indicator save-indicator--idle" />;
  return <span className="save-indicator save-indicator--saved" role="status">Saved</span>;
}

/** Wraps each save so a page can show SaveIndicator: counts saves in flight and remembers when
 *  the last one succeeded. */
export function useSaveTracker() {
  const [saving, setSaving] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const withSave = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setSaving((s) => s + 1);
    setError(null);
    try {
      const out = await fn();
      setSavedAt(Date.now());
      return out;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      throw e;
    } finally {
      setSaving((s) => s - 1);
    }
  }, []);
  return { saving: saving > 0, savedAt, error, withSave };
}
