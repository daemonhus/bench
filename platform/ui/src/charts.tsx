import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { useUIStore } from '@bench/stores/ui-store';

// Charts for the Overview, drawn with Recharts and coloured from the design tokens (read from
// the document so they follow the theme).

const TOKENS = [
  '--text-primary', '--text-secondary', '--text-muted', '--border-default', '--border-muted',
  '--bg-secondary', '--bg-surface', '--accent-blue', '--accent-green',
  '--kind-interface', '--kind-source', '--kind-sink', '--kind-dependency', '--kind-externality',
  '--severity-critical', '--severity-high', '--severity-medium', '--severity-low', '--severity-info',
] as const;
type Palette = Record<typeof TOKENS[number], string>;

function usePalette(): Palette {
  const theme = useUIStore((s) => s.theme);
  const [p, setP] = useState<Palette>(() => read());
  useEffect(() => {
    // data-theme flips in an effect; read after it has been applied.
    const id = requestAnimationFrame(() => setP(read()));
    return () => cancelAnimationFrame(id);
  }, [theme]);
  return p;
}
function read(): Palette {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()])) as Palette;
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtLong = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export interface ChartBaseline { t: number; label: string }

function ChartTooltip({ active, payload, label, palette, title, total: showTotal = true, reverse = true }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: number; palette: Palette; title: (t: number) => string;
  /** Sum the series in a Total row (off when they aren't parts of one whole). */
  total?: boolean;
  /** List the series top-down, as stacked bands read (off to keep the order they were drawn in). */
  reverse?: boolean;
}) {
  if (!active || !payload?.length || label == null) return null;
  const total = payload.reduce((n, p) => n + (p.value ?? 0), 0);
  return (
    <div className="home-chart-tip" style={{ background: palette['--bg-secondary'], borderColor: palette['--border-default'] }}>
      <div className="home-chart-tip-title">{title(label)}</div>
      {(reverse ? [...payload].reverse() : payload).map((p) => (
        <div key={p.name} className="home-chart-tip-row">
          <i style={{ background: p.color }} /><span>{p.name}</span><b>{p.value}</b>
        </div>
      ))}
      {showTotal && payload.length > 1 && <div className="home-chart-tip-row home-chart-tip-total"><span>Total</span><b>{total}</b></div>}
    </div>
  );
}

export interface FindingsWeek { t: number; found: number; fixed: number; open: number }

/** Findings per week: found and fixed as bars, the running count of open findings as a line on its
 *  own (right) axis so a large backlog doesn't flatten the weekly bars. Baselines are marked on the
 *  week they were taken in. */
export function FindingsTrendChart({ weeks, baselines }: { weeks: FindingsWeek[]; baselines: ChartBaseline[] }) {
  const palette = usePalette();
  const data = weeks.map((w) => ({ t: w.t, Found: w.found, Fixed: w.fixed, Open: w.open }));
  // The x axis is one category per week, so a baseline is drawn at the end of its week.
  const markers = useMemo(() => {
    const byWeek = new Map<number, string[]>();
    for (const b of baselines) {
      const w = weeks.find((x) => b.t <= x.t && b.t > x.t - WEEK);
      if (w) byWeek.set(w.t, [...(byWeek.get(w.t) ?? []), b.label]);
    }
    return [...byWeek.entries()].map(([t, ls]) => ({ t, label: ls.length > 1 ? `${ls.length} baselines` : ls[0] }));
  }, [weeks, baselines]);
  const axis = { tick: { fill: palette['--text-muted'], fontSize: 11 }, axisLine: false, tickLine: false } as const;
  const openNow = weeks[weeks.length - 1]?.open ?? 0;
  return (
    <div className="home-chart" role="img" aria-label={`Findings found and fixed per week over ${weeks.length} weeks; now ${openNow} open`}>
      <ResponsiveContainer width="100%" height={180}>
        {/* The top margin leaves room for baseline labels. */}
        <ComposedChart data={data} margin={{ top: 16, right: -10, bottom: 0, left: -18 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={palette['--border-muted']} />
          <XAxis dataKey="t" tickFormatter={fmtDate} tick={{ fill: palette['--text-muted'], fontSize: 11 }}
            axisLine={{ stroke: palette['--border-default'] }} tickLine={false} minTickGap={24} />
          <YAxis yAxisId="weekly" allowDecimals={false} width={44} {...axis} />
          <YAxis yAxisId="open" orientation="right" allowDecimals={false} width={44} {...axis} />
          <Tooltip cursor={{ fill: palette['--bg-surface'], fillOpacity: 0.5 }}
            content={<ChartTooltip palette={palette} total={false} reverse={false} title={(t) => `Week ending ${fmtLong(t)}`} />} />
          {markers.map((m) => (
            <ReferenceLine key={m.t} x={m.t} yAxisId="weekly" stroke={palette['--text-muted']} strokeDasharray="3 3" strokeOpacity={0.6}
              label={{ value: m.label, position: 'top', fill: palette['--text-muted'], fontSize: 10 }} />
          ))}
          <Bar yAxisId="weekly" dataKey="Found" fill={palette['--accent-blue']} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar yAxisId="weekly" dataKey="Fixed" fill={palette['--accent-green']} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="open" type="linear" dataKey="Open" stroke={palette['--text-primary']} strokeWidth={2}
            dot={{ r: 2.5, fill: palette['--text-primary'], strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Mapped features at the end of each week, one line per kind (the attack surface growing). */
export function SurfaceChart({ points, kinds, labels }: {
  points: Record<string, number>[]; kinds: string[]; labels: Record<string, string>;
}) {
  const palette = usePalette();
  const color = (k: string) => palette[`--kind-${k}` as keyof Palette];
  const now = kinds.reduce((n, k) => n + (points[points.length - 1]?.[k] ?? 0), 0);
  return (
    <div className="home-chart" role="img" aria-label={`Mapped features over ${points.length - 1} weeks, by kind; now ${now}`}>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} stroke={palette['--border-muted']} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
            tickFormatter={fmtDate} tick={{ fill: palette['--text-muted'], fontSize: 11 }}
            axisLine={{ stroke: palette['--border-default'] }} tickLine={false} minTickGap={36} />
          <YAxis allowDecimals={false} tick={{ fill: palette['--text-muted'], fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
          <Tooltip cursor={{ stroke: palette['--border-default'] }}
            content={<ChartTooltip palette={palette} title={(t) => `Week ending ${fmtLong(t)}`} />} />
          {kinds.map((k) => (
            <Line key={k} type="linear" dataKey={k} name={labels[k] ?? k} stroke={color(k)} strokeWidth={2}
              dot={{ r: 2.5, fill: color(k), strokeWidth: 0 }} activeDot={{ r: 4 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
