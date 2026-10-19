/**
 * Tab / Shift+Tab area cycling, as a pure function so the edge cases (areas
 * that aren't mounted, a single area, focus outside any area) are unit-testable.
 *
 * `cycle` is the ordered list of nav-area names for the current view,
 * `isLive` says whether an area is currently in the DOM, and `current` is the
 * area that owns the focused element (null/undefined when focus is on <body>
 * or outside any area).
 *
 * Returns:
 *  - `area`: the area to focus next, or null when there is nothing to move to
 *  - `suppress`: true when Tab should be swallowed without moving (single area)
 */
export function nextNavArea(
  cycle: readonly string[] | undefined,
  isLive: (area: string) => boolean,
  current: string | null | undefined,
  reverse: boolean,
): { area: string | null; suppress: boolean } {
  if (!cycle || cycle.length === 0) return { area: null, suppress: false };
  const live = cycle.filter(isLive);
  if (live.length === 0) return { area: null, suppress: false };

  const idx = current ? live.indexOf(current) : -1;
  if (idx === -1) return { area: live[0], suppress: false };
  if (live.length <= 1) return { area: null, suppress: true };
  const next = reverse ? (idx - 1 + live.length) % live.length : (idx + 1) % live.length;
  return { area: live[next], suppress: false };
}
