import React, { useState } from 'react';
import { Pie } from '@visx/shape';
import type { Finding, Severity, FindingStatus } from '../core/types';
import { FindingMiniCard, useHoverCard } from './mini-cards';
import { categoryMeta, isOpenFinding, SEVERITY_RANK } from '../core/finding-categories';

// ── Colours ───────────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  pentest: 'var(--accent-blue)', tool: 'var(--accent-green)', manual: '#f0883e',
};
const SOURCE_PALETTE = ['var(--accent-blue)', 'var(--accent-green)', '#f0883e', 'var(--accent-purple)', 'var(--category-input-validation)', 'var(--category-ssrf)'];

// ── Tooltip ───────────────────────────────────────────────────────────────────

interface TooltipState { label: string; value: number; color: string; x: number; y: number; }

function ChartTooltip({ tip }: { tip: TooltipState }) {
  return (
    <div className="findings-chart-tooltip" style={{ left: tip.x + 12, top: tip.y - 8 }}>
      <span className="findings-chart-tooltip-dot" style={{ backgroundColor: tip.color }} />
      <span className="findings-chart-tooltip-label">{tip.label}</span>
      <span className="findings-chart-tooltip-value">{tip.value}</span>
    </div>
  );
}

// ── 1. Severity Distribution — horizontal bars ────────────────────────────────

const SEV_GROUPS = [
  { keys: ['critical'] as Severity[], label: 'Critical', color: 'var(--severity-critical)' },
  { keys: ['high'] as Severity[], label: 'High', color: 'var(--severity-high)' },
  { keys: ['medium'] as Severity[], label: 'Medium', color: 'var(--severity-medium)' },
  { keys: ['low'] as Severity[], label: 'Low', color: 'var(--severity-low)' },
  { keys: ['info'] as Severity[], label: 'Info', color: 'var(--severity-info)' },
];

function SeverityBars({ totals }: { totals: Record<string, number> }) {
  const groups = SEV_GROUPS.map(g => ({
    ...g,
    count: g.keys.reduce((s, k) => s + (totals[k] ?? 0), 0),
  }));
  const maxCount = Math.max(...groups.map(g => g.count), 1);

  return (
    <div className="fmetrics-chart-panel">
      <div className="fmetrics-panel-header">
        <span className="fmetrics-panel-title">Severity Distribution</span>
      </div>
      <div className="fmetrics-hsev-rows">
        {groups.map(g => (
          <div key={g.label} className="fmetrics-hsev-row">
            <div className="fmetrics-hsev-meta">
              <span className="fmetrics-hsev-label" style={{ color: g.color }}>{g.label.toUpperCase()}</span>
              <span className="fmetrics-hsev-count">{g.count}</span>
            </div>
            <div className="fmetrics-hsev-track">
              <div className="fmetrics-hsev-fill" style={{ width: `${(g.count / maxCount) * 100}%`, backgroundColor: g.color }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 2. Resolution Status — 2×2 tiles ─────────────────────────────────────────

// Bar colours grade by how much attention the bucket demands: open is the
// full-intensity alarm, in progress is a pale blue (being handled), accepted
// and closed wash out further (no issue).
const RES_TILES: { label: string; icon: ResStatusIcon; statuses: FindingStatus[]; color: string; accent?: boolean }[] = [
  { label: 'Open',        icon: 'open',        statuses: ['open', 'draft'],              color: 'var(--status-open)' },
  { label: 'In Progress', icon: 'in-progress', statuses: ['in-progress'],                color: 'color-mix(in srgb, var(--accent-blue) 45%, transparent)', accent: true },
  { label: 'Accepted',    icon: 'accepted',    statuses: ['accepted', 'false-positive'], color: 'color-mix(in srgb, var(--status-accepted) 40%, transparent)' },
  { label: 'Closed',      icon: 'closed',      statuses: ['closed'],                     color: 'color-mix(in srgb, var(--status-closed) 55%, transparent)' },
];

type ResStatusIcon = 'open' | 'in-progress' | 'accepted' | 'closed';

/** Status glyphs: open = hollow circle, in progress = play, accepted = tick
 *  in circle, closed = stop sign. Monochrome: they inherit the label's ink. */
function ResStatusGlyph({ icon }: { icon: ResStatusIcon }) {
  const common = {
    width: 11, height: 11, viewBox: '0 0 12 12',
    'aria-hidden': true as const,
  };
  switch (icon) {
    case 'open':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6" cy="6" r="4.5" />
        </svg>
      );
    case 'in-progress':
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="M3.5 2.2v7.6L10 6z" />
        </svg>
      );
    case 'accepted':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="4.5" />
          <path d="M4 6.2l1.4 1.4L8 4.9" />
        </svg>
      );
    case 'closed':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M4.1 1.5h3.8l2.6 2.6v3.8l-2.6 2.6H4.1L1.5 7.9V4.1z" />
        </svg>
      );
  }
}

/** Status tile grid, shared by the Findings metrics row and the Overview.
 *  `bare` renders just the grid so the caller provides the panel chrome. */
export function ResolutionTiles({ totals, bare }: { totals: Record<string, number>; bare?: boolean }) {
  const tiles = RES_TILES.map(t => ({
    ...t,
    count: t.statuses.reduce((s, st) => s + (totals[st] ?? 0), 0),
  }));

  const grid = (
    <div className="fmetrics-res-grid">
      {tiles.map(t => (
        <div key={t.label} className="fmetrics-res-tile">
          <span className="fmetrics-res-tile-label">
            <ResStatusGlyph icon={t.icon} />
            {t.label.toUpperCase()}
          </span>
          <span className={`fmetrics-res-tile-count${t.accent ? ' fmetrics-res-tile-accent' : ''}`}>
            {t.count}
          </span>
        </div>
      ))}
    </div>
  );

  if (bare) return grid;
  return (
    <div className="fmetrics-chart-panel">
      <div className="fmetrics-panel-header">
        <span className="fmetrics-panel-title">Resolution Status</span>
      </div>
      {grid}
    </div>
  );
}

/** Inline status summary: counts with labels over a segment bar aligned
 *  to the columns (zero counts show a faint track). The Overview's compact
 *  rendering of the same resolution data. */
export function ResolutionStrip({ totals }: { totals: Record<string, number> }) {
  const tiles = RES_TILES.map(t => ({
    ...t,
    count: t.statuses.reduce((s, st) => s + (totals[st] ?? 0), 0),
  }));
  const total = tiles.reduce((s, t) => s + t.count, 0);

  return (
    <div className="fmetrics-res-strip">
      <div className="fmetrics-res-strip-row">
        {tiles.map(t => (
          <div key={t.label} className={`fmetrics-res-strip-cell${t.count === 0 ? ' fmetrics-res-strip-zero' : ''}`}>
            <span className="fmetrics-res-strip-count">{t.count}</span>
            <span className="fmetrics-res-tile-label">
              <ResStatusGlyph icon={t.icon} />
              {t.label.toUpperCase()}
            </span>
          </div>
        ))}
      </div>
      {total > 0 && (
        <div className="fmetrics-res-strip-bar" aria-hidden="true">
          {tiles.map(t => (
            <span
              key={t.label}
              className={t.count === 0 ? 'fmetrics-res-strip-bar-empty' : undefined}
              style={t.count > 0 ? { background: t.color } : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 3. Findings by Source — large centred donut ───────────────────────────────

const SRC_SIZE = 180, SRC_OUTER = 82, SRC_INNER = 59;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

interface LegendEntry { label: string; value: number; color: string; }

function SourcePanel({ entries, total }: { entries: LegendEntry[]; total: number }) {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const c = SRC_SIZE / 2;
  const active = entries.filter(e => e.value > 0);

  return (
    <div className="fmetrics-chart-panel">
      <div className="fmetrics-panel-header">
        <span className="fmetrics-panel-title">Findings by Source</span>
      </div>
      <div className="fmetrics-source-wrap">
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <svg width={SRC_SIZE} height={SRC_SIZE} onMouseLeave={() => setTip(null)}>
            <g transform={`translate(${c},${c})`}>
              <Pie data={active} pieValue={d => d.value} outerRadius={SRC_OUTER} innerRadius={SRC_INNER} padAngle={0.025}>
                {({ arcs, path }) => arcs.map(arc => (
                  <path
                    key={arc.data.label}
                    d={path(arc) ?? ''}
                    fill={arc.data.color}
                    onMouseMove={e => setTip({ label: arc.data.label, value: arc.data.value, color: arc.data.color, x: e.clientX, y: e.clientY })}
                  />
                ))}
              </Pie>
              <text textAnchor="middle" fill="var(--text-primary)" fontSize={26} fontWeight={800} fontFamily={FONT} dy="-4" letterSpacing="-0.025em">{total}</text>
              <text textAnchor="middle" fill="var(--text-muted)" fontSize={9} fontWeight={700} fontFamily={FONT} dy="14" letterSpacing="0.1em">TOTAL FINDINGS</text>
            </g>
          </svg>
          {tip && <ChartTooltip tip={tip} />}
        </div>
      </div>
    </div>
  );
}

// ── 4. Category Heatmap — one square per finding, hover mini-card ────────────

function CategoryGrid({ findings }: { findings: Finding[] }) {
  const { card, containerRef, showCard, cancelClose, scheduleClose } = useHoverCard<Finding>();

  const byCategory = new Map<string, Finding[]>();
  for (const f of findings) {
    const cat = f.category || 'uncategorised';
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), f]);
  }
  if (byCategory.size === 0) return null;

  const ranked = [...byCategory.entries()].sort((a, b) => {
    const openA = a[1].filter(isOpenFinding).length;
    const openB = b[1].filter(isOpenFinding).length;
    return openB - openA || b[1].length - a[1].length;
  });

  return (
    <div className="fmetrics-chart-panel">
      <div className="fmetrics-panel-header">
        <span className="fmetrics-panel-title">Category Heatmap</span>
      </div>
      <div className="fmetrics-cat-rows" ref={containerRef}>
        {ranked.map(([cat, list]) => {
          // Open findings first (worst severity leading), resolved dimmed after.
          const sorted = [...list].sort((a, b) => {
            const openDiff = Number(isOpenFinding(b)) - Number(isOpenFinding(a));
            if (openDiff !== 0) return openDiff;
            return (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5);
          });
          return (
            <div key={cat} className="fmetrics-cat-row">
              <span className="fmetrics-cat-row-label" title={categoryMeta(cat).desc}>
                {categoryMeta(cat).label}
              </span>
              <span className="ovp-kind-squares">
                {sorted.map(f => (
                  <a
                    key={f.id}
                    className={`ovp-kind-square${isOpenFinding(f) ? '' : ' ovp-cat-square-resolved'}`}
                    style={{ background: `var(--severity-${f.severity})` }}
                    href={`#/findings/${f.id}`}
                    aria-label={f.title}
                    onMouseEnter={e => showCard(f, e.currentTarget)}
                    onMouseLeave={scheduleClose}
                  />
                ))}
              </span>
              <span className="fmetrics-cat-row-count">{list.length}</span>
            </div>
          );
        })}
        {card && (
          <FindingMiniCard
            finding={card.payload}
            isOpen={isOpenFinding(card.payload)}
            style={{ left: card.left, top: card.top }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          />
        )}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface FindingsMetricsProps {
  severityTotals: Record<string, number>;
  statusTotals: Record<string, number>;
  findings: Finding[];
  sourceTotals: [string, number][];
  total: number;
}

export const FindingsMetrics: React.FC<FindingsMetricsProps> = ({
  severityTotals, statusTotals, findings, sourceTotals, total,
}) => {
  const srcEntries: LegendEntry[] = sourceTotals.map(([src, count], i) => ({
    label: src, value: count,
    color: SOURCE_COLORS[src] ?? SOURCE_PALETTE[i % SOURCE_PALETTE.length],
  }));

  return (
    <div className="fmetrics-root">
      <div className="fmetrics-all-row">
        <SeverityBars totals={severityTotals} />
        <ResolutionTiles totals={statusTotals} />
        {srcEntries.length > 0 && <SourcePanel entries={srcEntries} total={total} />}
        {findings.length > 0 && <CategoryGrid findings={findings} />}
      </div>
    </div>
  );
};
