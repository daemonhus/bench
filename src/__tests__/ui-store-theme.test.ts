import { describe, it, expect, vi, beforeAll } from 'vitest';

// Newer Node versions define an (unusable) global localStorage that shadows jsdom's: provide a
// plain in-memory one before the store module reads it at import time.
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
});

// The store also reads a media query at import time; jsdom has no matchMedia.
vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
window.matchMedia = globalThis.matchMedia;

let useUIStore: typeof import('../stores/ui-store').useUIStore;
beforeAll(async () => { ({ useUIStore } = await import('../stores/ui-store')); });

// The theme is one setting shared by the workbench and (embedded) the platform shell.
describe('ui-store theme', () => {
  it('toggleTheme flips and persists', () => {
    useUIStore.setState({ theme: 'dark' });
    useUIStore.getState().toggleTheme();
    expect(useUIStore.getState().theme).toBe('light');
    expect(localStorage.getItem('bench-theme')).toBe('light');
    useUIStore.getState().toggleTheme();
    expect(useUIStore.getState().theme).toBe('dark');
    expect(localStorage.getItem('bench-theme')).toBe('dark');
  });

  const storage = (newValue: string | null, key = 'bench-theme') =>
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));

  it('a theme change in another tab (storage event) updates the store', () => {
    useUIStore.setState({ theme: 'dark' });
    storage('light');
    expect(useUIStore.getState().theme).toBe('light');
    storage('dark');
    expect(useUIStore.getState().theme).toBe('dark');
  });

  it('ignores other keys, and falls back to dark for a cleared or unexpected value', () => {
    useUIStore.setState({ theme: 'light' });
    storage('dark', 'something-else');
    expect(useUIStore.getState().theme).toBe('light');
    storage(null); // key removed
    expect(useUIStore.getState().theme).toBe('dark');
    useUIStore.setState({ theme: 'light' });
    storage('solarized');
    expect(useUIStore.getState().theme).toBe('dark');
  });
});
