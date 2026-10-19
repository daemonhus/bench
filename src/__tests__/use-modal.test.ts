import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement, StrictMode } from 'react';
import { useModal } from '../hooks/useModal';
import { mount, act } from './helpers/mount';

// U8: dialog focus management - restore on close, focus in on open, Tab trap,
// local Escape, and reclaiming focus when the focused control is removed.

function Dialog({ onClose, withInput, extra }: { onClose: () => void; withInput?: boolean; extra?: boolean }) {
  const modal = useModal<HTMLDivElement>({ label: 'Test dialog', onClose });
  return createElement('div', { ...modal.props, 'data-dialog': '' },
    createElement('button', { id: 'first' }, 'first'),
    withInput ? createElement('input', { id: 'inp', autoFocus: true }) : null,
    extra ? createElement('button', { id: 'extra' }, 'extra') : null,
    createElement('button', { id: 'last' }, 'last'),
  );
}

const rendered = () => {
  // jsdom has no layout: report every element as rendered so the trap can see them.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
  }
};
const key = (target: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(e); });
  return e;
};

describe('useModal (U8)', () => {
  let opener: HTMLButtonElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();
  });

  it('exposes dialog semantics', () => {
    const m = mount(createElement(Dialog, { onClose: () => {} }));
    const d = document.querySelector('[data-dialog]')!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-label')).toBe('Test dialog');
    m.unmount();
  });

  const flush = () => act(async () => { await Promise.resolve(); });

  it('moves focus in on open, and back to the opener on close', async () => {
    const m = mount(createElement(Dialog, { onClose: () => {} }));
    rendered();
    expect(document.querySelector('[data-dialog]')!.contains(document.activeElement)).toBe(true);
    m.unmount();
    await flush(); // the restore is a microtask (so React StrictMode's fake unmount can cancel it)
    expect(document.activeElement).toBe(opener);
  });

  it('StrictMode (dev double mount) neither steals focus back to the opener nor skips the autofocused field', async () => {
    const m = mount(createElement(StrictMode, null, createElement(Dialog, { onClose: () => {}, withInput: true })));
    await flush();
    expect(document.activeElement?.id).toBe('inp');
    m.unmount();
    await flush();
    expect(document.activeElement).toBe(opener);
  });

  it('a close that already moved focus elsewhere (e.g. into the code) is not overridden by the restore', async () => {
    const elsewhere = document.createElement('button');
    elsewhere.id = 'elsewhere';
    document.body.appendChild(elsewhere);
    const m = mount(createElement(Dialog, { onClose: () => {} }));
    m.unmount();
    elsewhere.focus(); // what App does after choosing a search result
    await flush();
    expect(document.activeElement?.id).toBe('elsewhere');
  });

  it('an autofocused field inside wins over the default first-control focus', () => {
    const m = mount(createElement(Dialog, { onClose: () => {}, withInput: true }));
    expect(document.activeElement?.id).toBe('inp');
    m.unmount();
  });

  it('Tab at the last control wraps to the first, Shift+Tab at the first wraps to the last', () => {
    const m = mount(createElement(Dialog, { onClose: () => {} }));
    rendered();
    (document.getElementById('last') as HTMLElement).focus();
    const fwd = key(document.getElementById('last')!, 'Tab');
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('first');
    const back = key(document.getElementById('first')!, 'Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('last');
    m.unmount();
  });

  it('Escape closes via onClose, unless a nested control already handled it', () => {
    const onClose = vi.fn();
    const m = mount(createElement(Dialog, { onClose }));
    rendered();
    key(document.getElementById('first')!, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => { document.getElementById('first')!.dispatchEvent(handled); });
    expect(onClose).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('reclaims focus when the focused control is removed (no focusout fires for removals)', async () => {
    const m = mount(createElement(Dialog, { onClose: () => {}, extra: true }));
    rendered();
    (document.getElementById('extra') as HTMLElement).focus();
    expect(document.activeElement?.id).toBe('extra');
    m.rerender(createElement(Dialog, { onClose: () => {}, extra: false })); // removes the focused button
    await act(async () => { await Promise.resolve(); }); // MutationObserver is a microtask
    expect(document.querySelector('[data-dialog]')).toBe(document.activeElement);
    m.unmount();
  });
});
