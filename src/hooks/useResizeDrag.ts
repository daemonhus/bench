import { useRef, useCallback } from 'react';

interface ResizeDragOptions {
  min: number;
  max: number;
  /** If true, width = window.innerWidth - clientX (right-anchored panel). */
  fromRight?: boolean;
}

/**
 * Returns a mousedown handler that drives a drag-to-resize interaction.
 * Clamps the resulting width between min and max, manages cursor/userSelect,
 * and cleans up listeners on mouseup.
 */
export function useResizeDrag(
  setter: (width: number) => void,
  { min, max, fromRight = false }: ResizeDragOptions,
): (e: React.MouseEvent) => void {
  const dragging = useRef(false);

  return useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const raw = fromRight ? window.innerWidth - ev.clientX : ev.clientX;
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
    [setter, min, max, fromRight],
  );
}
