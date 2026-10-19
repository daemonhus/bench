import { createRoot } from 'react-dom/client';
import { act, type ReactElement } from 'react';

// React 18 needs this flag for act() outside a test renderer.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape (browsers do); the nav-list code uses it in selectors.
if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
  (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
    escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
  };
}

// jsdom has no scrollIntoView; the nav-list scrolls the focused card in a rAF.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

/** Minimal render helper (no @testing-library): mounts into document.body. */
export function mount(el: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return {
    host,
    rerender: (next: ReactElement) => act(() => root.render(next)),
    unmount: () => { act(() => root.unmount()); host.remove(); },
  };
}

export { act };
