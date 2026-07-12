import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActivityBucket, BranchInfo, Feature, FeatureKind, Finding, GraphCommit, ReconciledHead, ServiceProfile, Severity } from '../core/types';
import { findingsApi, featuresApi, gitApi, reconcileApi } from '../core/api';
import { useEvents } from '../core/use-events';
import { useProfileStore } from '../stores/profile-store';
import { useRepoStore } from '../stores/repo-store';
import { computeGraphLayout, attributeBranches, parseMergedBranch, LANE_WIDTH, ROW_HEIGHT, NODE_RADIUS, laneColor, laneX, rowY, edgePath } from '../core/graph-layout';
import { KIND_COLORS } from './FeatureCard';
import { avatarInitials, avatarColor } from '../core/avatar';
import { FeatureMiniCard, FindingMiniCard, useHoverCard } from './mini-cards';
import { categoryMeta, SEVERITY_RANK } from '../core/finding-categories';
import { buildFeatureMap } from '../core/feature-map-layout';
import type { FeatureMapNode } from '../core/feature-map-layout';

// ---------------------------------------------------------------------------
// Project Overview, three columns:
//   1. Repository context (profile badges), git state, history graph
//   2. Findings: open counts, systemic issues, RRD and MTTR charts
//   3. Features: counts by kind, feature relationship map
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const KIND_ORDER: FeatureKind[] = ['interface', 'source', 'sink', 'dependency', 'externality'];
const KIND_LABELS: Record<FeatureKind, string> = {
  interface: 'Interfaces',
  source: 'Sources',
  sink: 'Sinks',
  dependency: 'Dependencies',
  externality: 'Externalities',
};

function parseDate(s?: string): Date | null {
  if (!s) return null;
  // SQLite datetimes are "YYYY-MM-DD HH:MM:SS" in UTC; ISO strings pass through.
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function relativeTime(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h ago`;
  const days = h / 24;
  if (days < 45) return `${Math.round(days)}d ago`;
  return d.toLocaleDateString();
}

function humanizeDuration(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${hours.toFixed(1)} hrs`;
  return `${(hours / 24).toFixed(1)} days`;
}

function titleCase(s: string): string {
  return s.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Conditional-formatting colour scale for open counts: green → amber → red. */
function openScaleColor(open: number, maxOpen: number): string {
  if (open === 0) return 'var(--accent-green)';
  const t = maxOpen > 0 ? Math.min(1, open / maxOpen) : 0;
  return t <= 0.5
    ? `color-mix(in srgb, var(--severity-medium) ${Math.round(t * 200)}%, var(--accent-green))`
    : `color-mix(in srgb, var(--severity-critical) ${Math.round((t - 0.5) * 200)}%, var(--severity-medium))`;
}

/** Panel heading that deep-links to the page owning the data. */
function PanelTitle({ children, href }: { children: ReactNode; href?: string }) {
  if (!href) return <h3 className="ovp-panel-title">{children}</h3>;
  return (
    <h3 className="ovp-panel-title">
      <a className="ovp-panel-title-link" href={href}>
        {children}
        <svg className="ovp-panel-title-icon" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l5-5M4 3.5h4.5V8" />
        </svg>
      </a>
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Weekly buckets (RRD + MTTR)
// ---------------------------------------------------------------------------

interface WeekBucket {
  start: Date;
  label: string;
  /** New findings created this week (RRD). */
  raised: number;
  /** Fix durations (ms) of findings resolved this week (MTTR). */
  fixTimes: number[];
}

/** Bucket findings into creation/resolution weeks, ending at the current week. */
function bucketByWeek(findings: Finding[], maxWeeks = 16): WeekBucket[] {
  const weekMs = 7 * 24 * 3_600_000;
  // Anchor to the start of the current week (Monday).
  const anchor = new Date();
  anchor.setHours(0, 0, 0, 0);
  anchor.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));

  const created = findings.map((f) => parseDate(f.createdAt)).filter((d): d is Date => !!d);
  let weeks = 8;
  if (created.length > 0) {
    const oldest = Math.min(...created.map((d) => d.getTime()));
    weeks = Math.ceil((anchor.getTime() + weekMs - oldest) / weekMs);
    weeks = Math.min(maxWeeks, Math.max(8, weeks));
  }

  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(anchor.getTime() - i * weekMs);
    buckets.push({
      start,
      label: start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      raised: 0,
      fixTimes: [],
    });
  }
  const first = buckets[0].start.getTime();
  const bucketIdx = (d: Date) => Math.floor((d.getTime() - first) / weekMs);

  for (const f of findings) {
    const c = parseDate(f.createdAt);
    if (c) {
      const i = bucketIdx(c);
      if (i >= 0 && i < buckets.length) buckets[i].raised++;
    }
    const r = parseDate(f.resolvedAt);
    if (c && r && r.getTime() >= c.getTime()) {
      const i = bucketIdx(r);
      if (i >= 0 && i < buckets.length) buckets[i].fixTimes.push(r.getTime() - c.getTime());
    }
  }
  return buckets;
}

/** Compact weekly column chart. */
function WeekColumns({ buckets, values, tooltips, labelMax }: {
  buckets: WeekBucket[];
  values: number[];
  tooltips: string[];
  labelMax?: string;
}) {
  const max = Math.max(1e-9, ...values);
  const maxIdx = values.indexOf(Math.max(...values));
  return (
    <div className="ovp-chart">
      <div className="ovp-chart-plot">
        {buckets.map((b, i) => {
          const pct = Math.max(values[i] > 0 ? 4 : 0, (values[i] / max) * 100);
          return (
            <div key={i} className="ovp-chart-slot" data-tooltip={tooltips[i]}>
              {i === maxIdx && values[i] > 0 && labelMax && (
                // Absolutely positioned so the label never compresses its bar.
                <span className="ovp-chart-value" style={{ bottom: `calc(${pct}% + 3px)` }}>{labelMax}</span>
              )}
              <div className="ovp-chart-bar" style={{ height: `${pct}%` }} />
            </div>
          );
        })}
      </div>
      <div className="ovp-chart-x">
        <span>{buckets[0].label}</span>
        <span>{buckets[buckets.length - 1].label}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit activity timeline
// ---------------------------------------------------------------------------

const ACT_VISIBLE = 12;
const ACT_SCALES = ['day', 'week', 'month', 'year'] as const;
type ActScale = (typeof ACT_SCALES)[number];
const ACT_PERIODS: Record<ActScale, number> = { day: 120, week: 52, month: 36, year: 10 };

function actLabel(start: string, scale: ActScale): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (scale === 'year') return String(d.getUTCFullYear());
  if (scale === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Commit activity timeline: bars for commits, author avatars as markers.
 *  The visible window pans with the wheel while hovered, or the arrows;
 *  the dropdown switches the scale between day, week, month, and year. */
function ActivityTimeline() {
  const [scale, setScale] = useState<ActScale>('week');
  const [buckets, setBuckets] = useState<ActivityBucket[] | null>(null);
  const [end, setEnd] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const endRef = useRef(end);
  const lenRef = useRef(0);
  endRef.current = end;
  lenRef.current = buckets?.length ?? 0;

  const load = (sc: ActScale) => {
    gitApi.activity(sc, ACT_PERIODS[sc])
      .then((b) => {
        setBuckets(b);
        setEnd(b.length);
        setFocus(null);
      })
      .catch(() => setBuckets([]));
  };
  useEffect(() => { load(scale); }, [scale]);
  useEvents('git', () => load(scale));

  const weeks = buckets ?? [];
  const minEnd = Math.min(ACT_VISIBLE, weeks.length);
  const canBack = end > minEnd;
  const canForward = end < weeks.length;

  // Wheel pans the window. React registers wheel listeners passively, so a
  // native non-passive listener is needed to keep the page from scrolling
  // while the pointer drives the timeline; at either boundary the event is
  // left alone and the page scrolls as normal.
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      const lo = Math.min(ACT_VISIBLE, lenRef.current);
      // Scroll down walks back in time, scroll up walks forward. Capture the
      // event only while the window can still move that way.
      const movable = e.deltaY > 0 ? endRef.current > lo : endRef.current < lenRef.current;
      if (!movable) {
        acc = 0;
        return;
      }
      e.preventDefault();
      acc += e.deltaY;
      const step = Math.trunc(acc / 40);
      if (step === 0) return;
      acc -= step * 40;
      const next = Math.max(lo, Math.min(lenRef.current, endRef.current - step));
      if (next !== endRef.current) {
        endRef.current = next;
        setEnd(next);
        setFocus(null);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // The chart div only exists once data has arrived, so re-attach then.
  }, [(buckets?.length ?? 0) > 0]);

  const header = (
    <div className="ovp-repo-header">
      <PanelTitle>Activity</PanelTitle>
      <div className="ovp-act-nav">
        <select
          className="finding-edit-select ovp-act-scale-select"
          value={scale}
          onChange={(e) => setScale(e.target.value as ActScale)}
          aria-label="Timeline scale"
        >
          {ACT_SCALES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          onClick={() => { setEnd((v) => Math.max(minEnd, v - 1)); setFocus(null); }}
          disabled={!canBack}
          aria-label="Earlier"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7.5 2.5L4 6l3.5 3.5" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => { setEnd((v) => Math.min(weeks.length, v + 1)); setFocus(null); }}
          disabled={!canForward}
          aria-label="Later"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4.5 2.5L8 6l-3.5 3.5" />
          </svg>
        </button>
      </div>
    </div>
  );

  if (weeks.length === 0) {
    return (
      <>
        {header}
        <div className="ovp-empty">{buckets === null ? 'Loading activity…' : 'No commit activity.'}</div>
      </>
    );
  }

  const win = weeks.slice(Math.max(0, end - ACT_VISIBLE), end);
  const maxVal = Math.max(...win.map((w) => w.commits));
  const maxIdx = win.findIndex((w) => w.commits === maxVal);
  const focused = focus != null ? win[focus] : null;

  const totals = win.reduce(
    (t, w) => ({
      commits: t.commits + w.commits,
      merges: t.merges + w.merges,
      additions: t.additions + w.additions,
      deletions: t.deletions + w.deletions,
    }),
    { commits: 0, merges: 0, additions: 0, deletions: 0 },
  );
  const shown = focused ?? totals;
  const firstLabel = actLabel(win[0].start, scale);
  const lastLabel = actLabel(win[win.length - 1].start, scale);
  const stripWhen = focused
    ? `${scale === 'week' ? 'w/c ' : ''}${actLabel(focused.start, scale)}`
    : firstLabel === lastLabel ? firstLabel : `${firstLabel} to ${lastLabel}`;

  return (
    <div className="ovp-act">
      {header}
      <div className="ovp-act-window" ref={chartRef}>
      <div className="ovp-act-strip">
        <span className="ovp-act-strip-when">{stripWhen}</span>
        <span>{shown.commits} commit{shown.commits === 1 ? '' : 's'}</span>
        <span>{shown.merges} merge{shown.merges === 1 ? '' : 's'}</span>
        <span className="ovp-act-add">+{shown.additions.toLocaleString()}</span>
        <span className="ovp-act-del">−{shown.deletions.toLocaleString()}</span>
        {focused && focused.authors.length > 0 && (
          <span className="ovp-act-strip-authors">
            {focused.authors.map((a) => a.name).join(', ')}
          </span>
        )}
      </div>
      <div className="ovp-chart-plot ovp-act-plot">
        {win.map((w, i) => {
          const pct = maxVal > 0 ? Math.max(w.commits > 0 ? 4 : 0, (w.commits / maxVal) * 100) : 0;
          return (
            <div
              key={w.start}
              className={`ovp-chart-slot${focus === i ? ' ovp-act-slot-focus' : ''}`}
              onMouseEnter={() => setFocus(i)}
              onMouseLeave={() => setFocus(null)}
            >
              {i === maxIdx && maxVal > 0 && focus == null && (
                <span className="ovp-chart-value" style={{ bottom: `calc(${pct}% + 3px)` }}>{maxVal}</span>
              )}
              <div className="ovp-chart-bar" style={{ height: `${pct}%` }} />
            </div>
          );
        })}
      </div>
      <div className="ovp-act-markers">
        {win.map((w, i) => (
          <div
            key={w.start}
            className="ovp-act-marker-slot"
            onMouseEnter={() => setFocus(i)}
            onMouseLeave={() => setFocus(null)}
          >
            {/* Facepile: most prominent author first and on top of the stack. */}
            {w.authors.slice(0, 3).map((a, j) => (
              <span
                key={a.name}
                className="comment-avatar ovp-act-avatar"
                style={{ backgroundColor: avatarColor(a.name), zIndex: 3 - j }}
                data-tooltip={`${a.name}: ${a.commits} commit${a.commits === 1 ? '' : 's'}`}
                aria-label={a.name}
              >
                {avatarInitials(a.name)}
              </span>
            ))}
            {w.authors.length > 3 && (
              <span className="ovp-act-avatar-more">+{w.authors.length - 3}</span>
            )}
          </div>
        ))}
      </div>
      <div className="ovp-chart-x">
        <span>{firstLabel}</span>
        {lastLabel !== firstLabel && <span>{lastLabel}</span>}
      </div>
      </div>
    </div>
  );
}

/** Category heatmap: one square per finding, severity-coloured, hover mini-card. */
function CategoryHeatmap({ systemic, findingsByCategory, isOpen }: {
  systemic: [string, { open: number; total: number }][];
  findingsByCategory: Map<string, Finding[]>;
  isOpen: (f: Finding) => boolean;
}) {
  const { card, containerRef, showCard, cancelClose, scheduleClose } = useHoverCard<Finding>();
  const maxOpen = Math.max(1, ...systemic.map(([, c]) => c.open));

  return (
    <div className="ovp-cats" ref={containerRef}>
      {systemic.map(([cat, counts]) => {
        const meta = categoryMeta(cat);
        const scale = openScaleColor(counts.open, maxOpen);
        // Open findings first (worst severity leading), resolved dimmed after.
        const list = [...(findingsByCategory.get(cat) ?? [])].sort((a, b) => {
          const openDiff = Number(isOpen(b)) - Number(isOpen(a));
          if (openDiff !== 0) return openDiff;
          return (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5);
        });
        return (
          <div key={cat} className="ovp-cat-row">
            <div className="ovp-cat-head">
              <div className="ovp-cat-text">
                <span className="ovp-cat-name">{meta.label}</span>
                <span className="ovp-cat-desc">{meta.desc}</span>
              </div>
              <span className="ovp-cat-total">{counts.total} total</span>
              <span
                className="ovp-cat-open-badge"
                style={{
                  color: scale,
                  borderColor: `color-mix(in srgb, ${scale} 45%, transparent)`,
                  background: `color-mix(in srgb, ${scale} 14%, transparent)`,
                }}
              >
                {counts.open} open
              </span>
            </div>
            <div className="ovp-cat-squares">
              {list.map((f) => (
                <a
                  key={f.id}
                  className={`ovp-kind-square${isOpen(f) ? '' : ' ovp-cat-square-resolved'}`}
                  style={{ background: `var(--severity-${f.severity})` }}
                  href={`#/findings/${f.id}`}
                  aria-label={f.title}
                  onMouseEnter={(e) => showCard(f, e.currentTarget)}
                  onMouseLeave={scheduleClose}
                />
              ))}
            </div>
          </div>
        );
      })}
      {card && (
        <FindingMiniCard
          finding={card.payload}
          isOpen={isOpen(card.payload)}
          style={{ left: card.left, top: card.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}

/** Waffle grid: one square per feature, grouped by kind, hover mini-card. */
function KindSquares({ features, openByFeature }: {
  features: Feature[];
  openByFeature: Map<string, number>;
}) {
  const { card, containerRef, showCard, cancelClose, scheduleClose } = useHoverCard<Feature>();

  const titleById = new Map(features.map((f) => [f.id, f.title]));
  const byKind = new Map<FeatureKind, Feature[]>();
  for (const f of features) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }

  return (
    <div className="ovp-kinds" ref={containerRef}>
      {KIND_ORDER.map((kind) => {
        const list = byKind.get(kind) ?? [];
        return (
          <div key={kind} className="ovp-kind-row">
            <span className="ovp-kind-label">{KIND_LABELS[kind]}</span>
            <span className="ovp-kind-squares">
              {list.map((f) => (
                <a
                  key={f.id}
                  className={`ovp-kind-square${(openByFeature.get(f.id) ?? 0) > 0 ? ' ovp-kind-square-alert' : ''}`}
                  style={{ background: KIND_COLORS[kind] }}
                  href={`#/features/${f.id}`}
                  aria-label={f.title}
                  onMouseEnter={(e) => showCard(f, e.currentTarget)}
                  onMouseLeave={scheduleClose}
                />
              ))}
              {list.length === 0 && <span className="ovp-kind-none">—</span>}
            </span>
            <span className="ovp-kind-count">{list.length}</span>
          </div>
        );
      })}
      {card && (
        <FeatureMiniCard
          feature={card.payload}
          openCount={openByFeature.get(card.payload.id) ?? 0}
          links={(card.payload.linkedFeatures ?? []).filter((lf) => titleById.has(lf.id))}
          titleById={titleById}
          className="ovp-kind-card"
          style={{ left: card.left, top: card.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feature map — static kind-banded preview of the planned force layout
// (PLAN-feature-graph.md). Real features when annotated; sample data otherwise.
// ---------------------------------------------------------------------------

interface SampleNode {
  id?: undefined;
  kind: FeatureKind;
  label: string;
  tooltip: string;
  feature?: undefined;
  x: number;
  y: number;
}

const SAMPLE_TIP = 'Sample data. Annotate features to populate the map.';
const SAMPLE_MAP: { nodes: SampleNode[]; edges: [number, number][] } = {
  nodes: [
    { x: 10, y: 16, kind: 'interface', label: '/orders/{id}', tooltip: SAMPLE_TIP },
    { x: 10, y: 46, kind: 'interface', label: '/orders', tooltip: SAMPLE_TIP },
    { x: 10, y: 76, kind: 'interface', label: '/webhooks/pay', tooltip: SAMPLE_TIP },
    { x: 42, y: 30, kind: 'source', label: 'postgresql://orders', tooltip: SAMPLE_TIP },
    { x: 42, y: 76, kind: 'dependency', label: 'billing-svc', tooltip: SAMPLE_TIP },
    { x: 88, y: 16, kind: 'sink', label: 'kafka://events', tooltip: SAMPLE_TIP },
    { x: 88, y: 52, kind: 'sink', label: 's3://invoices', tooltip: SAMPLE_TIP },
    { x: 74, y: 86, kind: 'externality', label: 'nightly prune', tooltip: SAMPLE_TIP },
  ],
  edges: [[0, 3], [1, 3], [0, 5], [1, 6], [2, 4], [4, 6], [7, 3]],
};

type AnyMapNode = SampleNode | FeatureMapNode;

function FeatureMap({ features, openByFeature, worstByFeature }: {
  features: Feature[];
  openByFeature: Map<string, number>;
  worstByFeature: Map<string, Severity>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  // Session-only repins from dragging nodes: id → position override.
  const [pins, setPins] = useState<Map<string, { x: number; y: number }>>(new Map());
  const mapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  // Grace period before the card closes, so the pointer can travel from the
  // node into the card (which is interactive: its links are clickable).
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openCard = (i: number) => {
    cancelClose();
    setHovered(i);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setHovered(null), 180);
  };
  useEffect(() => cancelClose, []);

  const isSample = features.length === 0;
  const layout = useMemo(
    () => (isSample ? SAMPLE_MAP : buildFeatureMap(features, openByFeature)),
    [isSample, features, openByFeature],
  );
  const { edges } = layout;
  // Apply session drag repins on top of the computed layout.
  const typedNodes: AnyMapNode[] = layout.nodes.map((n) => {
    const pin = n.id ? pins.get(n.id) : undefined;
    return pin ? { ...n, x: pin.x, y: pin.y } : n;
  });
  const titleById = new Map(features.map((f) => [f.id, f.title]));

  // Hover emphasis: the hovered node and its neighbours stay loud; the rest dim.
  const emphasis = useMemo(() => {
    if (hovered == null) return null;
    const keep = new Set<number>([hovered]);
    for (const [a, b] of edges) {
      if (a === hovered) keep.add(b);
      if (b === hovered) keep.add(a);
    }
    return keep;
  }, [hovered, edges]);

  // Drag to repin (session-only). A real drag suppresses the click-through.
  const onPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { id, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const map = mapRef.current;
    if (!drag || !map) return;
    const r = map.getBoundingClientRect();
    const x = Math.max(4, Math.min(96, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.max(6, Math.min(90, ((e.clientY - r.top) / r.height) * 100));
    drag.moved = true;
    setPins((prev) => new Map(prev).set(drag.id, { x, y }));
  };
  const onPointerUp = () => {
    // Cleared on the next tick so onClick can still see `moved`.
    setTimeout(() => { dragRef.current = null; }, 0);
  };
  const onNodeClick = (e: React.MouseEvent) => {
    if (dragRef.current?.moved) e.preventDefault();
  };

  const card = hovered != null ? typedNodes[hovered] : null;
  const cardFeature = card?.feature;
  const cardOpen = card?.id ? openByFeature.get(card.id) ?? 0 : 0;
  const cardLinks = (cardFeature?.linkedFeatures ?? []).filter((lf) => titleById.has(lf.id));

  // Card placement in px, measured against the map and clamped inside it
  // (a fixed flip threshold guesses; at 300px wide the card overflowed).
  const CARD_W = 300;
  const cardPos = (() => {
    const map = mapRef.current;
    if (!card || !map) return null;
    const rect = map.getBoundingClientRect();
    const nx = (card.x / 100) * rect.width;
    const ny = (card.y / 100) * rect.height;
    let left = nx + 16;
    if (left + CARD_W > rect.width - 4) left = nx - 16 - CARD_W; // flip left
    left = Math.max(4, Math.min(rect.width - CARD_W - 4, left));
    // translateY(-50%) centres on the node; keep the centre far enough from
    // the panel edges that a typical card stays inside.
    const top = Math.max(105, Math.min(rect.height - 105, ny));
    return { left, top };
  })();

  return (
    <>
      <div className="ovp-map" ref={mapRef}>
        <svg className="ovp-map-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {edges.map(([a, b], i) => {
            const n1 = typedNodes[a];
            const n2 = typedNodes[b];
            const dimmed = emphasis != null && !(emphasis.has(a) && emphasis.has(b) && (a === hovered || b === hovered));
            return (
              <line
                key={i}
                x1={n1.x} y1={n1.y}
                x2={n2.x} y2={n2.y}
                className={`ovp-map-edge${dimmed ? ' ovp-map-edge-dim' : ''}`}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {typedNodes.map((n, i) => {
          const worst = n.id ? worstByFeature.get(n.id) : undefined;
          const r = 'r' in n && n.r ? n.r : 8;
          const inner = (
            <>
              <span
                className="ovp-map-dot"
                style={{
                  background: KIND_COLORS[n.kind],
                  width: r * 2,
                  height: r * 2,
                  boxShadow: worst
                    ? `0 0 0 2.5px color-mix(in srgb, var(--severity-${worst}) 65%, transparent)`
                    : undefined,
                }}
              />
              <span className="ovp-map-node-label">{n.label}</span>
            </>
          );
          const dimmed = emphasis != null && !emphasis.has(i);
          const style = { left: `${n.x}%`, top: `${n.y}%` };
          return n.id ? (
            <a
              key={n.id}
              className={`ovp-map-node-el${dimmed ? ' ovp-map-node-dim' : ''}`}
              style={style}
              href={`#/features/${n.id}`}
              onMouseEnter={() => openCard(i)}
              onMouseLeave={scheduleClose}
              onPointerDown={onPointerDown(n.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onClick={onNodeClick}
            >
              {inner}
            </a>
          ) : (
            <span key={i} className="ovp-map-node-el" style={style} data-tooltip={(n as SampleNode).tooltip}>
              {inner}
            </span>
          );
        })}

        {/* Mini-card hover detail for real features */}
        {card && cardFeature && cardPos && (
          <FeatureMiniCard
            feature={cardFeature}
            openCount={cardOpen}
            links={cardLinks}
            titleById={titleById}
            className="ovp-map-card-measured"
            style={{ left: cardPos.left, top: cardPos.top }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          />
        )}
      </div>
      <div className="ovp-map-legend">
        {KIND_ORDER.map((kind) => (
          <span key={kind} className="ovp-map-legend-item">
            <span className="ovp-severity-dot" style={{ background: KIND_COLORS[kind] }} />
            {KIND_LABELS[kind]}
          </span>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Repository context — profile values as badges
// ---------------------------------------------------------------------------

interface CtxBadge {
  label: string;
  field: string;
  tone?: 'warn' | 'danger';
}

function profileBadges(p: ServiceProfile): CtxBadge[] {
  const badges: CtxBadge[] = [];
  const add = (label: string, field: string, tone?: 'warn' | 'danger') =>
    badges.push({ label, field, tone });

  if (p.externallyFacing === 'full') add('External', 'Externally facing', 'warn');
  if (p.externallyFacing === 'partial') add('Partially External', 'Externally facing', 'warn');
  if (p.externallyFacing === 'none') add('Internal Only', 'Externally facing');

  const sensitivity: Record<string, string> = {
    public: 'Public Data', internal: 'Internal Data', pii: 'PII',
    payment: 'PCI / CHD', phi: 'PHI', credentials: 'Credentials',
  };
  if (p.dataSensitivity) {
    add(sensitivity[p.dataSensitivity] ?? titleCase(p.dataSensitivity), 'Data sensitivity',
      ['pii', 'payment', 'phi', 'credentials'].includes(p.dataSensitivity) ? 'warn' : undefined);
  }

  if (p.criticality) {
    add(`${titleCase(p.criticality)} Criticality`, 'Criticality',
      p.criticality === 'critical' ? 'danger' : p.criticality === 'high' ? 'warn' : undefined);
  }
  if (p.tenancy) add(titleCase(p.tenancy), 'Tenancy', p.tenancy === 'multi-tenant' ? 'warn' : undefined);
  if (p.compute) add(p.compute === 'vps' ? 'VPS' : titleCase(p.compute), 'Compute');
  if (p.lifecycle) add(titleCase(p.lifecycle), 'Lifecycle');

  const edge: Record<string, string> = {
    'waf': 'WAF', 'api-gateway': 'API Gateway', 'rate-limiting': 'Rate Limited',
    'ddos-protection': 'DDoS Protected', 'none': 'No Edge Protections',
  };
  for (const v of p.edgeProtections) {
    add(edge[v] ?? titleCase(v), 'Edge protections', v === 'none' ? 'warn' : undefined);
  }

  const auth: Record<string, string> = {
    'none': 'No Auth', 'api-key': 'API Key Auth', 'oauth-oidc': 'OAuth/OIDC',
    'mtls': 'mTLS', 'session': 'Session Auth', 'gateway-terminated': 'Gateway Auth',
  };
  for (const v of p.authenticationModel) {
    add(auth[v] ?? titleCase(v), 'Authentication model', v === 'none' ? 'danger' : undefined);
  }

  const compliance: Record<string, string> = {
    'pci-dss': 'PCI-DSS', 'hipaa': 'HIPAA', 'soc2': 'SOC 2', 'gdpr': 'GDPR', 'none': 'No Compliance Scope',
  };
  for (const v of p.complianceScope) add(compliance[v] ?? titleCase(v), 'Compliance scope');

  const consumers: Record<string, string> = {
    'first-party-frontend': 'First-party Consumers', 'internal-services': 'Internal Consumers',
    'third-party-partners': 'Partner Consumers', 'general-public': 'Public Consumers',
  };
  for (const v of p.consumerType) {
    add(consumers[v] ?? titleCase(v), 'Consumer type', v === 'general-public' ? 'warn' : undefined);
  }

  return badges;
}

// ---------------------------------------------------------------------------

interface OverviewData {
  graph: GraphCommit[];
  branches: BranchInfo[];
  reconciled: ReconciledHead | null;
  findings: Finding[];
  features: Feature[];
}

export function OverviewView() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profile = useProfileStore((s) => s.profile);
  const profileConfigured = useProfileStore((s) => s.configured);
  const loadProfile = useProfileStore((s) => s.load);
  const repoName = useRepoStore((s) => s.repoName);

  const loadAll = async () => {
    try {
      const [graph, branches, reconciled, findings, features] = await Promise.all([
        gitApi.listGraph(80).catch(() => [] as GraphCommit[]),
        gitApi.listBranches().catch(() => [] as BranchInfo[]),
        reconcileApi.head().catch(() => null),
        findingsApi.list().catch(() => [] as Finding[]),
        featuresApi.list().catch(() => [] as Feature[]),
      ]);
      setData({ graph, branches, reconciled, findings: findings as Finding[], features: features as Feature[] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { loadAll(); loadProfile(); }, []);
  useEvents(['annotations', 'git', 'profile'], () => { loadAll(); loadProfile(); });

  const derived = useMemo(() => {
    if (!data) return null;
    const { graph, findings, features } = data;

    const head = graph[0] ?? null;
    // Stash entries also have multiple parents; they are not merges.
    const isStash = (c: GraphCommit) => /^(WIP on|index on) /.test(c.subject);
    const lastMerge = graph.find((c) => c.parents && c.parents.length > 1 && !isStash(c)) ?? null;

    const isOpen = (f: Finding) => f.status !== 'closed' && !f.resolvedCommit;
    const open = findings.filter(isOpen);
    const bySeverity = new Map<Severity, number>();
    for (const f of open) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);

    // Systemic issues: categories ranked by open findings, then total.
    const byCategory = new Map<string, { open: number; total: number }>();
    const findingsByCategory = new Map<string, Finding[]>();
    for (const f of findings) {
      const cat = f.category || 'uncategorised';
      const entry = byCategory.get(cat) ?? { open: 0, total: 0 };
      entry.total++;
      if (isOpen(f)) entry.open++;
      byCategory.set(cat, entry);
      findingsByCategory.set(cat, [...(findingsByCategory.get(cat) ?? []), f]);
    }
    const systemic = [...byCategory.entries()]
      .sort((a, b) => b[1].open - a[1].open || b[1].total - a[1].total)
      .slice(0, 6);

    // Open findings per feature (for map halos and tooltips).
    const openByFeature = new Map<string, number>();
    const worstByFeature = new Map<string, Severity>();
    for (const f of open) {
      for (const fid of f.features ?? []) {
        openByFeature.set(fid, (openByFeature.get(fid) ?? 0) + 1);
        const current = worstByFeature.get(fid);
        if (!current || (SEVERITY_RANK[f.severity] ?? 5) < (SEVERITY_RANK[current] ?? 5)) {
          worstByFeature.set(fid, f.severity);
        }
      }
    }

    const allFixTimes: number[] = [];
    for (const f of findings) {
      const c = parseDate(f.createdAt);
      const r = parseDate(f.resolvedAt);
      if (c && r && r.getTime() >= c.getTime()) allFixTimes.push(r.getTime() - c.getTime());
    }
    const avgFixMs = allFixTimes.length > 0 ? allFixTimes.reduce((a, b) => a + b, 0) / allFixTimes.length : null;

    const buckets = bucketByWeek(findings);
    const layout = computeGraphLayout(graph);
    const branchOf = attributeBranches(graph);

    return {
      head, lastMerge, open, bySeverity, systemic, findingsByCategory, isOpen, openByFeature, worstByFeature,
      avgFixMs, fixedCount: allFixTimes.length, buckets, layout, branchOf,
    };
  }, [data]);

  if (error) {
    return <div className="ovp"><div className="ovp-loading">Failed to load overview: {error}</div></div>;
  }
  if (!data || !derived) {
    return <div className="ovp"><div className="ovp-loading">Loading overview…</div></div>;
  }

  const { branches, reconciled, graph, findings } = data;
  const {
    head, lastMerge, open, bySeverity, systemic, findingsByCategory, isOpen, openByFeature, worstByFeature,
    avgFixMs, fixedCount, buckets, layout, branchOf,
  } = derived;

  const headDate = head ? parseDate(head.date) : null;
  const mergeDate = lastMerge ? parseDate(lastMerge.date) : null;
  const reconciledShort = reconciled?.reconciledHead ? reconciled.reconciledHead.slice(0, 7) : null;
  const localBranches = branches.filter((b) => !b.isRemote);

  const graphWidth = (layout.maxLanes + 1) * LANE_WIDTH;
  const svgHeight = graph.length * ROW_HEIGHT;

  const mttrValues = buckets.map((b) =>
    b.fixTimes.length > 0 ? b.fixTimes.reduce((a, v) => a + v, 0) / b.fixTimes.length : 0);

  const ctxBadges = profileBadges(profile);

  return (
    <div className="ovp">
      <div className="ovp-columns">

        {/* ── Column 1: context + git state ───────────────────────── */}
        <div className="ovp-col">
          <div className="ovp-panel">
            <div className="ovp-repo-header ovp-project-header">
              <h3 className="ovp-project-title">{repoName || 'Project'}</h3>
              <a className="ovp-context-link" href="#/config">
                Context
                <span className="ovp-context-link-arrow" aria-hidden="true">→</span>
              </a>
            </div>
            {!profileConfigured ? (
              <div className="ovp-empty">
                Service profile not configured yet. <a className="ovp-inline-link" href="#/config">Open Config</a>
              </div>
            ) : !profile.description && !profile.owner && ctxBadges.length === 0 ? (
              <div className="ovp-empty">
                Profile saved but no attributes set yet. <a className="ovp-inline-link" href="#/config">Open Config</a>
              </div>
            ) : (
              <>
                {profile.description && <blockquote className="ovp-ctx-desc">{profile.description}</blockquote>}
                {(profile.owner || ctxBadges.length > 0) && (
                  <div className="ovp-ctx-badges">
                    {profile.owner && (
                      <span className="ovp-ctx-badge" data-tooltip="Owner">Owner: {profile.owner}</span>
                    )}
                    {ctxBadges.map((b, i) => (
                      <span
                        key={i}
                        className={`ovp-ctx-badge${b.tone ? ` ovp-ctx-badge-${b.tone}` : ''}`}
                        data-tooltip={b.field}
                      >
                        {b.label}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="ovp-panel">
            <div className="ovp-repo-header">
              <PanelTitle href="#/browse">Git state</PanelTitle>
              {reconciled && (
                reconciled.isFullyReconciled ? (
                  <span className="ovp-recon-chip ovp-recon-ok">
                    Reconciled to {reconciledShort ?? reconciled.gitHead.slice(0, 7)}
                  </span>
                ) : (
                  <span className="ovp-recon-chip ovp-recon-behind">
                    {reconciled.unreconciled?.length ?? 0} file{(reconciled.unreconciled?.length ?? 0) === 1 ? '' : 's'} not reconciled
                    {reconciledShort ? ` (at ${reconciledShort})` : ''}
                  </span>
                )
              )}
            </div>

            <div className="ovp-git-stats">
              <div className="ovp-stat-inline">
                <div className="ovp-stat-label">Last pull (HEAD)</div>
                <div className="ovp-stat-value">
                  {head ? <span className="ovp-mono">{head.shortHash}</span> : '—'}
                  {headDate && <span className="ovp-stat-when">{relativeTime(headDate)}</span>}
                </div>
                <div className="ovp-stat-sub" title={head?.subject}>{head?.subject ?? 'No commits'}</div>
              </div>
              <div className="ovp-stat-inline">
                <div className="ovp-stat-label">Last merge</div>
                <div className="ovp-stat-value">
                  {lastMerge ? <span className="ovp-mono">{lastMerge.shortHash}</span> : '—'}
                  {mergeDate && <span className="ovp-stat-when">{relativeTime(mergeDate)}</span>}
                </div>
                <div className="ovp-stat-sub" title={lastMerge?.subject}>
                  {lastMerge?.subject ?? 'No merge commits in recent history'}
                </div>
              </div>
            </div>

            <h4 className="ovp-subtitle">Branches</h4>
            <div className="ovp-branches">
              {localBranches.length === 0 && <div className="ovp-empty">No local branches.</div>}
              {localBranches.slice(0, 6).map((b) => (
                <div key={b.name} className="ovp-branch-row">
                  <span className="ovp-branch-name" title={b.name}>{b.name}</span>
                  <span className="ovp-mono ovp-branch-hash">{b.head.slice(0, 7)}</span>
                  {b.isCurrent && <span className="ovp-badge ovp-badge-current">current</span>}
                </div>
              ))}
              {localBranches.length > 6 && <div className="ovp-empty">+{localBranches.length - 6} more</div>}
            </div>
          </div>

          {/* Log graph — same rendering as the Browse git tree */}
          <div className="ovp-panel">
            <PanelTitle href="#/browse">Log</PanelTitle>
            <div className="ovp-git-tree">
              <div className="git-tree-graph" style={{ position: 'relative' }}>
                <svg
                  className="git-tree-svg"
                  width={graphWidth}
                  height={svgHeight}
                  style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
                >
                  {layout.edges.map((edge, i) => (
                    <path
                      key={i}
                      d={edgePath(edge.fromRow, edge.fromLane, edge.toRow, edge.toLane)}
                      stroke={laneColor(edge.toLane)}
                      strokeWidth={2}
                      fill="none"
                      opacity={0.7}
                    />
                  ))}
                  {layout.nodes.map((node, i) => (
                    <circle
                      key={node.commit.hash}
                      cx={laneX(node.lane)}
                      cy={rowY(i)}
                      r={NODE_RADIUS}
                      fill={laneColor(node.lane)}
                    />
                  ))}
                </svg>
                {layout.nodes.map((node) => {
                  const refs = node.commit.refs ?? [];
                  const branch = branchOf.get(node.commit.hash);
                  const isMerge = (node.commit.parents ?? []).length > 1;
                  const mergedFrom = isMerge ? parseMergedBranch(node.commit.subject) : null;
                  const branchPart = mergedFrom && branch
                    ? `${mergedFrom} → ${branch}`
                    : branch ?? 'branch unknown';
                  const tooltip = `${node.commit.hash.slice(0, 12)} · ${branchPart} · ${node.commit.author}`;
                  return (
                    <div
                      key={node.commit.hash}
                      className="git-tree-row"
                      style={{ height: ROW_HEIGHT, paddingLeft: graphWidth + 4 }}
                      data-tooltip={tooltip}
                    >
                      <span className="git-tree-hash">{node.commit.shortHash}</span>
                      {reconciled?.gitHead === node.commit.hash && (
                        <span className="commit-head-badge">HEAD</span>
                      )}
                      {refs.map((ref) => (
                        <span key={ref} className="git-tree-ref-badge">{ref}</span>
                      ))}
                      {reconciled?.reconciledHead === node.commit.hash && (
                        <span className="git-tree-diff-badge git-tree-reconciled">RECONCILED</span>
                      )}
                      <span className="git-tree-subject">{node.commit.subject}</span>
                    </div>
                  );
                })}
                {graph.length === 0 && <div className="ovp-empty">No commits.</div>}
              </div>
            </div>
          </div>

          {/* Commit activity timeline */}
          <div className="ovp-panel">
            <ActivityTimeline />
          </div>
        </div>

        {/* ── Column 2: findings ──────────────────────────────────── */}
        <div className="ovp-col">
          <div className="ovp-stat-row-2">
            <div className="ovp-stat">
              <div className="ovp-stat-label">Open findings</div>
              <div className="ovp-stat-value">{open.length}</div>
              <div className="ovp-stat-sub ovp-severity-chips">
                {SEVERITY_ORDER.map((sev) => {
                  const n = bySeverity.get(sev) ?? 0;
                  if (n === 0) return null;
                  return (
                    <span key={sev} className="ovp-severity-chip" data-severity={sev}>
                      <span className="ovp-severity-dot" />{n} {sev}
                    </span>
                  );
                })}
                {open.length === 0 && <span>{findings.length > 0 ? 'All resolved' : 'None recorded yet'}</span>}
              </div>
            </div>
            <div className="ovp-stat">
              <div className="ovp-stat-label">Mean time to resolve</div>
              <div className="ovp-stat-value">{avgFixMs != null ? humanizeDuration(avgFixMs) : '—'}</div>
              <div className="ovp-stat-sub">
                {avgFixMs != null ? `across ${fixedCount} resolved finding${fixedCount === 1 ? '' : 's'}` : 'No resolved findings yet'}
              </div>
            </div>
          </div>

          <div className="ovp-panel">
            <PanelTitle href="#/findings">Systemic issues</PanelTitle>
            {findings.length === 0 ? (
              <div className="ovp-empty">No findings recorded yet.</div>
            ) : (
              <CategoryHeatmap systemic={systemic} findingsByCategory={findingsByCategory} isOpen={isOpen} />
            )}
          </div>

          <div className="ovp-panel">
            <PanelTitle href="#/findings">Findings raised per week</PanelTitle>
            {findings.length === 0 ? (
              <div className="ovp-empty">No findings recorded yet.</div>
            ) : (
              <WeekColumns
                buckets={buckets}
                values={buckets.map((b) => b.raised)}
                tooltips={buckets.map((b) => `Week of ${b.label}: ${b.raised} raised`)}
                labelMax={String(Math.max(...buckets.map((b) => b.raised)))}
              />
            )}
          </div>

          <div className="ovp-panel">
            <PanelTitle href="#/findings">Mean time to resolve per week</PanelTitle>
            {fixedCount === 0 ? (
              <div className="ovp-empty">No resolved findings yet.</div>
            ) : (
              <WeekColumns
                buckets={buckets}
                values={mttrValues}
                tooltips={buckets.map((b, i) =>
                  b.fixTimes.length > 0
                    ? `Week of ${b.label}: ${humanizeDuration(mttrValues[i])} across ${b.fixTimes.length} resolved`
                    : `Week of ${b.label}: nothing resolved`)}
                labelMax={humanizeDuration(Math.max(...mttrValues))}
              />
            )}
          </div>
        </div>

        {/* ── Column 3: features ──────────────────────────────────── */}
        <div className="ovp-col ovp-col-wide">
          <div className="ovp-panel">
            <PanelTitle href="#/features">Features by kind</PanelTitle>
            {data.features.length === 0 ? (
              <div className="ovp-empty">No features annotated yet.</div>
            ) : (
              <KindSquares features={data.features} openByFeature={openByFeature} />
            )}
          </div>

          <div className="ovp-panel">
            <PanelTitle href="#/features">Feature map</PanelTitle>
            <FeatureMap features={data.features} openByFeature={openByFeature} worstByFeature={worstByFeature} />
          </div>
        </div>

      </div>
    </div>
  );
}
