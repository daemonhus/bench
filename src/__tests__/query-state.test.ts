import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { qp, readQuery, writeQuery, formatQuery, useQueryState, pathQuery, hashQuery, type QuerySchema } from '../core/query-state';
import { parseRoute } from '../core/router';
import { mount, act } from './helpers/mount';

// Newer Node versions define an (unusable) global localStorage that shadows jsdom's.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
});

const KINDS = ['call', 'read', 'write'] as const;
interface S { q: string; kinds: (typeof KINDS)[number][]; hide: string[]; internal: boolean; page: number; show: 'flows' | 'all'; source: string[] | null }
const SCHEMA: QuerySchema<S> = {
  q: qp.string('q'),
  kinds: qp.set('kinds', KINDS),
  hide: qp.list('hide').remembered(),
  internal: qp.bool('internal'),
  page: qp.int('page', 1, 1),
  show: qp.oneOf('show', ['flows', 'all'] as const, 'flows').remembered(),
  source: qp.only('source'),
};
const DEFAULTS: S = { q: '', kinds: ['call', 'read', 'write'], hide: [], internal: false, page: 1, show: 'flows', source: null };

describe('readQuery / writeQuery', () => {
  it('an empty address is the defaults, and the defaults write nothing', () => {
    expect(readQuery(SCHEMA, new URLSearchParams(''))).toEqual(DEFAULTS);
    expect(formatQuery(writeQuery(SCHEMA, DEFAULTS))).toBe('');
  });

  it('round-trips every kind of field, readably', () => {
    const s: S = { q: 'auth token', kinds: ['write', 'call'], hide: ['beta', 'gamma'], internal: true, page: 3, show: 'all', source: ['mcp'] };
    const qs = formatQuery(writeQuery(SCHEMA, s));
    expect(qs).toBe('q=auth+token&kinds=call,write&hide=beta,gamma&internal=1&page=3&show=all&source=mcp');
    expect(readQuery(SCHEMA, new URLSearchParams(qs))).toEqual({ ...s, kinds: ['call', 'write'] });
  });

  it('a present but empty list means none; an absent one its default', () => {
    expect(readQuery(SCHEMA, new URLSearchParams('kinds=')).kinds).toEqual([]);
    expect(readQuery(SCHEMA, new URLSearchParams('source=')).source).toEqual([]);
    expect(formatQuery(writeQuery(SCHEMA, { ...DEFAULTS, kinds: [] }))).toBe('kinds=');
  });

  it('unreadable values fall back to the default; unknown set members are dropped', () => {
    const s = readQuery(SCHEMA, new URLSearchParams('page=zero&show=sideways&kinds=read,bogus&internal=maybe'));
    expect(s).toMatchObject({ page: 1, show: 'flows', kinds: ['read'], internal: false });
  });

  it('keeps parameters the page does not own', () => {
    const merged = writeQuery(SCHEMA, { ...DEFAULTS, q: 'x' }, new URLSearchParams('folder=f1&q=old&internal=1'));
    expect(formatQuery(merged)).toBe('folder=f1&q=x');
  });

  it('remembered values fill in only when the address names none of the page\'s parameters', () => {
    const remembered = new URLSearchParams('hide=beta&show=all&q=ignored');
    expect(readQuery(SCHEMA, new URLSearchParams(''), remembered)).toMatchObject({ hide: ['beta'], show: 'all', q: '' });
    // A link is the whole state: absent parameters are defaults, not the viewer's own.
    expect(readQuery(SCHEMA, new URLSearchParams('internal=1'), remembered)).toMatchObject({ hide: [], show: 'flows', internal: true });
  });
});

describe('parseRoute with a query', () => {
  it('reads the route before the query', () => {
    expect(parseRoute('#/findings?severity=high')).toEqual({ mode: 'findings' });
    expect(parseRoute('#/findings/feature/f1?severity=high')).toEqual({ mode: 'findings', featureFilterId: 'f1' });
    expect(parseRoute('#/features?tab=sinks')).toEqual({ mode: 'features' });
  });
});

const MAP = pathQuery('/map');
const FINDINGS = hashQuery('/findings');
const SMALL: QuerySchema<Pick<S, 'q' | 'show'>> = { q: SCHEMA.q, show: SCHEMA.show };

function Probe({ where, out }: { where: typeof MAP; out: { state?: Pick<S, 'q' | 'show'>; set?: (p: Partial<Pick<S, 'q' | 'show'>>) => void } }) {
  const [state, set] = useQueryState(SMALL, where, { key: 'probe-query' });
  out.state = state; out.set = set;
  return createElement('span', null, state.q);
}

describe('useQueryState', () => {
  beforeEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/'); });

  it('reads the address, writes changes back (replacing), and keeps other parameters', () => {
    window.history.replaceState(null, '', '/map?folder=f1&show=all');
    const out: Parameters<typeof Probe>[0]['out'] = {};
    const m = mount(createElement(Probe, { where: MAP, out }));
    expect(out.state).toEqual({ q: '', show: 'all' });
    const before = window.history.length;
    act(() => out.set!({ q: 'login' }));
    expect(window.location.search).toBe('?folder=f1&show=all&q=login');
    act(() => out.set!({ show: 'flows' }));
    expect(window.location.search).toBe('?folder=f1&q=login');
    expect(window.history.length).toBe(before);
    m.unmount();
  });

  it('remembers marked fields and puts them in a bare address', () => {
    window.history.replaceState(null, '', '/map');
    const out: Parameters<typeof Probe>[0]['out'] = {};
    let m = mount(createElement(Probe, { where: MAP, out }));
    act(() => out.set!({ show: 'all', q: 'x' }));
    m.unmount();
    window.history.replaceState(null, '', '/map');
    m = mount(createElement(Probe, { where: MAP, out }));
    expect(out.state).toEqual({ q: '', show: 'all' });
    expect(window.location.search).toBe('?show=all');
    m.unmount();
  });

  it('follows Back and Forward', () => {
    window.history.replaceState(null, '', '/map?q=one');
    const out: Parameters<typeof Probe>[0]['out'] = {};
    const m = mount(createElement(Probe, { where: MAP, out }));
    window.history.replaceState(null, '', '/map?q=two');
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(out.state!.q).toBe('two');
    m.unmount();
  });

  it('puts its query back when the address is swapped under it', () => {
    window.history.replaceState(null, '', '/map?q=keep');
    const out: Parameters<typeof Probe>[0]['out'] = {};
    const m = mount(createElement(Probe, { where: MAP, out }));
    window.history.pushState(null, '', '/map?folder=f2');
    m.rerender(createElement(Probe, { where: MAP, out }));
    expect(window.location.search).toBe('?folder=f2&q=keep');
    m.unmount();
  });

  it('a hash route keeps its query after the route, and leaves other routes alone', () => {
    window.history.replaceState(null, '', '/p/alpha#/findings/feature/f1');
    const out: Parameters<typeof Probe>[0]['out'] = {};
    const m = mount(createElement(Probe, { where: FINDINGS, out }));
    act(() => out.set!({ q: 'xss' }));
    expect(window.location.hash).toBe('#/findings/feature/f1?q=xss');
    window.history.replaceState(null, '', '/p/alpha#/overview');
    act(() => out.set!({ q: 'csrf' }));
    expect(window.location.hash).toBe('#/overview');
    m.unmount();
  });
});
