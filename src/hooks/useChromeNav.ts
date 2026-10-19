import { useEffect } from 'react';
import { isRendered } from '../core/dom';

const TOOLBAR = '[data-chrome]';
const CONTROL = 'button:not([disabled]), a[href], select:not([disabled]), [role="button"][tabindex]';

/**
 * The toolbar controls in document order: every control inside (or carrying)
 * a `data-chrome` marker - the view tabs, panel headers, the file header,
 * filters, expand buttons, banners - then the shortcuts button.
 */
function chromeItems(): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const group of Array.from(document.querySelectorAll<HTMLElement>(TOOLBAR))) {
    if (group.matches(CONTROL)) items.push(group);
    else items.push(...Array.from(group.querySelectorAll<HTMLElement>(CONTROL)));
  }
  const fab = document.querySelector<HTMLElement>('.shortcuts-fab');
  const unique = Array.from(new Set([...items, ...(fab ? [fab] : [])]));
  return unique.filter(isRendered);
}

/**
 * Keyboard access to the page chrome (view tabs, quick-add buttons, theme
 * toggle, panel headers and filters, banners, shortcuts button). These sit outside every nav area and Tab only
 * cycles areas, so without this they were mouse-only (apart from the number keys).
 *
 *   F6                 jump to the toolbar (the active tab), and back again
 *   Left / Right       previous / next control   (Home / End: first / last)
 *   Escape             back to where focus was
 *   Tab                continues into the page (App's area cycling)
 *   Enter / Space      activate - native button behaviour
 */
export function useChromeNav() {
  useEffect(() => {
    let returnTo: HTMLElement | null = null;

    const leave = () => {
      const target = returnTo;
      returnTo = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-nav-area]')?.focus({ preventScroll: true });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      const items = chromeItems();
      const idx = active ? items.indexOf(active) : -1;

      if (e.key === 'F6' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); // F6 would otherwise move focus to the browser's address bar
        if (idx !== -1) { leave(); return; }
        returnTo = active && active !== document.body ? active : null;
        // The active tab, or the project name while on its Overview (it has no tab).
        (items.find((el) => el.classList.contains('tab-bar-tab-active') || el.getAttribute('aria-current') === 'page') ?? items[0])?.focus();
        return;
      }

      if (idx === -1 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Left/Right step through controls even on a <select> (Up/Down still change it).
      if (e.key === 'ArrowRight') { e.preventDefault(); items[Math.min(idx + 1, items.length - 1)].focus(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); items[Math.max(idx - 1, 0)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); leave(); }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
