import type { KeyboardEvent, SyntheticEvent } from 'react';

/**
 * Props that make a non-<button> element (a styled span/div) a real button:
 * role, a tab stop, an accessible name, and Enter/Space activation that does
 * exactly what a click does. Prefer a native <button> where the styling allows;
 * use this where the element has to stay a span/div.
 */
export function buttonProps(
  onActivate: (e: SyntheticEvent) => void,
  label?: string,
) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    ...(label ? { 'aria-label': label } : {}),
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // Space must not scroll the page
      e.stopPropagation(); // a card's own Enter/Space (expand) must not also fire
      onActivate(e);
    },
  };
}
