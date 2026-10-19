/**
 * Whether an element is rendered (takes part in layout). Unlike
 * `offsetParent !== null` this is also true for `position: fixed` elements
 * (the shortcuts button, floating bars), whose offsetParent is always null - and
 * excludes controls that are laid out but not available (visibility: hidden, inert).
 */
export function isRendered(el: HTMLElement): boolean {
  if (el === document.activeElement) return true;
  if (el.getClientRects().length === 0) return false;
  // Clipped-but-present panels (height: 0, visibility: hidden, inert) still have client rects.
  if (el.closest('[inert]')) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}
