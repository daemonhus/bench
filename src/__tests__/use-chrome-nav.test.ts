import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { useChromeNav } from '../hooks/useChromeNav';
import { mount, act } from './helpers/mount';

// U9: F6 jumps to the toolbar group, arrows step, Escape/F6 go back.

function Page() {
  useChromeNav();
  return createElement('div', null,
    createElement('div', { 'data-chrome': '', id: 'bar' },
      createElement('button', { id: 't1', className: 'tab-bar-tab' }, 'one'),
      createElement('button', { id: 't2', className: 'tab-bar-tab tab-bar-tab-active' }, 'two'),
      createElement('button', { id: 't3', className: 'tab-bar-tab' }, 'three'),
    ),
    createElement('button', { 'data-chrome': '', id: 'lone' }, 'carries the marker itself'),
    createElement('button', { className: 'shortcuts-fab', id: 'fab' }, 'fab'),
    createElement('div', { 'data-nav-area': 'list', tabIndex: 0, id: 'area' }, createElement('input', { id: 'field' })),
  );
}

const press = (k: string, init: KeyboardEventInit = {}) => {
  const target = document.activeElement ?? document.body;
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(e); });
  return e;
};

describe('useChromeNav (U9)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mount(createElement(Page));
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
    }
    (document.getElementById('area') as HTMLElement).focus();
  });

  it('F6 focuses the active tab (and stops the browser moving to the address bar)', () => {
    const e = press('F6');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('t2');
  });

  it('Left/Right/Home/End walk every control, groups and the shortcuts button included, without wrapping', () => {
    press('F6');
    press('Home');
    expect(document.activeElement?.id).toBe('t1');
    const seen = ['t1'];
    for (let i = 0; i < 10; i++) { press('ArrowRight'); const id = document.activeElement!.id; if (id === seen[seen.length - 1]) break; seen.push(id); }
    expect(seen).toEqual(['t1', 't2', 't3', 'lone', 'fab']);
    press('ArrowLeft');
    expect(document.activeElement?.id).toBe('lone');
    press('End');
    expect(document.activeElement?.id).toBe('fab');
    press('Home');
    press('ArrowLeft'); // clamps at the start
    expect(document.activeElement?.id).toBe('t1');
  });

  it('Escape and a second F6 return to the element that had focus, including a text field', () => {
    (document.getElementById('field') as HTMLElement).focus();
    press('F6');
    expect(document.activeElement?.id).toBe('t2');
    press('Escape');
    expect(document.activeElement?.id).toBe('field');
    press('F6');
    press('F6');
    expect(document.activeElement?.id).toBe('field');
  });

  it('ignores arrows outside the toolbar and modified F6', () => {
    (document.getElementById('area') as HTMLElement).focus();
    const e = press('ArrowRight');
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe('area');
    press('F6', { ctrlKey: true });
    expect(document.activeElement?.id).toBe('area');
  });

  it('with nothing focused, F6 then Escape falls back to the first nav area', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    press('F6');
    expect(document.activeElement?.id).toBe('t2');
    press('Escape');
    expect(document.activeElement?.id).toBe('area');
  });
});
