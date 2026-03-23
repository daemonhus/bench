import React, { useState } from 'react';
import { Pie } from '@visx/shape';
import type { Severity, FindingStatus } from '../core/types';

// ── Colours ───────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  auth: '#dc2626', authz: '#ea580c', session: '#f97316',
  injection: '#b91c1c', ssrf: '#e11d48', crypto: '#7c3aed',
  'data-exposure': '#2563eb', 'input-validation': '#0891b2', 'path-traversal': '#0d9488',
  deserialization: '#059669', 'race-condition': '#ca8a04', config: '#d97706',
  'error-handling': '#64748b', logging: '#8b5cf6', 'business-logic': '#6366f1',
  dependencies: '#78716c',
};

const SOURCE_COLORS: Record<string, string> = {
  pentest: '#818cf8', tool: '#34d399', manual: '#f0883e',
};
const SOURCE_PALETTE = ['#818cf8', '#34d399', '#f0883e', '#bc8cff', '#0891b2', '#e11d48'];

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
  { keys: ['critical'] as Severity[], label: 'Critical', color: '#dc2626' },
  { keys: ['high'] as Severity[], label: 'High', color: '#ea580c' },
  { keys: ['medium'] as Severity[], label: 'Medium', color: '#ca8a04' },
  { keys: ['low'] as Severity[], label: 'Low', color: '#2563eb' },
  { keys: ['info'] as Severity[], label: 'Info', color: '#6b7280' },
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

const RES_TILES: { label: string; statuses: FindingStatus[]; accent?: boolean }[] = [
  { label: 'Open',        statuses: ['open', 'draft'] },
  { label: 'In Progress', statuses: ['in-progress'], accent: true },
  { label: 'Accepted',    statuses: ['accepted', 'false-positive'] },
  { label: 'Closed',      statuses: ['closed'] },
];

function ResolutionTiles({ totals }: { totals: Record<string, number> }) {
  const tiles = RES_TILES.map(t => ({
    ...t,
    count: t.statuses.reduce((s, st) => s + (totals[st] ?? 0), 0),
  }));

  return (
    <div className="fmetrics-chart-panel">
      <div className="fmetrics-panel-header">
        <span className="fmetrics-panel-title">Resolution Status</span>
      </div>
      <div className="fmetrics-res-grid">
        {tiles.map(t => (
          <div key={t.label} className="fmetrics-res-tile">
            <span className="fmetrics-res-tile-label">{t.label.toUpperCase()}</span>
            <span className={`fmetrics-res-tile-count${t.accent ? ' fmetrics-res-tile-accent' : ''}`}>
              {t.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 3. Findings by Source — large centred donut ───────────────────────────────

const SRC_SIZE = 160, SRC_OUTER = 70, SRC_INNER = 50;
const T_PRIMARY = '#e6edf3';
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
              <text textAnchor="middle" fill={T_PRIMARY} fontSize={26} fontWeight={800} fontFamily={FONT} dy="-4" letterSpacing="-0.025em">{total}</text>
              <text textAnchor="middle" fill="#55606f" fontSize={9} fontWeight={700} fontFamily={FONT} dy="14" letterSpacing="0.1em">TOTAL FINDINGS</text>
            </g>
          </svg>
          {tip && <ChartTooltip tip={tip} />}
        </div>
      </div>
    </div>
  );
}

// ── 4. Category Heatmap — 2×N tiles ──────────────────────────────────────────

const TOP_N = 5;

function catShort(cat: string): string {
  const abbrevs: Record<string, string> = {
    'path-traversal': 'PATH-TRAV', 'data-exposure': 'DATA-EXP',
    'input-validation': 'INPUT-VAL', 'business-logic': 'BIZ-LOGIC',
    'error-handling': 'ERR-HAND', 'race-condition': 'RACE-COND',
  };
  return (abbrevs[cat] ?? cat.replace(/-/g, ' ')).toUpperCase().slice(0, 9);
}

function CategoryGrid({ data }: { data: [string, number][] }) {
  if (data.length === 0) return null;

  const topData = data.slice(0, TOP_N);
  const othersCount = data.slice(TOP_N).reduce((s, [, n]) => s + n, 0);
  const tiles = [
    ...topData.map(([cat, count]) => ({ cat, count, color: CATEGORY_COLORS[cat] ?? '#6b7280' })),
    ...(othersCount > 0 ? [{ cat: 'others', count: othersCount, color: '#6b7280' }] : []),
  ];

  return (
    <div className="fmetrics-chart-panel">
      <div className="fmetrics-panel-header">
        <span className="fmetrics-panel-title">Category Heatmap</span>
      </div>
      <div className="fmetrics-cat-grid">
        {tiles.map(t => (
          <div key={t.cat} className="fmetrics-cat-tile" style={{ '--cat-color': t.color } as React.CSSProperties}>
            <span className="fmetrics-cat-tile-label">{catShort(t.cat)}</span>
            <span className="fmetrics-cat-tile-count">{t.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface FindingsMetricsProps {
  severityTotals: Record<string, number>;
  statusTotals: Record<string, number>;
  categoryTotals: [string, number][];
  sourceTotals: [string, number][];
  total: number;
}

export const FindingsMetrics: React.FC<FindingsMetricsProps> = ({
  severityTotals, statusTotals, categoryTotals, sourceTotals, total,
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
        {categoryTotals.length > 0 && <CategoryGrid data={categoryTotals} />}
      </div>
    </div>
  );
};
