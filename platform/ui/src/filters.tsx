import { useState, useEffect, useRef } from 'react';
import { SearchBox } from '@bench/components/SearchBox';
import { MultiSelectDropdown } from '@bench/components/MultiSelectDropdown';
import './filters.css';

/* ──────────────────────────────────────────────────────────────────────────
   Filter primitives — shared by Flows + Projects (and future list views).

   A filter state is a parsed token map plus free text:
     { tokens: { project: ['bench','api'], tag: ['mcp'] }, text: 'auth' }

   The single source of truth is the search-input string. Facet checkboxes
   and status pills read from the parsed state and write back by rebuilding
   the string. Query syntax follows Linear's convention:
     project:bench,api tag:mcp status:active free text here
   ──────────────────────────────────────────────────────────────────────── */

export interface FilterState {
  tokens: Record<string, string[]>;
  text: string;
}

export function parseFilter(q: string): FilterState {
  const tokens: Record<string, string[]> = {};
  const textParts: string[] = [];
  const parts = q.match(/(\w+:[^\s]+|\S+)/g) ?? [];
  for (const part of parts) {
    const m = part.match(/^(\w+):(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const values = m[2].split(',').map((v) => v.trim()).filter(Boolean);
      tokens[key] = (tokens[key] ?? []).concat(values);
    } else {
      textParts.push(part);
    }
  }
  return { tokens, text: textParts.join(' ') };
}

export function buildFilter(state: FilterState): string {
  const parts: string[] = [];
  for (const [key, values] of Object.entries(state.tokens)) {
    if (values.length) parts.push(`${key}:${values.join(',')}`);
  }
  if (state.text) parts.push(state.text);
  return parts.join(' ');
}

export function withToken(state: FilterState, key: string, value: string, on: boolean): FilterState {
  const current = state.tokens[key] ?? [];
  const next = on
    ? Array.from(new Set([...current, value]))
    : current.filter((v) => v !== value);
  const newTokens = { ...state.tokens };
  if (next.length) newTokens[key] = next;
  else delete newTokens[key];
  return { ...state, tokens: newTokens };
}

/* ── Search input ───────────────────────────────────────────────────── */

interface FilterSearchProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}

/** The page's search: bench's SearchBox (borderless pill, "/" to focus, clear button). */
export function FilterSearch({ value, onChange, placeholder, className }: FilterSearchProps) {
  return (
    <SearchBox
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? 'Search…  project:foo tag:bar status:active'}
      ariaLabel="Search"
      shortcut={['/']}
      expand
      className={`filter-search${className ? ` ${className}` : ''}`}
    />
  );
}

/* ── Token filter dropdown: bench's MultiSelectDropdown over a filter token ─ */
// Bench's dropdown treats "everything selected" as "no filter"; the platform's filter
// string treats "no token" as "no filter". This adapts one to the other.

export interface TokenFilterOption { value: string; label: string; count?: number }

export function TokenFilterDropdown({ label, options, selected, onChange }: {
  label: string;
  options: TokenFilterOption[];
  /** Values in the filter token ([] = no filter). */
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  if (options.length === 0) return null;
  const all = options.map((o) => o.value);
  return (
    <MultiSelectDropdown<string>
      label={label}
      options={options.map((o) => ({ value: o.value, label: o.count != null ? `${o.label} (${o.count})` : o.label }))}
      selected={new Set(selected.length ? selected : all)}
      onChange={(next) => onChange(next.size === 0 || next.size === all.length ? [] : all.filter((v) => next.has(v)))}
    />
  );
}

/* ── Sort toggle: bench's features sort control (features.css) ───────────── */

export function SortToggle<T extends string>({ options, value, dir, onChange }: {
  options: { id: T; label: string; defaultDir: 'asc' | 'desc' }[];
  value: T;
  dir: 'asc' | 'desc';
  onChange: (value: T, dir: 'asc' | 'desc') => void;
}) {
  return (
    <span className="sort-control">
      <span className="features-sort-label">Sort</span>
      <div className="features-sort-toggle" role="group" aria-label="Sort">
        {options.map((opt) => {
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              className={`features-sort-btn${active ? ' features-sort-btn-active' : ''}`}
              aria-pressed={active}
              aria-label={active ? `${opt.label}, ${dir === 'asc' ? 'ascending' : 'descending'}` : opt.label}
              onClick={() => active
                ? onChange(opt.id, dir === 'asc' ? 'desc' : 'asc')
                : onChange(opt.id, opt.defaultDir)}
            >
              {opt.label}
              {active && (
                <svg className="features-sort-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={dir === 'asc' ? 'M2 6.5L5 3.5L8 6.5' : 'M2 3.5L5 6.5L8 3.5'} />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </span>
  );
}

/* ── Facet group (left rail) ────────────────────────────────────────── */

export interface FacetItem {
  value: string;
  label: string;
  count: number;
}

interface FacetGroupProps {
  title: string;
  items: FacetItem[];
  selected: string[];
  onToggle: (value: string, on: boolean) => void;
  maxVisible?: number;
}

export function FacetGroup({ title, items, selected, onToggle, maxVisible = 6 }: FacetGroupProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, maxVisible);
  if (items.length === 0) return null;
  return (
    <div className="filter-facet">
      <div className="filter-facet-title">{title} <span className="filter-facet-total">({items.length})</span></div>
      <ul className="filter-facet-list">
        {visible.map((it) => {
          const on = selected.includes(it.value);
          return (
            <li key={it.value}>
              <label className={`filter-facet-row ${on ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => onToggle(it.value, e.target.checked)}
                />
                <span className="filter-facet-label">{it.label}</span>
                <span className="filter-facet-count">{it.count}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {items.length > maxVisible && (
        <button type="button" className="filter-facet-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '− show fewer' : `+ ${items.length - maxVisible} more`}
        </button>
      )}
    </div>
  );
}

/* ── Facet count computation ────────────────────────────────────────── */

// Given a list of items, the current filter state, and the facet key being
// rendered, compute counts as if every filter EXCEPT this facet's selection
// were applied. This yields the "narrow other facets but not this one" UX
// you expect from a faceted search.

export function computeFacetCounts<T>(
  items: T[],
  state: FilterState,
  facetKey: string,
  getValues: (item: T) => string[],
  match: (item: T, state: FilterState) => boolean,
  labelFor?: (value: string) => string,
): FacetItem[] {
  const filtered: FilterState = { ...state, tokens: { ...state.tokens } };
  delete filtered.tokens[facetKey];
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!match(item, filtered)) continue;
    for (const v of getValues(item)) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const list: FacetItem[] = [];
  for (const [value, count] of counts.entries()) {
    list.push({ value, count, label: labelFor ? labelFor(value) : value });
  }
  list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return list;
}


/* ── Tag input (chip editor) ────────────────────────────────────────── */
// Comma- and Enter-driven multi-tag input. Used for editing tags on flows
// and projects.

interface TagEditorProps {
  tags: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  readOnly?: boolean;
  suggestions?: string[];
}

export function TagEditor({ tags, onChange, placeholder, readOnly, suggestions }: TagEditorProps) {
  const [draft, setDraft] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function commit(value?: string) {
    const tag = (value ?? draft).trim().replace(/^#/, '');
    if (!tag) return;
    if (tags.includes(tag)) {
      setDraft('');
      setShowSuggestions(false);
      return;
    }
    onChange([...tags, tag]);
    setDraft('');
    setShowSuggestions(false);
  }

  function remove(t: string) {
    onChange(tags.filter((x) => x !== t));
  }

  const filteredSuggestions = suggestions
    ? suggestions.filter((s) => !tags.includes(s) && (draft === '' || s.toLowerCase().includes(draft.toLowerCase())))
    : [];

  return (
    <div className={`tag-editor ${readOnly ? 'readonly' : ''}`} style={{ position: 'relative' }}>
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          <span>#{t}</span>
          {!readOnly && (
            <button type="button" className="tag-chip-x" onClick={() => remove(t)} aria-label={`Remove ${t}`}>×</button>
          )}
        </span>
      ))}
      {!readOnly && (
        <>
          <input
            ref={inputRef}
            className="tag-editor-input"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setShowSuggestions(true); }}
            placeholder={tags.length === 0 ? (placeholder ?? '+ add tag') : '+ tag'}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') setShowSuggestions(false);
              if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
                remove(tags[tags.length - 1]);
              }
            }}
            onBlur={() => setTimeout(() => { commit(); setShowSuggestions(false); }, 150)}
          />
          {showSuggestions && filteredSuggestions.length > 0 && (
            <div className="tag-suggestions">
              {filteredSuggestions.slice(0, 8).map((s) => (
                <button
                  key={s}
                  type="button"
                  className="tag-suggestion-item"
                  onMouseDown={(e) => { e.preventDefault(); commit(s); }}
                >
                  #{s}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Owner input ────────────────────────────────────────────────────── */

interface OwnerEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

export function OwnerEditor({ value, onChange, placeholder, readOnly }: OwnerEditorProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  if (readOnly) {
    return value ? <span className="owner-chip">@{value}</span> : null;
  }

  return (
    <input
      className="owner-editor-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onChange(draft.trim()); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }}
      placeholder={placeholder ?? 'owner'}
    />
  );
}
