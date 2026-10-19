import { useState, useCallback, useEffect, useRef } from 'react';
import { isRendered } from './dom';

/**
 * Walk up from `target` to the nearest `[data-nav-id]` ancestor inside
 * `container` and return its id. Returns null if no such ancestor exists or
 * the match is outside the container. Exported for testing - the hook below
 * uses it on focus and pointer-down to update the current nav anchor.
 */
export function resolveNavId(
  target: EventTarget | null,
  container: HTMLElement | null,
): string | null {
  if (!container || !(target instanceof Element)) return null;
  const card = target.closest('[data-nav-id]') as HTMLElement | null;
  if (!card || !container.contains(card)) return null;
  return card.getAttribute('data-nav-id');
}

/**
 * Whether a focusout moving to `next` takes focus out of `container` entirely.
 * A move that lands on another element inside the list (a card to its own reply
 * box, say) keeps the nav anchor; anything else - a filter, a tab, clicking
 * blank space (relatedTarget null) - drops it. Exported for testing.
 */
export function isFocusLeaving(
  next: EventTarget | null,
  container: HTMLElement | null,
): boolean {
  if (!container) return false;
  if (!(next instanceof Node)) return true; // null / non-node: focus went nowhere in the list
  return !container.contains(next);
}

/**
 * Controls inside a card that the keyboard can step through. Text fields are
 * not stops: Left/Right move their caret, and they have their own way in (Enter
 * on an expanded card focuses the reply box; Edit autofocuses its first field).
 */
const ACTIONABLE =
  'button:not([disabled]), a[href], select:not([disabled]), [role="button"][tabindex]';

/**
 * The visible, enabled controls of a card in DOM order (status, links, edit,
 * delete, code toggles, reply box...). Tab only cycles nav areas, so these are
 * reached with Left/Right from the card (see useNavList). Exported for testing.
 */
export function cardActions(card: Element | null): HTMLElement[] {
  if (!card) return [];
  return Array.from(card.querySelectorAll<HTMLElement>(ACTIONABLE))
    .filter(isRendered);
}

/**
 * The first card at least partly on screen inside `container`: where a keyboard user re-entering
 * the list should resume, without the list moving. Exported for testing.
 */
export function firstVisibleNavId(container: HTMLElement | null): string | null {
  if (!container) return null;
  const view = container.getBoundingClientRect();
  const top = Math.max(view.top, 0);
  const bottom = Math.min(view.bottom, window.innerHeight);
  for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-nav-id]'))) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top && r.top < bottom && r.height > 0) return el.getAttribute('data-nav-id');
  }
  return null;
}

interface UseNavListOptions<T> {
  items: T[];
  getId: (item: T) => string;
  /** Space: toggle expand/collapse */
  onSelect?: (item: T) => void;
  /** Enter: navigate / activate primary action */
  onActivate?: (item: T) => void;
  /** Shift+Enter: secondary action (e.g. navigate to code) */
  onShiftActivate?: (item: T) => void;
  onFocusChange?: (item: T | null) => void;
}

export function useNavList<T>({
  items,
  getId,
  onSelect,
  onActivate,
  onShiftActivate,
  onFocusChange,
}: UseNavListOptions<T>) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const focusedIndex = focusedId != null
    ? items.findIndex(i => getId(i) === focusedId)
    : -1;

  // Drop focus if the focused item disappears (e.g. filter change)
  useEffect(() => {
    if (focusedId && items.findIndex(i => getId(i) === focusedId) === -1) {
      setFocusedId(null);
      onFocusChange?.(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const moveFocus = useCallback((index: number) => {
    if (items.length === 0) return;
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    const id = getId(items[clamped]);
    setFocusedId(id);
    onFocusChange?.(items[clamped]);
    // Scroll item into view if the container ref is attached
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector(`[data-nav-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }, [items, getId, onFocusChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    const inEditable = tag === 'INPUT' || tag === 'TEXTAREA'
      || (e.target as HTMLElement).isContentEditable;

    if (inEditable) {
      // Escape inside a textarea/input returns focus to the nav container so the
      // user can continue arrow-keying. focusedId is preserved.
      if (e.key === 'Escape') {
        e.preventDefault();
        containerRef.current?.focus({ preventScroll: true });
      }
      return;
    }

    // If focus has moved onto an interactive child (button, anchor, select),
    // let the native element handle Enter/Space. We still handle arrow keys
    // and Escape so the user can navigate back to card-level.
    const target = e.target as HTMLElement;

    // Card controls: from the item, Right enters its controls; Left/Right then
    // step between them (Left past the first returns to the item) and Escape
    // returns to the item with the anchor kept. Left/Right is intercepted on a
    // <select> too, so stepping past the status dropdown never changes it.
    const container = containerRef.current;
    const plainKey = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (container && plainKey) {
      if (e.key === 'ArrowRight' && target === container && focusedId != null) {
        const card = container.querySelector(`[data-nav-id="${CSS.escape(focusedId)}"]`);
        const first = cardActions(card)[0];
        if (first) { e.preventDefault(); first.focus({ preventScroll: false }); return; }
      }
      const cardEl = target !== container ? target.closest('[data-nav-id]') : null;
      if (cardEl && container.contains(cardEl)) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const actions = cardActions(cardEl);
          const idx = actions.indexOf(target);
          if (idx !== -1) {
            e.preventDefault();
            if (e.key === 'ArrowRight') actions[Math.min(idx + 1, actions.length - 1)].focus();
            else if (idx === 0) container.focus({ preventScroll: true });
            else actions[idx - 1].focus();
            return;
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          container.focus({ preventScroll: true });
          return;
        }
      }
    }

    const onInteractiveChild = target !== containerRef.current
      && (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || target.getAttribute('role') === 'button');

    if (e.key === 'ArrowDown' && !onInteractiveChild) {
      e.preventDefault();
      moveFocus(focusedIndex < 0 ? 0 : focusedIndex + 1);
    } else if (e.key === 'ArrowUp' && !onInteractiveChild) {
      e.preventDefault();
      moveFocus(focusedIndex <= 0 ? 0 : focusedIndex - 1);
    } else if (e.key === 'Enter' && !onInteractiveChild && focusedIndex >= 0 && e.shiftKey && onShiftActivate) {
      e.preventDefault();
      onShiftActivate(items[focusedIndex]);
    } else if (e.key === 'Enter' && !onInteractiveChild && focusedIndex >= 0) {
      e.preventDefault();
      if (onActivate) onActivate(items[focusedIndex]);
      else onSelect?.(items[focusedIndex]);
    } else if (e.key === ' ' && !onInteractiveChild && focusedIndex >= 0) {
      e.preventDefault();
      onSelect?.(items[focusedIndex]);
    } else if (e.key === 'Escape') {
      setFocusedId(null);
      onFocusChange?.(null);
    }
  }, [focusedIndex, focusedId, items, moveFocus, onSelect, onActivate, onShiftActivate, onFocusChange]);

  // Track focus moves inside the list so the "current" card is whichever one
  // the user last interacted with - clicking a card body, focusing its reply
  // textarea, or tabbing to a button inside the card all update focusedId so
  // subsequent arrow-key navigation continues from there.
  //
  // If focus arrives from outside the container and lands directly on the
  // container element (e.g. a Tab from elsewhere), auto-focus the first item
  // so keyboard users have an anchor to move from.
  const handleFocus = useCallback((e: React.FocusEvent) => {
    if (items.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const id = resolveNavId(e.target, container);
    if (id) {
      if (id !== focusedId) {
        setFocusedId(id);
        const item = items.find(it => getId(it) === id);
        onFocusChange?.(item ?? null);
      }
      return;
    }
    // Focus landed on something that isn't a card. Only the container itself
    // (a Tab arriving from elsewhere) seeds the first item: other non-card
    // children - a draft form's autofocused textarea, a toolbar button - must
    // not, or onFocusChange(item 0) would e.g. scroll the code viewer to that
    // item's line just because a form opened.
    if (e.target !== container) return;
    if (focusedId != null) return;
    if (e.relatedTarget && container.contains(e.relatedTarget as Node)) return;
    // Resume at the first card on screen, without scrolling: seeding the first item (and
    // scrolling to it) made a long list jump back to the top whenever focus came back.
    const visible = firstVisibleNavId(container);
    const item = visible != null ? items.find(it => getId(it) === visible) : items[0];
    if (!item) return;
    setFocusedId(getId(item));
    onFocusChange?.(item);
  }, [focusedId, items, getId, onFocusChange]);

  // The focus ring marks where arrow-keying would resume, so it has no meaning
  // once focus leaves the list: clicking a filter, a tab, or anything else
  // outside drops the anchor. React's onBlur is focusout, so this fires for
  // focus moving off any descendant; a move that lands back inside the list
  // (card to its own reply box, say) keeps the anchor.
  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (focusedId == null) return;
    if (!isFocusLeaving(e.relatedTarget, containerRef.current)) return;
    setFocusedId(null);
    onFocusChange?.(null);
  }, [focusedId, onFocusChange]);

  // Clicks on parts of a card that aren't focusable (label spans, snippet
  // gutters, etc.) wouldn't otherwise update focusedId. Catch them on
  // mousedown so the update lands before any inner click handler runs.
  const handlePointerDown = useCallback((e: React.MouseEvent) => {
    const id = resolveNavId(e.target, containerRef.current);
    if (!id || id === focusedId) return;
    setFocusedId(id);
    const item = items.find(it => getId(it) === id);
    onFocusChange?.(item ?? null);
  }, [focusedId, items, getId, onFocusChange]);

  return { focusedId, focusedIndex, containerRef, handleKeyDown, handleFocus, handleBlur, handlePointerDown, setFocusedId };
}
