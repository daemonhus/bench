import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { isRendered } from '../core/dom';

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isVisible = isRendered;

/**
 * Dialog focus management (shared by the workbench and the platform shell):
 *  - remembers what had focus before the dialog rendered and restores it when
 *    it unmounts - for keyboard- and mouse-opened dialogs alike;
 *  - moves focus INTO the dialog on open when nothing inside already took it
 *    (an autofocused input wins), falling back to the container itself;
 *  - keeps Tab / Shift+Tab inside `containerRef` so focus can't wander to the
 *    page behind the backdrop.
 * Escape stays with the caller (see `useModal`).
 */
export function useModalFocus(containerRef: RefObject<HTMLElement>) {
  // Read during the first render, i.e. before the dialog's own autoFocus runs.
  const opener = useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  );

  // Restoring focus is deferred to a microtask and cancelled by the next effect run:
  // React StrictMode (dev) runs cleanup + setup once on mount, and a synchronous
  // "restore to opener" there would steal focus from the dialog's own autoFocus.
  // It also only applies when focus was actually lost with the dialog (activeElement is
  // <body>, or an ancestor of where the dialog was mounted - a click on the backdrop
  // focuses the nearest focusable ancestor); if something else already took focus (e.g. a
  // search result that moves focus into the code), that wins.
  const restoreToken = useRef(0);

  useEffect(() => {
    restoreToken.current++; // a remount (StrictMode) cancels the pending restore below
    const root = containerRef.current;
    if (root && !root.contains(document.activeElement)) {
      const first = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).find(isVisible);
      (first ?? root).focus({ preventScroll: true });
    }
    const el = opener.current;
    // The dialog's ancestors (backdrop, the area it was rendered inside, ...). If focus ends up on
    // one of those, it fell there because the dialog's own focus was lost.
    const ancestors = new Set<Element>();
    for (let n = root?.parentElement ?? null; n; n = n.parentElement) ancestors.add(n);
    return () => {
      const token = restoreToken.current;
      queueMicrotask(() => {
        if (token !== restoreToken.current) return; // effect re-ran: not a real close
        const a = document.activeElement;
        const focusLost = !a || a === document.body || ancestors.has(a);
        if (el && el !== document.body && el.isConnected && focusLost) {
          el.focus({ preventScroll: true });
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A modal keeps focus: when the focused control unmounts (a form closing, a row
  // being removed) the browser drops focus to <body> WITHOUT firing focusout, where
  // Escape and Tab would no longer reach the dialog. Watch for DOM changes inside
  // it (a microtask, so it lands before the next key press) and pull focus back;
  // focusout covers a control that is merely disabled or blurred to nowhere.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const reclaim = () => {
      const r = containerRef.current;
      if (!r || !r.isConnected) return;
      const a = document.activeElement;
      if (!a || a === document.body) r.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(reclaim);
    observer.observe(root, { childList: true, subtree: true });
    const onFocusOut = () => setTimeout(reclaim, 0);
    root.addEventListener('focusout', onFocusOut);
    return () => { observer.disconnect(); root.removeEventListener('focusout', onFocusOut); };
  }, [containerRef]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      // A dialog stacked on top of this one owns Tab.
      const active = document.activeElement as HTMLElement | null;
      if (active && !root.contains(active) && active.closest('[role="dialog"]')) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(isVisible);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!active || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture: runs before App's global Tab area-cycling handler.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [containerRef]);
}

interface UseModalOptions {
  /** Accessible name of the dialog. */
  label: string;
  /** Called on Escape unless a nested control already handled it. */
  onClose?: () => void;
}

/**
 * Props for a modal's panel element: dialog semantics, focus management and a
 * local Escape. Nested editors that use Escape to cancel their own edit should
 * call `e.stopPropagation()` so the first Escape only leaves the edit.
 *
 *   const modal = useModal<HTMLDivElement>({ label: 'Set baseline', onClose });
 *   <div className="panel" {...modal.props}>
 */
export function useModal<T extends HTMLElement = HTMLDivElement>({ label, onClose }: UseModalOptions) {
  const ref = useRef<T>(null);
  useModalFocus(ref);

  const onKeyDown = useCallback((e: KeyboardEvent<T>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !onClose) return;
    e.stopPropagation();
    onClose();
  }, [onClose]);

  return {
    ref,
    props: {
      ref,
      role: 'dialog' as const,
      'aria-modal': true as const,
      'aria-label': label,
      tabIndex: -1,
      onKeyDown,
    },
  };
}
