import { useCallback, useRef, useEffect, useState } from 'react';
import { useUIStore } from '../stores/ui-store';

interface DragRef {
  isSelecting: boolean;
  startLine: number | null;
  currentLine: number | null;
  side: 'old' | 'new' | null;
}

type RangePosition = 'first' | 'middle' | 'last' | 'single' | null;

export function useCommentDrag() {
  const setCommentDrag = useUIStore((s) => s.setCommentDrag);
  const commentDrag = useUIStore((s) => s.commentDrag);
  const setAnnotationAction = useUIStore((s) => s.setAnnotationAction);

  // Reactive state that triggers re-renders during drag
  const [dragPreviewLine, setDragPreviewLine] = useState<number | null>(null);

  const dragRef = useRef<DragRef>({
    isSelecting: false,
    startLine: null,
    currentLine: null,
    side: null,
  });

  const onMouseUp = useCallback(() => {
    const { isSelecting, startLine, currentLine, side } = dragRef.current;

    if (isSelecting && startLine !== null && currentLine !== null) {
      const minLine = Math.min(startLine, currentLine);
      const maxLine = Math.max(startLine, currentLine);

      setCommentDrag({
        isActive: true,
        startLine: minLine,
        endLine: maxLine,
        side,
      });
    }

    dragRef.current.isSelecting = false;
    setDragPreviewLine(null);
  }, [setCommentDrag]);

  // Clean up global listener on unmount
  useEffect(() => {
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseUp]);

  const onIconMouseDown = useCallback(
    (lineNumber: number, side: 'old' | 'new' = 'new') => {
      dragRef.current = {
        isSelecting: true,
        startLine: lineNumber,
        currentLine: lineNumber,
        side,
      };

      // Reset any existing drag/annotation state
      setCommentDrag({
        isActive: false,
        startLine: null,
        endLine: null,
        side: null,
      });
      setAnnotationAction(null);

      // Set reactive preview for immediate visual feedback
      setDragPreviewLine(lineNumber);

      document.addEventListener('mouseup', onMouseUp, { once: true });
    },
    [onMouseUp, setCommentDrag, setAnnotationAction],
  );

  const onRowMouseEnter = useCallback((lineNumber: number, side?: 'old' | 'new') => {
    if (!dragRef.current.isSelecting) return;
    // Enforce boundary: if drag started on 'old' side, skip 'new'-only lines (and vice versa)
    if (side && dragRef.current.side && side !== dragRef.current.side) return;
    dragRef.current.currentLine = lineNumber;
    // Trigger re-render so the drag bar updates live
    setDragPreviewLine(lineNumber);
  }, []);

  const isInRange = useCallback(
    (lineNumber: number): boolean => {
      // During active drag, use startLine + reactive preview
      if (dragRef.current.isSelecting && dragRef.current.startLine !== null && dragPreviewLine !== null) {
        const min = Math.min(dragRef.current.startLine, dragPreviewLine);
        const max = Math.max(dragRef.current.startLine, dragPreviewLine);
        return lineNumber >= min && lineNumber <= max;
      }

      // After drag completes, use store values
      if (!commentDrag.isActive) return false;
      const { startLine, endLine } = commentDrag;
      if (startLine === null || endLine === null) return false;
      return lineNumber >= startLine && lineNumber <= endLine;
    },
    [commentDrag, dragPreviewLine],
  );

  const rangePosition = useCallback(
    (lineNumber: number): RangePosition => {
      let startLine: number | null;
      let endLine: number | null;

      if (dragRef.current.isSelecting && dragRef.current.startLine !== null && dragPreviewLine !== null) {
        startLine = Math.min(dragRef.current.startLine, dragPreviewLine);
        endLine = Math.max(dragRef.current.startLine, dragPreviewLine);
      } else if (commentDrag.isActive) {
        startLine = commentDrag.startLine;
        endLine = commentDrag.endLine;
      } else {
        return null;
      }

      if (startLine === null || endLine === null) return null;
      if (lineNumber < startLine || lineNumber > endLine) return null;

      if (startLine === endLine) return 'single';
      if (lineNumber === startLine) return 'first';
      if (lineNumber === endLine) return 'last';
      return 'middle';
    },
    [commentDrag, dragPreviewLine],
  );

  return {
    onIconMouseDown,
    onRowMouseEnter,
    onMouseUp,
    isInRange,
    rangePosition,
  };
}
