import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useAnnotationStore } from '../stores/annotation-store';
import { useUIStore } from '../stores/ui-store';
import { getEffectiveLineRange } from '../core/types';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
  info: '#6b7280',
};

interface ConnectorPoints {
  cardX: number;
  cardY: number;
  lineX: number;
  lineY: number;
  color: string;
}

export const ConnectorOverlay: React.FC = () => {
  const expandedFindingId = useUIStore((s) => s.expandedFindingId);
  const findings = useAnnotationStore((s) => s.findings);
  const [points, setPoints] = useState<ConnectorPoints | null>(null);
  const rafRef = useRef<number>(0);

  const computePoints = useCallback(() => {
    if (!expandedFindingId) {
      setPoints(null);
      return;
    }

    const finding = findings.find((f) => f.id === expandedFindingId);
    if (!finding) {
      setPoints(null);
      return;
    }

    // Find the sidebar card element
    const card = document.querySelector(`.finding-card-focused`);
    if (!card) {
      setPoints(null);
      return;
    }

    // Find the target line in the code view (prefer effective position from reconciliation)
    const targetLine = getEffectiveLineRange(finding)?.start;
    if (!targetLine) {
      setPoints(null);
      return;
    }

    const row = document.querySelector(
      `.diff-row[data-new-line="${targetLine}"], .diff-row[data-old-line="${targetLine}"]`,
    );
    if (!row) {
      setPoints(null);
      return;
    }

    const cardRect = card.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();

    setPoints({
      cardX: cardRect.left,
      cardY: cardRect.top + cardRect.height / 2,
      lineX: rowRect.right,
      lineY: rowRect.top + rowRect.height / 2,
      color: SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info,
    });
  }, [expandedFindingId, findings]);

  useEffect(() => {
    // Delay initial computation so DOM has laid out after expand
    rafRef.current = requestAnimationFrame(computePoints);

    // Listen for scroll/resize to recompute
    const diffView = document.querySelector('.diff-view');
    const sidebarContent = document.querySelector('.sidebar-content');

    const handleUpdate = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(computePoints);
    };

    // Watch sidebar for layout changes (card expand/collapse, comments loading)
    const resizeObserver = new ResizeObserver(handleUpdate);
    if (sidebarContent) resizeObserver.observe(sidebarContent);

    diffView?.addEventListener('scroll', handleUpdate, { passive: true });
    sidebarContent?.addEventListener('scroll', handleUpdate, { passive: true });
    window.addEventListener('resize', handleUpdate);

    return () => {
      cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
      diffView?.removeEventListener('scroll', handleUpdate);
      sidebarContent?.removeEventListener('scroll', handleUpdate);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [computePoints]);

  if (!points) return null;

  const { cardX, cardY, lineX, lineY, color } = points;
  const midX = (lineX + cardX) / 2;

  return (
    <svg
      className="connector-overlay"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 50,
      }}
    >
      <path
        d={`M ${lineX} ${lineY} C ${midX} ${lineY}, ${midX} ${cardY}, ${cardX} ${cardY}`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4 3"
        opacity={0.6}
      />
      <circle cx={lineX} cy={lineY} r={3} fill={color} opacity={0.8} />
      <circle cx={cardX} cy={cardY} r={3} fill={color} opacity={0.8} />
    </svg>
  );
};
