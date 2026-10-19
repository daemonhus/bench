import { useEffect } from 'react';

/**
 * Focus a nav area requested by a tab switch (`pending`), even if the area is
 * not mounted yet (its view is still loading). When the element is absent we
 * watch the DOM for it; if the user clicks or types somewhere else first the
 * request is stale and dropped, so a slow load never pulls focus away from
 * what the user chose.
 *
 * `rerunKey` re-evaluates the request (the active view changing).
 */
export function usePendingNavFocus(
  pending: string | null,
  clearPending: () => void,
  rerunKey: unknown,
  onFocused?: () => void,
) {
  useEffect(() => {
    if (!pending) return;
    const find = () => document.querySelector(`[data-nav-area="${pending}"]`) as HTMLElement | null;
    const apply = (el: HTMLElement) => {
      el.focus({ preventScroll: true });
      clearPending();
      onFocused?.();
    };

    const immediate = find();
    if (immediate) {
      apply(immediate);
      return;
    }

    const cleanup = () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
    const cancel = () => { cleanup(); clearPending(); };
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) { cleanup(); apply(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, rerunKey]);
}
