import React from 'react';

/** A loading placeholder (.skeleton in animations.css): a grey block with a moving highlight.
 *  Size it like the content it replaces so the layout does not shift when data arrives. */
export function Skeleton({ width = '100%', height = 14, radius, className, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

/** `rows` skeleton bars, `height` tall with `gap` between them; the last is shorter, like text. */
export function SkeletonRows({ rows, height = 14, gap = 10, lastWidth = '60%', className }: {
  rows: number;
  height?: number;
  gap?: number;
  lastWidth?: number | string;
  className?: string;
}) {
  return (
    <span className={`skeleton-stack${className ? ` ${className}` : ''}`} style={{ gap }} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} width={i === rows - 1 && rows > 1 ? lastWidth : '100%'} />
      ))}
    </span>
  );
}

/** A list page's placeholder (Findings, Features, Changes): a stack of card-sized blocks. */
export function PageSkeleton({ cards = 5, cardHeight = 72, label = 'Loading' }: { cards?: number; cardHeight?: number; label?: string }) {
  return (
    <div className="page-skeleton" role="status" aria-label={label}>
      <Skeleton height={22} width="28%" />
      <SkeletonRows rows={cards} height={cardHeight} gap={12} lastWidth="100%" />
    </div>
  );
}
