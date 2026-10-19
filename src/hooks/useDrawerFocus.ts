import { useEffect, useRef, type RefObject } from 'react';
import { isRendered } from '../core/dom';

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus management for an off-canvas drawer that behaves like a modal on a phone (it covers the
 * page behind a backdrop). While `active` and `open`:
 *   - focus moves into the drawer when it opens (first control, else the drawer itself);
 *   - Tab / Shift+Tab stay inside it; Escape closes it;
 *   - on close, focus goes back to whatever opened it, unless the user already put it elsewhere.
 * With `active` false (wide screens, where the panel is a normal column) it does nothing.
 */
export function useDrawerFocus(
  ref: RefObject<HTMLElement | null>,
  { active, open, onClose }: { active: boolean; open: boolean; onClose: () => void },
) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const drawer = ref.current;
    const isOpen = active && open;
    if (isOpen && !wasOpen.current && drawer) {
      opener.current = document.activeElement as HTMLElement | null;
      // After the inert attribute has been cleared by this render.
      const id = requestAnimationFrame(() => {
        const first = Array.from(drawer.querySelectorAll<HTMLElement>(TABBABLE)).find(isRendered);
        (first ?? drawer).focus({ preventScroll: true });
      });
      wasOpen.current = true;
      return () => cancelAnimationFrame(id);
    }
    if (!isOpen && wasOpen.current) {
      wasOpen.current = false;
      const el = opener.current;
      opener.current = null;
      queueMicrotask(() => {
        const a = document.activeElement;
        const lost = !a || a === document.body || !!drawer?.contains(a);
        if (el && el !== document.body && el.isConnected && lost) el.focus({ preventScroll: true });
      });
    }
  }, [ref, active, open]);

  useEffect(() => {
    if (!active || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const drawer = ref.current;
      if (!drawer) return;
      const a = document.activeElement as HTMLElement | null;
      // A dialog stacked above the drawer owns the keyboard.
      if (a?.closest('[role="dialog"]') && !drawer.contains(a)) return;
      if (e.key === 'Escape' && !e.defaultPrevented && (!a || a === document.body || drawer.contains(a))) {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(drawer.querySelectorAll<HTMLElement>(TABBABLE)).filter(isRendered);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!a || !drawer.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (a === first || a === drawer)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    // Capture: before App's global Tab area cycling.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [ref, active, open]);
}
