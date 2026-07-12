import { describe, it, expect, beforeEach } from 'vitest';
import { resolveNavId, isFocusLeaving } from '../core/use-nav-list';

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
