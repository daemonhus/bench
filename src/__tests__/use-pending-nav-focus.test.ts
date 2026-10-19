import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { usePendingNavFocus } from '../hooks/usePendingNavFocus';
import { mount, act } from './helpers/mount';

// U4 (regression for M7): a tab switch asks for focus on an area that may not
// be mounted yet. The request must be honoured when the area appears, and
// dropped if the user clicks or types elsewhere first.

function Probe({ area, clear, onFocused }: { area: string | null; clear: () => void; onFocused?: () => void }) {
  usePendingNavFocus(area, clear, 'view', onFocused);
  return null;
}

function addArea(name: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-nav-area', name);
  el.tabIndex = 0;
  document.body.appendChild(el);
  return el;
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

describe('usePendingNavFocus', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('focuses an area that is already mounted, immediately', () => {
    const el = addArea('findings-filter');
    const clear = vi.fn();
    const onFocused = vi.fn();
    mount(createElement(Probe, { area: 'findings-filter', clear, onFocused }));
    expect(document.activeElement).toBe(el);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it('focuses a late-mounting area once it appears', async () => {
    const clear = vi.fn();
    mount(createElement(Probe, { area: 'delta-header', clear }));
    expect(clear).not.toHaveBeenCalled();
    const el = addArea('delta-header');
    await flush();
    expect(document.activeElement).toBe(el);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  for (const type of ['pointerdown', 'keydown'] as const) {
    it(`drops the request when the user acts first (${type}); a later mount does not steal focus`, async () => {
      const other = document.createElement('input');
      document.body.appendChild(other);
      other.focus();
      const clear = vi.fn();
      mount(createElement(Probe, { area: 'features-tabs', clear }));

      document.dispatchEvent(new Event(type, { bubbles: true }));
      expect(clear).toHaveBeenCalledTimes(1);

      addArea('features-tabs');
      await flush();
      expect(document.activeElement).toBe(other);
    });
  }

  it('stops watching after unmount', async () => {
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    const clear = vi.fn();
    const m = mount(createElement(Probe, { area: 'findings-filter', clear }));
    m.unmount();
    addArea('findings-filter');
    await flush();
    expect(document.activeElement).toBe(other);
    expect(clear).not.toHaveBeenCalled();
  });

  it('does nothing when there is no pending area', () => {
    const el = addArea('x');
    const clear = vi.fn();
    mount(createElement(Probe, { area: null, clear }));
    expect(document.activeElement).not.toBe(el);
    expect(clear).not.toHaveBeenCalled();
  });
});
