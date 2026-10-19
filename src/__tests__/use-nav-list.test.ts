import { describe, it, expect, beforeEach } from 'vitest';
import { resolveNavId, isFocusLeaving, cardActions, firstVisibleNavId } from '../core/use-nav-list';

// resolveNavId is the DOM-walking primitive behind useNavList's focus and
// pointer-down handlers - it's what makes "click a card or type into one of
// its inputs" become the anchor for subsequent arrow-key navigation.

function buildList(ids: string[]): { container: HTMLElement; cards: HTMLElement[] } {
  const container = document.createElement('div');
  container.setAttribute('data-nav-area', 'test');
  const cards = ids.map((id) => {
    const card = document.createElement('div');
    card.setAttribute('data-nav-id', id);
    // Each card contains a textarea (reply input) and a button (action).
    const textarea = document.createElement('textarea');
    const button = document.createElement('button');
    button.textContent = 'edit';
    // Nested label span for the "click on a non-focusable element" case.
    const label = document.createElement('span');
    label.className = 'meta';
    label.textContent = `label-${id}`;
    card.append(textarea, button, label);
    container.appendChild(card);
    return card;
  });
  document.body.appendChild(container);
  return { container, cards };
}

describe('resolveNavId', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the id of the card containing the event target', () => {
    const { container, cards } = buildList(['a', 'b', 'c']);
    const textareaB = cards[1].querySelector('textarea')!;
    expect(resolveNavId(textareaB, container)).toBe('b');
  });

  it('resolves through deeply nested non-focusable elements', () => {
    const { container, cards } = buildList(['a', 'b']);
    const label = cards[0].querySelector('.meta')!;
    expect(resolveNavId(label, container)).toBe('a');
  });

  it('returns the card id when the card itself is the target', () => {
    const { container, cards } = buildList(['only']);
    expect(resolveNavId(cards[0], container)).toBe('only');
  });

  it('returns null when the event target is the container itself', () => {
    const { container } = buildList(['a']);
    expect(resolveNavId(container, container)).toBeNull();
  });

  it('returns null when the target is outside the container', () => {
    const { container } = buildList(['a']);
    const outside = document.createElement('div');
    outside.setAttribute('data-nav-id', 'stray');
    document.body.appendChild(outside);
    expect(resolveNavId(outside, container)).toBeNull();
  });

  it('returns null when a [data-nav-id] ancestor exists outside the container', () => {
    // Nested list scenario: an outer list with its own anchor wraps the
    // container we care about. resolveNavId must scope to the inner container.
    const outer = document.createElement('div');
    outer.setAttribute('data-nav-id', 'outer-card');
    const inner = document.createElement('div');
    outer.appendChild(inner);
    document.body.appendChild(outer);
    const probe = document.createElement('span');
    inner.appendChild(probe);
    expect(resolveNavId(probe, inner)).toBeNull();
  });

  it('handles null target gracefully', () => {
    const { container } = buildList(['a']);
    expect(resolveNavId(null, container)).toBeNull();
  });

  it('handles null container gracefully', () => {
    const { cards } = buildList(['a']);
    expect(resolveNavId(cards[0], null)).toBeNull();
  });

  it('switches anchor when the user clicks into a different card', () => {
    // Behavioural assertion: this is the regression the change fixes - after
    // interacting with card b, resolveNavId reports 'b' instead of whatever
    // the previous anchor was.
    const { container, cards } = buildList(['a', 'b', 'c']);
    // Initial click on card a's textarea.
    expect(resolveNavId(cards[0].querySelector('textarea'), container)).toBe('a');
    // User then clicks the edit button on card c.
    expect(resolveNavId(cards[2].querySelector('button'), container)).toBe('c');
    // And types into the same card's textarea.
    expect(resolveNavId(cards[2].querySelector('textarea'), container)).toBe('c');
  });
});

// isFocusLeaving decides whether the nav anchor survives a focusout. The focus
// ring marks where arrow-keying would resume, so it has to clear the moment the
// user's focus moves to a filter, a tab, or anywhere else outside the list.
describe('isFocusLeaving', () => {
  let container: HTMLElement;
  let cards: HTMLElement[];

  beforeEach(() => {
    ({ container, cards } = buildList(['a', 'b']));
  });

  it('keeps the anchor when focus moves to another element inside the list', () => {
    const textarea = cards[0].querySelector('textarea')!;
    expect(isFocusLeaving(textarea, container)).toBe(false);
  });

  it('keeps the anchor when focus moves between cards', () => {
    expect(isFocusLeaving(cards[1], container)).toBe(false);
  });

  it('drops the anchor when focus moves to a control outside the list', () => {
    const filter = document.createElement('button');
    document.body.appendChild(filter);
    expect(isFocusLeaving(filter, container)).toBe(true);
  });

  it('drops the anchor when focus goes nowhere (clicking blank space)', () => {
    expect(isFocusLeaving(null, container)).toBe(true);
  });

  it('does nothing without a container', () => {
    expect(isFocusLeaving(null, null)).toBe(false);
  });
});

// ── U1 / U2: the hook's focus + pointer handlers, driven with real DOM events ──
import { createElement, type RefObject } from 'react';
import { useNavList } from '../core/use-nav-list';
import { mount, act } from './helpers/mount';

interface Probe { focusedId: string | null }

function NavListFixture({ ids, probe }: { ids: string[]; probe: Probe }) {
  const nav = useNavList({ items: ids, getId: (i) => i });
  probe.focusedId = nav.focusedId;
  return createElement(
    'div',
    {
      ref: nav.containerRef as RefObject<HTMLDivElement>,
      tabIndex: 0,
      'data-nav-area': 'fixture',
      onKeyDown: nav.handleKeyDown,
      onFocus: nav.handleFocus,
      onBlur: nav.handleBlur,
      onMouseDown: nav.handlePointerDown,
    },
    ids.map((id) =>
      createElement('div', { key: id, 'data-nav-id': id },
        createElement('textarea', { 'data-t': id }),
        createElement('button', { 'data-b': id }, 'act'),
        createElement('span', { className: 'meta', 'data-s': id }, `label ${id}`),
      ),
    ),
  );
}

describe('useNavList focus/pointer handlers (U1, U2)', () => {
  let probe: Probe;
  let container: HTMLElement;
  const q = (sel: string) => container.querySelector(sel) as HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    probe = { focusedId: null };
    const m = mount(createElement(NavListFixture, { ids: ['a', 'b', 'c'], probe }));
    container = m.host.firstElementChild as HTMLElement;
  });

  const focusOut = (from: HTMLElement, to: HTMLElement | null) =>
    act(() => { from.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: to })); });

  it('U1: focusing a card input anchors that card; moving within the card keeps it', () => {
    act(() => q('[data-t="b"]').focus());
    expect(probe.focusedId).toBe('b');
    act(() => q('[data-b="b"]').focus()); // textarea -> its own button
    expect(probe.focusedId).toBe('b');
    focusOut(q('[data-t="b"]'), q('[data-b="b"]'));
    expect(probe.focusedId).toBe('b');
  });

  it('U1: focus leaving the list (to an outside element or nowhere) drops the anchor', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    act(() => q('[data-t="b"]').focus());
    expect(probe.focusedId).toBe('b');
    focusOut(q('[data-t="b"]'), outside);
    expect(probe.focusedId).toBeNull();

    act(() => q('[data-t="c"]').focus());
    expect(probe.focusedId).toBe('c');
    focusOut(q('[data-t="c"]'), null); // click on blank space: relatedTarget null
    expect(probe.focusedId).toBeNull();
  });

  it('U1: focus on a non-card child (e.g. a draft form field) does not seed an anchor', () => {
    const draft = document.createElement('textarea'); // sibling of the cards, inside the container
    container.appendChild(draft);
    act(() => draft.focus());
    expect(probe.focusedId).toBeNull();
  });

  it('U1: focus arriving on the container from outside seeds the first item', () => {
    act(() => container.focus());
    expect(probe.focusedId).toBe('a');
  });

  it('U2: mousedown on a non-focusable part of a card anchors that card', () => {
    act(() => { q('[data-s="c"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(probe.focusedId).toBe('c');
    act(() => { q('[data-s="a"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(probe.focusedId).toBe('a');
  });

  it('U2: mousedown on the container background does not change the anchor', () => {
    act(() => { q('[data-s="b"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(probe.focusedId).toBe('b');
    act(() => { container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(probe.focusedId).toBe('b');
  });
});


// ── U5: card controls reachable from the item (Left/Right) ─────────────────────
describe('cardActions', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('lists buttons, links, selects and role=button; skips text fields, disabled and hidden controls', () => {
    const card = document.createElement('div');
    card.innerHTML = `
      <select id="s"><option>a</option></select>
      <button id="b1">one</button>
      <button id="dis" disabled>x</button>
      <a id="a1" href="#x">link</a>
      <span id="rb" role="button" tabindex="0">fake</span>
      <span id="nb" role="button">not tabbable</span>
      <textarea id="t"></textarea>
      <input id="i" type="text">
      <input id="h" type="hidden">`;
    document.body.appendChild(card);
    // jsdom has no layout: getClientRects() is empty for everything, so make elements "rendered".
    for (const el of Array.from(card.querySelectorAll<HTMLElement>('*'))) {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
    }
    expect(cardActions(card).map((e) => e.id)).toEqual(['s', 'b1', 'a1', 'rb']);
  });

  it('returns nothing for a missing card and skips controls that are not rendered', () => {
    expect(cardActions(null)).toEqual([]);
    const card = document.createElement('div');
    card.innerHTML = '<button id="hidden">x</button>'; // no client rects in jsdom == not rendered
    document.body.appendChild(card);
    expect(cardActions(card)).toEqual([]);
  });
});

describe('useNavList card-control keys (U5)', () => {
  let probe: { focusedId: string | null };
  let container: HTMLElement;
  const key = (target: HTMLElement, k: string) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

  beforeEach(() => {
    document.body.innerHTML = '';
    probe = { focusedId: null };
    const m = mount(createElement(NavListFixture, { ids: ['a', 'b'], probe }));
    container = m.host.firstElementChild as HTMLElement;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
      Object.defineProperty(el, 'getClientRects', { configurable: true, value: () => [{}] });
    }
  });

  it('ArrowRight on the focused item moves focus to its first control; Left returns; Escape keeps the anchor', () => {
    act(() => container.focus()); // seeds item a
    expect(probe.focusedId).toBe('a');
    key(container, 'ArrowRight');
    expect(document.activeElement).toBe(container.querySelector('[data-b="a"]'));
    key(document.activeElement as HTMLElement, 'ArrowLeft'); // first control -> back to the item
    expect(document.activeElement).toBe(container);
    key(container, 'ArrowRight');
    key(document.activeElement as HTMLElement, 'Escape');
    expect(document.activeElement).toBe(container);
    expect(probe.focusedId).toBe('a');
  });

  it('ArrowRight does nothing without an anchor, and never leaves the card', () => {
    key(container, 'ArrowRight'); // no focusedId yet
    expect(document.activeElement).not.toBe(container.querySelector('[data-b="a"]'));
    act(() => container.focus());
    key(container, 'ArrowRight');
    const btn = document.activeElement as HTMLElement;
    key(btn, 'ArrowRight'); // only one control in the fixture card: stays put
    expect(document.activeElement).toBe(btn);
  });
});

describe('firstVisibleNavId', () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  it('picks the first card on screen, so re-entering a scrolled list does not jump', () => {
    const container = document.createElement('div');
    const cards = ['a', 'b', 'c'].map((id) => { const el = document.createElement('div'); el.setAttribute('data-nav-id', id); container.appendChild(el); return el; });
    container.getBoundingClientRect = () => rect(0, 600);
    cards[0].getBoundingClientRect = () => rect(-900, -300); // scrolled past
    cards[1].getBoundingClientRect = () => rect(-300, 200);  // partly on screen
    cards[2].getBoundingClientRect = () => rect(200, 700);
    expect(firstVisibleNavId(container)).toBe('b');
  });
  it('gives null when nothing is laid out (the caller falls back to the first item)', () => {
    const container = document.createElement('div');
    const el = document.createElement('div'); el.setAttribute('data-nav-id', 'a'); container.appendChild(el);
    expect(firstVisibleNavId(container)).toBeNull();
  });
});
