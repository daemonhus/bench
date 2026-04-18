import { useState, useCallback, useEffect, useRef } from 'react';

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
    const onInteractiveChild = target !== containerRef.current
      && (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || target.getAttribute('role') === 'button');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(focusedIndex < 0 ? 0 : focusedIndex + 1);
    } else if (e.key === 'ArrowUp') {
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
  }, [focusedIndex, items, moveFocus, onSelect, onActivate, onShiftActivate, onFocusChange]);

  // When the container receives focus from outside (e.g. via Tab), auto-focus
  // the first item so keyboard users have an anchor to move from.
  const handleFocus = useCallback((e: React.FocusEvent) => {
    if (focusedId != null) return;
    if (items.length === 0) return;
    const container = containerRef.current;
    // Only auto-focus when focus comes from outside the container, not from a
    // child element bubbling up.
    if (container && e.relatedTarget && container.contains(e.relatedTarget as Node)) return;
    moveFocus(0);
  }, [focusedId, items, moveFocus]);

  return { focusedId, focusedIndex, containerRef, handleKeyDown, handleFocus, setFocusedId };
}
