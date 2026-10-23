import { useRef, useCallback } from 'react';

interface ResizeDragOptions {
  min: number;
  max: number;
  /** If true, width = window.innerWidth - clientX (right-anchored panel). */
  fromRight?: boolean;
  /** Where a left-anchored width is measured from, if not the window's left edge. */
  origin?: () => number;
}

/**
 * Returns a mousedown handler that drives a drag-to-resize interaction.
 * Clamps the resulting width between min and max, manages cursor/userSelect,
 * and cleans up listeners on mouseup.
 */
export function useResizeDrag(
  setter: (width: number) => void,
  { min, max, fromRight = false, origin }: ResizeDragOptions,
): (e: React.MouseEvent) => void {
  const dragging = useRef(false);

  return useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // preventDefault above also blocks the browser's focus-on-click; give the
      // handle focus explicitly so arrow keys work right after a mouse press.
      (e.currentTarget as HTMLElement).focus?.({ preventScroll: true });
      dragging.current = true;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const raw = fromRight ? window.innerWidth - ev.clientX : ev.clientX - (origin?.() ?? 0);
        setter(Math.max(min, Math.min(max, raw)));
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setter, min, max, fromRight, origin],
  );
}

/** Pixels moved per arrow key press on a resize handle / area shortcut. */
export const RESIZE_KEY_STEP = 24;

const clampWidth = (w: number, min: number, max: number) => Math.max(min, Math.min(max, w));

/**
 * Next width for a keyboard resize, or null if `key` isn't a resize key.
 * ArrowRight moves the divider right (grows a left-anchored pane, shrinks a
 * right-anchored one); Home/End jump to the limits.
 */
export function nextResizeWidth(
  key: string,
  current: number,
  { min, max, fromRight = false }: ResizeDragOptions,
): number | null {
  const dir = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (dir !== 0) return clampWidth(current + (fromRight ? -dir : dir) * RESIZE_KEY_STEP, min, max);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return null;
}

/**
 * ARIA window-splitter props for a resize handle: a focusable separator that
 * reports its pane width and resizes with the arrow keys. Spread next to the
 * handle's onMouseDown.
 */
export function resizeHandleProps(
  label: string,
  current: number,
  setter: (width: number) => void,
  opts: ResizeDragOptions,
) {
  return {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': label,
    'aria-valuenow': Math.round(current),
    'aria-valuemin': opts.min,
    'aria-valuemax': opts.max,
    tabIndex: -1, // focusable by click; Tab stays on the nav-area cycle (App.tsx)
    onKeyDown: (e: React.KeyboardEvent) => {
      const next = nextResizeWidth(e.key, current, opts);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      setter(next);
    },
  };
}
