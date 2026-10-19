import { useRef, useState, useMemo, useEffect } from 'react';
import dagre from 'dagre';
import type { FlowStep, FlowStepLink, FeatureKind } from './flows';

// ─── Layout ──────────────────────────────────────────────────────────────

const NODE_W    = 300;
const BAR_H     = 4;    // thin top accent bar
const MAX_NODES = 500;
const NODE_PAD  = 14;   // horizontal content padding
const TITLE_LH  = 17;   // line-height for wrapped title
const FONT_W    = 7.5;  // approx px per char at 13px system-ui

// ─── Palette ─────────────────────────────────────────────────────────────
// SVG can't read CSS custom properties, so we maintain two explicit palettes
// and switch based on the data-theme attribute on <html>.

// stripe = left accent bar colour; label = readable kind text on card body
interface KindTokens { stripe: string; label: string }

const KIND_DARK: Record<FeatureKind, KindTokens> = {
  interface:   { stripe: '#58a6ff', label: '#7cb9ff' },
  source:      { stripe: '#d29922', label: '#e0b340' },
  sink:        { stripe: '#f85149', label: '#ff7b75' },
  dependency:  { stripe: '#a371f7', label: '#bb93f9' },
  externality: { stripe: '#7a8490', label: '#9ba5b8' },
};

const KIND_LIGHT: Record<FeatureKind, KindTokens> = {
  interface:   { stripe: '#2563eb', label: '#2563eb' },
  source:      { stripe: '#b45309', label: '#b45309' },
  sink:        { stripe: '#dc2626', label: '#dc2626' },
  dependency:  { stripe: '#7c3aed', label: '#7c3aed' },
  externality: { stripe: '#4b5563', label: '#4b5563' },
};

interface Palette {
  bgCard: string; cardBorder: string;
  textMain: string; textSub: string;
  accent: string; treeEdge: string;
  shadowColor: string; shadowSelColor: string;
}

const PAL_DARK: Palette = {
  bgCard:         '#111827',
  cardBorder:     'rgba(255,255,255,0.08)',
  textMain:       '#e4eaf4',
  textSub:        '#9ba5b8',
  accent:         '#818cf8',
  treeEdge:       'rgba(148,163,184,0.3)',
  shadowColor:    'rgba(0,0,0,0.45)',
  shadowSelColor: 'rgba(129,140,248,0.45)',
};

const PAL_LIGHT: Palette = {
  bgCard:         '#ffffff',
  cardBorder:     'rgba(0,0,0,0.09)',
  textMain:       '#111827',
  textSub:        '#4b5563',
  accent:         '#4f46e5',
  treeEdge:       'rgba(100,116,139,0.3)',
  shadowColor:    'rgba(0,0,0,0.08)',
  shadowSelColor: 'rgba(79,70,229,0.3)',
};

// ─── Theme hook ───────────────────────────────────────────────────────────

function useTheme(): 'dark' | 'light' {
  const get = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const [theme, setTheme] = useState<'dark' | 'light'>(get);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(get()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

// ─── Text wrapping ────────────────────────────────────────────────────────

function wrapWords(text: string, firstLineChars: number, restLineChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [text];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const lim = lines.length === 0 ? firstLineChars : restLineChars;
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length <= lim) { cur = cand; }
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

// ─── Per-node layout ──────────────────────────────────────────────────────
// Computes element y-positions and total height for a step. Called both
// during dagre graph construction (to set node heights) and during render.

interface NodeLayout {
  h: number;
  titleLines: string[];
  yKind: number;
  yBadgeTop: number;  // 0 if no method
  yTitle: number;     // baseline of first title line
  yPath: number;      // 0 if no path
  yProject: number;
}

function layoutNode(step: FlowStep): NodeLayout {
  const title  = step.featureTitle || step.featureId;
  const opRaw  = step.featureOperation ?? step.featureProtocol ?? '';
  const { method, path: opPath } = parseMethod(opRaw);
  const bw     = method ? badgeW(method) : 0;

  // First title line is narrowed by badge; rest use full width
  const firstChars = Math.floor((NODE_W - NODE_PAD * 2 - (method ? bw + 7 : 0)) / FONT_W);
  const restChars  = Math.floor((NODE_W - NODE_PAD * 2) / FONT_W);
  const titleLines = wrapWords(title, firstChars, restChars);

  let y = BAR_H + 4;
  const yKind = y + 14;   // kind label baseline
  y = yKind + 8;

  // Badge (left) and first title line (right) share the same row
  const yBadgeTop = method ? y : 0;
  const yTitle = y + 13;  // baseline for first title line

  // Row height: enough for the badge (16px) and all wrapped title lines
  const allTitleH = 13 + (titleLines.length - 1) * TITLE_LH;
  const rowH = Math.max(method ? 16 : 0, allTitleH);
  y += rowH + 10;

  let yPath = 0;
  if (opPath) { yPath = y + 11; y = yPath + 14; }

  const yProject = y + 11;
  const h = Math.ceil(yProject + 14);

  return { h, titleLines, yKind, yBadgeTop, yTitle, yPath, yProject };
}

// ─── Layout engine ───────────────────────────────────────────────────────

interface LNode { step: FlowStep; x: number; y: number; h: number }
interface LEdge {
  key: string;
  points: { x: number; y: number }[];
  label?: string;
  isLink: boolean;
  isBranch: boolean;
}

function buildLayout(steps: FlowStep[], links: FlowStepLink[]): { nodes: LNode[]; edges: LEdge[] } {
  const g = new dagre.graphlib.Graph({ directed: true, multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 64, ranksep: 110, marginx: 64, marginy: 64 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const { h } = layoutNode(s);
    g.setNode(s.id, { width: NODE_W, height: h });
  }
  for (const s of steps) {
    if (s.parentStepId && ids.has(s.parentStepId))
      // Branch conditions annotate the connecting line (parent → branch child),
      // not the child node itself.
      g.setEdge(s.parentStepId, s.id, { edgeType: 'tree', label: s.branchCondition || undefined }, `tree-${s.parentStepId}-${s.id}`);
  }
  // When all steps are root-level (no parentStepId), add implicit sequential
  // edges so the map shows a connected spine rather than floating nodes.
  const rootSteps = steps.filter((s) => !s.parentStepId).sort((a, b) => a.position - b.position);
  if (rootSteps.length === steps.length && rootSteps.length > 1) {
    for (let i = 0; i < rootSteps.length - 1; i++) {
      g.setEdge(rootSteps[i].id, rootSteps[i + 1].id, { edgeType: 'tree' }, `seq-${rootSteps[i].id}-${rootSteps[i + 1].id}`);
    }
  }
  for (const l of links) {
    if (ids.has(l.fromStepId) && ids.has(l.toStepId))
      g.setEdge(l.fromStepId, l.toStepId, { edgeType: 'link', label: l.description }, `${l.fromStepId}:${l.toStepId}`);
  }

  dagre.layout(g);

  const nodes: LNode[] = steps.map((s) => {
    const n = g.node(s.id);
    const { h } = layoutNode(s);
    return { step: s, x: n?.x ?? 0, y: n?.y ?? 0, h };
  });
  const edges: LEdge[] = g.edges().map((e) => {
    const ed = g.edge(e);
    return {
      key: e.name ?? `${e.v}-${e.w}`,
      points: ed.points ?? [],
      label: ed.label || undefined,
      isLink: ed.edgeType === 'link',
      isBranch: ed.edgeType === 'tree' && !!ed.label,
    };
  });

  return { nodes, edges };
}

// Smooth S-curve cubic bezier through dagre waypoints.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  const s = pts[0];
  const e = pts[pts.length - 1];
  if (pts.length === 2) {
    const cy = (e.y - s.y) * 0.45;
    return `M ${s.x} ${s.y} C ${s.x} ${s.y + cy} ${e.x} ${e.y - cy} ${e.x} ${e.y}`;
  }
  let d = `M ${s.x} ${s.y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const cy = (b.y - a.y) * 0.5;
    d += ` C ${a.x} ${a.y + cy} ${b.x} ${b.y - cy} ${b.x} ${b.y}`;
  }
  return d;
}

// ─── Pan/zoom ─────────────────────────────────────────────────────────────

interface PZ { x: number; y: number; scale: number }
const INITIAL_PZ: PZ = { x: 0, y: 0, scale: 1 };

// ─── Helpers ──────────────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

function parseMethod(op: string): { method: string | null; path: string } {
  for (const m of HTTP_METHODS) {
    if (op.startsWith(m + ' ') || op === m) {
      return { method: m, path: op.slice(m.length).trim() };
    }
  }
  return { method: null, path: op };
}

// Approximate badge width: monospace 10px ≈ 6.5px/char + 12px h-padding
function badgeW(method: string) { return method.length * 6.5 + 12; }

// ─── Component ────────────────────────────────────────────────────────────

export function FlowGraphView({
  steps,
  links,
  selectedStepId,
  onSelectStep,
  selectedLinkKey,
  onSelectLink,
}: {
  steps: FlowStep[];
  links: FlowStepLink[];
  selectedStepId: string | null;
  onSelectStep: (id: string | null) => void;
  selectedLinkKey?: string | null;
  onSelectLink?: (key: string | null) => void;
}) {
  const theme = useTheme();
  const pal   = theme === 'light' ? PAL_LIGHT : PAL_DARK;
  const KIND  = theme === 'light' ? KIND_LIGHT : KIND_DARK;

  const [pz, setPz] = useState<PZ>(INITIAL_PZ);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ ox: number; oy: number; tx: number; ty: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const { nodes, edges } = useMemo(() => buildLayout(steps, links), [steps, links]);

  // Keyboard: nodes form a roving-tabindex group (one Tab stop; arrows move
  // between nodes; Enter/Space selects; Escape clears the selection).
  const [stopId, setStopId] = useState<string | null>(null);
  const tabStopId = nodes.some((n) => n.step.id === stopId)
    ? stopId
    : (nodes.find((n) => n.step.id === selectedStepId) ?? nodes[0])?.step.id ?? null;

  function focusNode(id: string) {
    const canvas = canvasRef.current;
    const el = canvas?.querySelector<SVGGElement>(`[data-step-id="${CSS.escape(id)}"]`);
    if (!canvas || !el) return;
    setStopId(id);
    el.focus({ preventScroll: true });
    // Keep the focused node inside the viewport (pan, since this is an SVG transform).
    requestAnimationFrame(() => {
      const nr = el.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      const M = 24;
      const dx = nr.left < cr.left + M ? cr.left + M - nr.left : nr.right > cr.right - M ? cr.right - M - nr.right : 0;
      const dy = nr.top < cr.top + M ? cr.top + M - nr.top : nr.bottom > cr.bottom - M ? cr.bottom - M - nr.bottom : 0;
      if (dx || dy) setPz((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    });
  }

  /** Nearest node in the arrow's direction (primary-axis distance, penalising drift). */
  function neighbour(fromId: string, key: string): string | null {
    const from = nodes.find((n) => n.step.id === fromId);
    if (!from) return null;
    let best: { id: string; cost: number } | null = null;
    for (const n of nodes) {
      if (n.step.id === fromId) continue;
      const dx = n.x - from.x;
      const dy = n.y - from.y;
      const along = key === 'ArrowDown' ? dy : key === 'ArrowUp' ? -dy : key === 'ArrowRight' ? dx : -dx;
      if (along <= 0) continue;
      const across = key === 'ArrowDown' || key === 'ArrowUp' ? Math.abs(dx) : Math.abs(dy);
      const cost = along + across * 2;
      if (!best || cost < best.cost) best = { id: n.step.id, cost };
    }
    return best?.id ?? null;
  }

  function onNodeKeyDown(e: React.KeyboardEvent, step: FlowStep, selected: boolean) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectStep(selected ? null : step.id);
    } else if (e.key === 'Escape') {
      if (selectedStepId) { e.preventDefault(); onSelectStep(null); }
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = neighbour(step.id, e.key);
      if (next) focusNode(next);
    }
  }

  // Auto-fit to content whenever the component mounts (= each time Map tab opens).
  useEffect(() => {
    if (nodes.length === 0) return;
    const id = requestAnimationFrame(fitToContent);
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function fitToContent() {
    if (!canvasRef.current || nodes.length === 0) { setPz(INITIAL_PZ); return; }
    const { width, height } = canvasRef.current.getBoundingClientRect();
    const pad = 64;
    const minX = Math.min(...nodes.map((n) => n.x)) - NODE_W / 2;
    const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_W / 2;
    const minY = Math.min(...nodes.map((n) => n.y - n.h / 2));
    const maxY = Math.max(...nodes.map((n) => n.y + n.h / 2));
    const scale = Math.max(0.12, Math.min(5, Math.min(width / (maxX - minX + pad * 2), height / (maxY - minY + pad * 2))));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setPz({ scale, x: width / 2 - cx * scale, y: height / 2 - cy * scale });
  }

  function zoomIn()  { setPz((p) => ({ ...p, scale: Math.min(5, p.scale * 1.3) })); }
  function zoomOut() { setPz((p) => ({ ...p, scale: Math.max(0.12, p.scale / 1.3) })); }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    // Scale the zoom step to the wheel delta (clamped) so trackpads — which
    // fire many small events — don't zoom in huge jumps.
    const d = Math.max(-50, Math.min(50, e.deltaY));
    const factor = Math.exp(-d * 0.0012);
    setPz((p) => ({ ...p, scale: Math.max(0.12, Math.min(5, p.scale * factor)) }));
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { ox: e.clientX, oy: e.clientY, tx: pz.x, ty: pz.y };
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setPz((p) => ({ ...p, x: drag.current!.tx + e.clientX - drag.current!.ox, y: drag.current!.ty + e.clientY - drag.current!.oy }));
  }
  function onPointerUp(e: React.PointerEvent) {
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    drag.current = null;
    setDragging(false);
  }

  if (steps.length > MAX_NODES) {
    return (
      <div className="flow-graph-view">
        <div className="flow-graph-empty">
          Graph too large ({steps.length} nodes). Narrow your selection to fewer than {MAX_NODES} steps.
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flow-graph-view">
        <div className="flow-graph-empty">No steps to display.</div>
      </div>
    );
  }

  const R = 6; // corner radius

  return (
    <div className="flow-graph-view">
      <div
        ref={canvasRef}
        className="flow-graph-canvas"
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <svg width="100%" height="100%">
          <defs>
            <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor={pal.shadowColor} />
            </filter>
            <filter id="node-shadow-sel" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="8" stdDeviation="14" floodColor={pal.shadowSelColor} />
            </filter>
            <marker id="arr-tree" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
              <path d="M0,0 L0,9 L9,4.5 z" fill={pal.treeEdge} />
            </marker>
            <marker id="arr-link" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
              <path d="M0,0 L0,9 L9,4.5 z" fill={pal.accent} />
            </marker>
          </defs>

          <g transform={`translate(${pz.x},${pz.y}) scale(${pz.scale})`}>

            {/* ── Edges (behind nodes) ─────────────────────────────────── */}
            {edges.map((e) => {
              const d = smoothPath(e.points);
              if (!d) return null;
              const isSelected = e.isLink && selectedLinkKey === e.key;
              const stroke = isSelected ? pal.accent : e.isLink ? pal.accent : pal.treeEdge;
              const strokeOpacity = isSelected ? 1 : e.isLink ? 0.9 : 0.6;
              const strokeWidth = isSelected ? 2.5 : e.isLink ? 2 : 1.5;
              const mid = e.points[Math.floor(e.points.length / 2)];
              return (
                <g key={e.key}>
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    markerEnd={e.isLink ? 'url(#arr-link)' : 'url(#arr-tree)'}
                    strokeOpacity={strokeOpacity}
                  />
                  {/* Wide transparent hit area for explicit links */}
                  {e.isLink && onSelectLink && (
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={16}
                      style={{ cursor: 'pointer' }}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => onSelectLink(isSelected ? null : e.key)}
                    />
                  )}
                  {e.label && mid && (() => {
                    const text = e.label!.length > 26 ? e.label!.slice(0, 25) + '…' : e.label!;
                    const w = Math.max(48, text.length * 5.6 + 16);
                    // Branch conditions read as muted italic labels; explicit link
                    // descriptions keep the accent monospace treatment.
                    const labelColor = e.isBranch ? pal.textSub : pal.accent;
                    return (
                      <g style={{ pointerEvents: 'none' }}>
                        <rect
                          x={mid.x - w / 2} y={mid.y - 9}
                          width={w} height={18} rx={5}
                          fill={pal.bgCard} stroke={labelColor} strokeWidth={0.75} strokeOpacity={0.5}
                        />
                        <text
                          x={mid.x} y={mid.y + 4}
                          textAnchor="middle"
                          fontSize={10}
                          fontFamily={e.isBranch ? 'var(--font-sans, system-ui)' : 'var(--font-mono, monospace)'}
                          fontStyle={e.isBranch ? 'italic' : 'normal'}
                          fill={labelColor}
                          style={{ userSelect: 'none' }}
                        >
                          {text}
                        </text>
                      </g>
                    );
                  })()}
                  {/* Selection ring on link midpoint */}
                  {isSelected && mid && (
                    <circle
                      cx={mid.x} cy={mid.y} r={5}
                      fill={pal.accent} fillOpacity={0.9}
                      style={{ pointerEvents: 'none' }}
                    />
                  )}
                </g>
              );
            })}

            {/* ── Nodes ───────────────────────────────────────────────── */}
            {nodes.map(({ step, x, y, h }) => {
              const k = KIND[step.featureKind] ?? KIND.externality;
              const nx = x - NODE_W / 2;
              const ny = y - h / 2;
              const title = step.featureTitle || step.featureId;
              const opRaw = step.featureOperation ?? step.featureProtocol ?? '';
              const { method, path: opPath } = parseMethod(opRaw);
              const bw = method ? badgeW(method) : 0;
              const selected = step.id === selectedStepId;
              const PAD_L = NODE_PAD;
              const { titleLines, yKind, yBadgeTop, yTitle, yPath, yProject } = layoutNode(step);

              const pathTrunc = opPath.length > 36 ? opPath.slice(0, 35) + '…' : opPath;

              return (
                <g
                  key={step.id}
                  className="flow-graph-node"
                  data-step-id={step.id}
                  transform={`translate(${nx},${ny})`}
                  style={{ cursor: 'pointer' }}
                  role="button"
                  tabIndex={step.id === tabStopId ? 0 : -1}
                  aria-pressed={selected}
                  aria-label={`${step.featureKind} ${step.featureTitle || step.featureId}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => { setStopId(step.id); onSelectStep(selected ? null : step.id); }}
                  onFocus={() => setStopId(step.id)}
                  onKeyDown={(e) => onNodeKeyDown(e, step, selected)}
                >
                  {/* Shadow */}
                  <rect
                    width={NODE_W} height={h} rx={R}
                    fill="transparent"
                    filter={selected ? 'url(#node-shadow-sel)' : 'url(#node-shadow)'}
                  />

                  {/* Card body */}
                  <rect
                    className="flow-graph-node-card"
                    width={NODE_W} height={h} rx={R}
                    fill={pal.bgCard}
                    stroke={selected ? k.stripe : pal.cardBorder}
                    strokeWidth={selected ? 1.5 : 1}
                  />

                  {/* Thin top colour bar, clipped to upper rounded corners */}
                  <clipPath id={`card-clip-${step.id}`}>
                    <rect width={NODE_W} height={h} rx={R} />
                  </clipPath>
                  <rect
                    width={NODE_W} height={BAR_H}
                    fill={k.stripe}
                    clipPath={`url(#card-clip-${step.id})`}
                  />

                  {/* Kind label */}
                  <text
                    x={PAD_L} y={yKind}
                    fontSize={10} fontWeight={600}
                    fontFamily="var(--font-sans, system-ui)"
                    letterSpacing="0.07em"
                    fill={k.label}
                    style={{ pointerEvents: 'none', userSelect: 'none', textTransform: 'uppercase' }}
                  >
                    {step.featureKind}
                  </text>

                  {/* Method badge — left of first title line */}
                  {method && (
                    <g transform={`translate(${PAD_L}, ${yBadgeTop})`}>
                      <rect
                        width={bw} height={16} rx={3}
                        fill={k.stripe} fillOpacity={0.12}
                        stroke={k.stripe} strokeWidth={0.75} strokeOpacity={0.5}
                      />
                      <text
                        x={bw / 2} y={11.5}
                        textAnchor="middle"
                        fontSize={9} fontWeight={700}
                        fontFamily="var(--font-mono, monospace)"
                        fill={k.stripe}
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {method}
                      </text>
                    </g>
                  )}

                  {/* Feature title — wraps across multiple tspan lines */}
                  <text
                    fontSize={13} fontWeight={500}
                    fontFamily="var(--font-sans, system-ui)"
                    fill={pal.textMain}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {titleLines.map((line, i) => (
                      <tspan
                        key={i}
                        x={i === 0 && method ? PAD_L + bw + 7 : PAD_L}
                        y={i === 0 ? yTitle : undefined}
                        dy={i > 0 ? TITLE_LH : undefined}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>

                  {/* Operation path */}
                  {opPath && (
                    <text
                      x={PAD_L} y={yPath}
                      fontSize={10.5}
                      fontFamily="var(--font-mono, monospace)"
                      fill={pal.textSub}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {pathTrunc}
                    </text>
                  )}

                  {/* Project name */}
                  <text
                    x={PAD_L} y={yProject}
                    fontSize={9.5}
                    fontFamily="var(--font-mono, monospace)"
                    fill={pal.textSub}
                    fillOpacity={0.55}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                  >
                    {step.projectName.length > 36 ? step.projectName.slice(0, 35) + '…' : step.projectName}
                  </text>

                  {/* Tombstone */}
                  {step.tombstoned && (
                    <text x={NODE_W - 16} y={yKind} fontSize={10} fill="#f85149"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>✕</text>
                  )}

                  <title>{step.projectName} · {title}{opRaw ? ` · ${opRaw}` : ''}</title>
                </g>
              );
            })}

          </g>
        </svg>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <div className="flow-graph-controls">
        <button className="flow-graph-ctrl-btn" onClick={fitToContent} title="Fit to content">⊙</button>
        <div className="flow-graph-ctrl-sep" />
        <button className="flow-graph-ctrl-btn" onClick={zoomIn}  title="Zoom in">+</button>
        <button className="flow-graph-ctrl-btn" onClick={zoomOut} title="Zoom out">−</button>
      </div>
    </div>
  );
}
