import { useEffect, useRef, useState } from 'react';
import type { Feature, Finding } from '../core/types';
import { KIND_COLORS } from './FeatureCard';
import { InlineMarkdown } from '../core/markdown';

// ---------------------------------------------------------------------------
// Shared hover mini-cards (feature and finding) plus the hover lifecycle:
// a grace timer bridges the pointer travelling from the trigger into the
// card, which is interactive (its links are clickable).
// ---------------------------------------------------------------------------

export interface HoverCardState<T> {
  payload: T;
  left: number;
  top: number;
}

export function useHoverCard<T>(cardWidth = 300) {
  const [card, setCard] = useState<HoverCardState<T> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setCard(null), 180);
  };
  useEffect(() => cancelClose, []);

  /** Anchor the card just below the hovered element, relative to the
   *  container, clamping horizontally so it never hangs off the edges. */
  const showCard = (payload: T, el: HTMLElement) => {
    cancelClose();
    const container = containerRef.current;
    if (!container) return;
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const half = cardWidth / 2;
    const left = Math.max(half, Math.min(c.width - half, r.left - c.left + r.width / 2));
    setCard({ payload, left, top: r.bottom - c.top + 6 });
  };

  return { card, containerRef, showCard, cancelClose, scheduleClose };
}

export function FeatureMiniCard({ feature, openCount, links, titleById, className, style, onMouseEnter, onMouseLeave }: {
  feature: Feature;
  openCount: number;
  links: { id: string }[];
  titleById: Map<string, string>;
  className?: string;
  style?: React.CSSProperties;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return (
    <div
      className={`ovp-map-card${className ? ` ${className}` : ''}`}
      style={style}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <a className="ovp-map-card-title" href={`#/features/${feature.id}`}>
        {feature.title}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l5-5M4 3.5h4.5V8" />
        </svg>
      </a>
      <div className="ovp-map-card-meta">
        <span className="ovp-map-card-kind" style={{ background: KIND_COLORS[feature.kind] }}>
          {feature.kind}
        </span>
        {feature.operation && <span className="ovp-mono">{feature.operation}</span>}
        {feature.protocol && <span>{feature.protocol}</span>}
      </div>
      {feature.description && (
        <p className="ovp-map-card-desc"><InlineMarkdown text={feature.description} /></p>
      )}
      {links.length > 0 && (
        <div className="ovp-map-card-links">
          {links.slice(0, 4).map((lf) => (
            <a key={lf.id} className="ovp-map-card-link" href={`#/features/${lf.id}`}>
              {titleById.get(lf.id)}
            </a>
          ))}
          {links.length > 4 && (
            <span className="ovp-map-card-link-more">+{links.length - 4} more</span>
          )}
        </div>
      )}
      <div className="ovp-map-card-foot">
        {openCount > 0 ? (
          <a className="ovp-map-card-open ovp-map-card-open-link" href={`#/findings/feature/${feature.id}`}>
            {openCount} open finding{openCount === 1 ? '' : 's'} →
          </a>
        ) : (
          <span>No open findings</span>
        )}
        {links.length > 0 && (
          <span>{links.length} link{links.length === 1 ? '' : 's'}</span>
        )}
      </div>
    </div>
  );
}

export function FindingMiniCard({ finding, isOpen, className, style, onMouseEnter, onMouseLeave }: {
  finding: Finding;
  isOpen: boolean;
  className?: string;
  style?: React.CSSProperties;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const line = finding.anchor.lineRange;
  return (
    <div
      className={`ovp-map-card ovp-kind-card${className ? ` ${className}` : ''}`}
      style={style}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <a className="ovp-map-card-title" href={`#/findings/${finding.id}`}>
        {finding.title}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l5-5M4 3.5h4.5V8" />
        </svg>
      </a>
      <div className="ovp-map-card-meta">
        <span className="ovp-map-card-kind" style={{ background: `var(--severity-${finding.severity})` }}>
          {finding.severity}
        </span>
        <span>{isOpen ? finding.status : 'resolved'}</span>
        {finding.cwe && <span className="ovp-mono">{finding.cwe}</span>}
      </div>
      {finding.description && (
        <p className="ovp-map-card-desc"><InlineMarkdown text={finding.description} /></p>
      )}
      <div className="ovp-map-card-foot">
        <span className="ovp-mono ovp-map-card-file">
          {finding.anchor.fileId}{line ? `:${line.start}` : ''}
        </span>
      </div>
    </div>
  );
}
