import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * Filters, options and searches live in the address, so any view can be linked, bookmarked,
 * reloaded and stepped through with Back and Forward.
 *
 * A page describes its state once, as a schema of named query parameters, and reads and sets
 * it with useQueryState:
 *
 *   const MAP_QUERY = { q: qp.string('q'), show: qp.oneOf('show', ['flows', 'all'], 'flows') };
 *   const [state, setState] = useQueryState(MAP_QUERY, pathQuery('/map'));
 *   setState({ show: 'all' })             // → /map?show=all
 *
 * The rules every page follows:
 *  - A value at its default is left out, so a plain address means the page's defaults.
 *  - Lists are comma-separated (kinds=interface,sink); a list that is present but empty means
 *    "none" (hide=), an absent one its default.
 *  - Changes replace the current history entry: typing and toggling don't pile up Back steps.
 *  - Back and Forward (and links that change only the query) are followed.
 *  - A field marked `remembered()` is kept in browser storage too (`remembered('session')`: for
 *    this tab's session only), and fills in when the address
 *    carries none of the page's parameters (the rail opens /map with your last filters, which
 *    then show in the address). An address that names any parameter is taken as the whole
 *    state: it is a link, and links mean the same thing for everyone.
 *  - Parameters the page doesn't own (the shell's ?folder=) are left as they are.
 *
 * The platform's pages keep their query after the path (pathQuery('/map')); the workbench keeps
 * it after its hash route (hashQuery('/findings') → #/findings?severity=high).
 */

export interface QueryField<T> {
  key: string;
  default: T;
  /** The value from the parameter's text, or undefined when it can't be read (→ default). */
  parse(raw: string): T | undefined;
  format(value: T): string;
  /** Also kept in browser storage, local or this session's (see above). */
  remember?: 'local' | 'session';
}

export type QuerySchema<S> = { [K in keyof S]: QueryField<S[K]> };

/** A field, which `.remembered()` also keeps in browser storage. */
export type QpField<T> = QueryField<T> & { remembered(storage?: 'local' | 'session'): QueryField<T> };

const csv = (raw: string) => raw.split(',').map((s) => s.trim()).filter(Boolean);

/** Field constructors. `.remembered()` marks a field to be kept in browser storage. */
export const qp = {
  string: (key: string, def = ''): QpField<string> => field({ key, default: def, parse: (s) => s, format: (s) => s }),
  bool: (key: string, def = false): QpField<boolean> => field({
    key, default: def,
    parse: (s) => (s === '1' || s === 'true' || s === '' ? true : s === '0' || s === 'false' ? false : undefined),
    format: (b) => (b ? '1' : '0'),
  }),
  int: (key: string, def: number, min = 0): QpField<number> => field({
    key, default: def,
    parse: (s) => { const n = Number(s); return Number.isInteger(n) && n >= min ? n : undefined; },
    format: (n) => String(n),
  }),
  oneOf: <T extends string>(key: string, values: readonly T[], def: T): QpField<T> => field({
    key, default: def,
    parse: (s) => (values as readonly string[]).includes(s) ? s as T : undefined,
    format: (v) => v,
  }),
  /** A subset of known values, kept in the values' own order (unknown ones are dropped). */
  set: <T extends string>(key: string, values: readonly T[], def: readonly T[] = values): QpField<T[]> => field({
    key, default: [...def],
    parse: (s) => { const got = new Set(csv(s)); return values.filter((v) => got.has(v)); },
    format: (list) => values.filter((v) => list.includes(v)).join(','),
  }),
  /** Free values (project slugs, sources), comma-separated. */
  list: (key: string, def: string[] = []): QpField<string[]> => field({
    key, default: def, parse: csv, format: (list) => list.join(','),
  }),
  /** Free values where null (the default, absent) means "all" and a present list narrows. */
  only: (key: string): QpField<string[] | null> => field<string[] | null>({
    key, default: null, parse: csv, format: (list) => (list ?? []).join(','),
  }),
};

function field<T>(f: QueryField<T>): QpField<T> {
  return { ...f, remembered: (storage = 'local') => ({ ...f, remember: storage }) };
}

function isDefault<T>(f: QueryField<T>, v: T): boolean {
  if (v === f.default) return true;
  if (v == null || f.default == null) return false;
  return f.format(v) === f.format(f.default);
}

/** Reads a state from the address's parameters. With none of the schema's keys present, the
 *  remembered values (else the defaults) apply. */
export function readQuery<S>(schema: QuerySchema<S>, params: URLSearchParams | null, remembered?: URLSearchParams | null): S {
  const fields = Object.entries(schema) as [keyof S, QueryField<unknown>][];
  const linked = !!params && fields.some(([, f]) => params.has(f.key));
  const out = {} as S;
  for (const [name, f] of fields) {
    const src = linked ? params : f.remember ? remembered : null;
    const raw = src?.get(f.key);
    out[name] = (raw == null ? f.default : f.parse(raw) ?? f.default) as S[keyof S];
  }
  return out;
}

/** The state's parameters merged into `params` (others kept): defaults dropped, the rest set. */
export function writeQuery<S>(schema: QuerySchema<S>, state: S, params = new URLSearchParams(), only?: (f: QueryField<unknown>) => boolean): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [name, f] of Object.entries(schema) as [keyof S, QueryField<unknown>][]) {
    if (only && !only(f)) continue;
    const v = state[name];
    if (isDefault(f, v)) next.delete(f.key);
    else next.set(f.key, f.format(v));
  }
  return next;
}

/** A query string that stays readable: commas, colons and slashes as they are, spaces as "+". */
export function formatQuery(params: URLSearchParams): string {
  const parts: string[] = [];
  params.forEach((v, k) => {
    const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%40/g, '@').replace(/%20/g, '+');
    parts.push(`${enc(k)}=${enc(v)}`);
  });
  return parts.join('&');
}

/** Where a page's query lives in the address. */
export interface QueryLocation {
  /** The page's parameters, or null when the address is not this page's. */
  read(): URLSearchParams | null;
  /** Replace the page's query (no-op when the address is not this page's). */
  write(params: URLSearchParams): void;
  /** Called when the address changes under the page (Back, Forward, a link). */
  subscribe(cb: () => void): () => void;
}

function replaceUrl(url: string) {
  window.history.replaceState(window.history.state, '', url);
}

/** The query after a path: /map?show=all. */
export function pathQuery(pathname: string): QueryLocation {
  const mine = () => window.location.pathname === pathname;
  return {
    read: () => (mine() ? new URLSearchParams(window.location.search) : null),
    write: (params) => {
      if (!mine()) return;
      const qs = formatQuery(params);
      const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      if (url !== window.location.pathname + window.location.search + window.location.hash) replaceUrl(url);
    },
    subscribe: (cb) => { window.addEventListener('popstate', cb); return () => window.removeEventListener('popstate', cb); },
  };
}

/** Splits a hash into its route and query: "#/findings?severity=high" → ["#/findings", "severity=high"]. */
export function splitHash(hash: string): [string, string] {
  const at = hash.indexOf('?');
  return at < 0 ? [hash, ''] : [hash.slice(0, at), hash.slice(at + 1)];
}

/** The query after a hash route: #/findings?severity=high (also under #/findings/…). */
export function hashQuery(route: string): QueryLocation {
  const mine = (path: string) => { const p = path.replace(/^#/, ''); return p === route || p.startsWith(`${route}/`); };
  return {
    read: () => {
      const [path, qs] = splitHash(window.location.hash);
      return mine(path) ? new URLSearchParams(qs) : null;
    },
    write: (params) => {
      const [path, current] = splitHash(window.location.hash);
      if (!mine(path)) return;
      const qs = formatQuery(params);
      if (qs === current) return;
      replaceUrl(window.location.pathname + window.location.search + path + (qs ? `?${qs}` : ''));
    },
    subscribe: (cb) => {
      window.addEventListener('popstate', cb);
      window.addEventListener('hashchange', cb);
      return () => { window.removeEventListener('popstate', cb); window.removeEventListener('hashchange', cb); };
    },
  };
}

const store = (where: 'local' | 'session') => (where === 'local' ? localStorage : sessionStorage);

/** The remembered values: the page's entry in local storage, then its entry in this session's. */
function loadRemembered(key: string | undefined): URLSearchParams | null {
  if (!key) return null;
  const out = new URLSearchParams();
  for (const where of ['local', 'session'] as const) {
    try { new URLSearchParams(store(where).getItem(key) ?? '').forEach((v, k) => out.set(k, v)); } catch { /* unavailable */ }
  }
  return out;
}

/**
 * A page's state, read from and written to the address (see the top of this file). `schema` and
 * `where` must be stable (module constants). `remember.key` names the storage entry for fields
 * marked remembered.
 */
export function useQueryState<S>(
  schema: QuerySchema<S>,
  where: QueryLocation,
  remember?: { key: string },
): [S, (patch: Partial<S> | ((s: S) => Partial<S>)) => void] {
  const read = useCallback(() => readQuery(schema, where.read(), loadRemembered(remember?.key)), [schema, where, remember?.key]);
  const [state, setState] = useState<S>(read);
  const stateRef = useRef(state);
  stateRef.current = state;

  // The address follows the state. This runs after every render, not only when the state
  // changes: when the shell swaps the address under a page that stays mounted (a folder link
  // that drops the query), the page's query is put back.
  useEffect(() => {
    const params = where.read();
    if (params) where.write(writeQuery(schema, state, params));
  });

  // The state follows the address when it moves under the page.
  useEffect(() => where.subscribe(() => {
    if (!where.read()) return;
    const next = read();
    if (formatQuery(writeQuery(schema, next)) !== formatQuery(writeQuery(schema, stateRef.current))) setState(next);
  }), [where, read, schema]);

  const update = useCallback((patch: Partial<S> | ((s: S) => Partial<S>)) => {
    const next = { ...stateRef.current, ...(typeof patch === 'function' ? patch(stateRef.current) : patch) };
    stateRef.current = next;
    setState(next);
    if (remember?.key) {
      for (const where of ['local', 'session'] as const) {
        const fields = Object.values(schema as Record<string, QueryField<unknown>>).filter((f) => f.remember === where);
        if (!fields.length) continue;
        try {
          store(where).setItem(remember.key, formatQuery(writeQuery(schema, next, undefined, (f) => f.remember === where)));
        } catch { /* not remembered */ }
      }
    }
  }, [schema, remember?.key]);

  return [state, update];
}
