import { useState, useMemo, useEffect } from 'react';
import dagre from 'dagre';
import type { FlowStep, FlowEdge } from './flows';
import { edgeKey } from './flowOutline';
import {
  usePalette, usePanZoom, GraphControls, ArrowMarkers, smoothPath, parseMethod, badgeW,
  EDGE_DASH, edgeColor, truncate,
} from './graphKit';

// ─── Layout ──────────────────────────────────────────────────────────────

const NODE_W    = 300;
const BAR_H     = 4;    // thin top accent bar
const MAX_NODES = 500;
const NODE_PAD  = 14;   // horizontal content padding
const TITLE_LH  = 17;   // line-height for wrapped title
const FONT_W    = 7.5;  // approx px per char at 13px system-ui

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
interface LEdge { key: string; points: { x: number; y: number }[]; edge: FlowEdge }

function buildLayout(steps: FlowStep[], edges: FlowEdge[]): { nodes: LNode[]; edges: LEdge[] } {
  const g = new dagre.graphlib.Graph({ directed: true, multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 64, ranksep: 110, marginx: 64, marginy: 64 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const { h } = layoutNode(s);
    g.setNode(s.id, { width: NODE_W, height: h });
  }
  // Branch order: dagre places a node's out-edges left to right in insertion order.
  const ordered = [...edges].sort((a, b) => a.position - b.position);
  for (const e of ordered) {
    if (ids.has(e.fromStepId) && ids.has(e.toStepId)) g.setEdge(e.fromStepId, e.toStepId, { edge: e }, edgeKey(e));
  }

  dagre.layout(g);

  const nodes: LNode[] = steps.map((s) => {
    const n = g.node(s.id);
    const { h } = layoutNode(s);
    return { step: s, x: n?.x ?? 0, y: n?.y ?? 0, h };
  });
  const out: LEdge[] = g.edges().map((e) => {
    const ed = g.edge(e);
    return { key: e.name ?? `${e.v}:${e.w}`, points: ed.points ?? [], edge: ed.edge as FlowEdge };
  });
  return { nodes, edges: out };
}

/** The point a fraction t along a polyline, with the direction it runs there. */
function along(pts: { x: number; y: number }[], t: number): { x: number; y: number; dx: number; dy: number } | null {
  if (pts.length < 2) return null;
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let target = lens.reduce((a, b) => a + b, 0) * t;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const a = pts[i], b = pts[i + 1];
      const k = lens[i] ? Math.min(1, target / lens[i]) : 0;
      const len = lens[i] || 1;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
    }
    target -= lens[i];
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────

export function FlowGraphView({
  steps,
  edges: flowEdges,
  selectedStepId,
  onSelectStep,
  selectedEdgeKey,
  onSelectEdge,
}: {
  steps: FlowStep[];
  edges: FlowEdge[];
  selectedStepId: string | null;
  onSelectStep: (id: string | null) => void;
  selectedEdgeKey?: string | null;
  onSelectEdge?: (key: string | null) => void;
}) {
  const { pal, KIND } = usePalette();
  const { pz, setPz, dragging, canvasRef, handlers, fitTo, zoomIn, zoomOut } = usePanZoom();
  const [hover, setHover] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => buildLayout(steps, flowEdges), [steps, flowEdges]);

  // Hovering a step lights up its neighbourhood: it, and the steps one hop either side.
  const focus = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    for (const e of flowEdges) {
      if (e.fromStepId === hover) set.add(e.toStepId);
      if (e.toStepId === hover) set.add(e.fromStepId);
    }
    return set;
  }, [hover, flowEdges]);

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
      const al = key === 'ArrowDown' ? dy : key === 'ArrowUp' ? -dy : key === 'ArrowRight' ? dx : -dx;
      if (al <= 0) continue;
      const across = key === 'ArrowDown' || key === 'ArrowUp' ? Math.abs(dx) : Math.abs(dy);
      const cost = al + across * 2;
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

  const bounds = () => nodes.length === 0 ? null : {
    minX: Math.min(...nodes.map((n) => n.x)) - NODE_W / 2,
    maxX: Math.max(...nodes.map((n) => n.x)) + NODE_W / 2,
    minY: Math.min(...nodes.map((n) => n.y - n.h / 2)),
    maxY: Math.max(...nodes.map((n) => n.y + n.h / 2)),
  };

  // Auto-fit to content whenever the component mounts (= each time Map tab opens).
  useEffect(() => {
    if (nodes.length === 0) return;
    const id = requestAnimationFrame(() => fitTo(bounds()));
    return () => cancelAnimationFrame(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  const colors = [...new Set([pal.treeEdge, pal.accent, pal.danger])];
  const marker = (c: string) => `url(#arr-${colors.indexOf(c)})`;

  return (
    <div className="flow-graph-view">
      <div
        ref={canvasRef}
        className="flow-graph-canvas"
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        {...handlers}
      >
        <svg width="100%" height="100%">
          <defs>
            <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor={pal.shadowColor} />
            </filter>
            <filter id="node-shadow-sel" x="-20%" y="-20%" width="140%" height="160%">
              <feDropShadow dx="0" dy="8" stdDeviation="14" floodColor={pal.shadowSelColor} />
            </filter>
            <ArrowMarkers colors={colors} />
          </defs>

          <g transform={`translate(${pz.x},${pz.y}) scale(${pz.scale})`}>

            {/* ── Edges (behind nodes) ─────────────────────────────────── */}
            {edges.map(({ key, points, edge: e }) => {
              const d = smoothPath(points);
              if (!d) return null;
              const isSelected = selectedEdgeKey === key;
              const dim = focus && !(focus.has(e.fromStepId) && focus.has(e.toStepId) && (e.fromStepId === hover || e.toStepId === hover));
              const stroke = isSelected ? pal.accent : edgeColor(e.kind, pal, { tainted: e.tainted });
              const strokeWidth = isSelected ? 2.5 : e.kind === 'next' ? 1.5 : 2;
              const mid = along(points, 0.5);
              const gate = e.trustBoundary ? along(points, 0.72) : null;
              const label = e.condition || e.description;
              return (
                <g key={key} className="flow-graph-edge" data-edge-key={key} style={{ opacity: dim ? 0.25 : 1, transition: 'opacity 120ms' }}>
                  <path
                    d={d}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={strokeWidth}
                    strokeDasharray={EDGE_DASH[e.kind]}
                    markerEnd={marker(isSelected ? pal.accent : stroke)}
                    strokeOpacity={isSelected ? 1 : e.kind === 'next' ? 0.8 : 0.9}
                  />
                  {/* Wide transparent hit area */}
                  {onSelectEdge && (
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={16}
                      style={{ cursor: 'pointer' }}
                      role="button"
                      aria-label={`Connection ${e.kind}${label ? `: ${label}` : ''}`}
                      onPointerDown={(ev) => ev.stopPropagation()}
                      onClick={() => onSelectEdge(isSelected ? null : key)}
                    />
                  )}
                  {/* A trust boundary: a gate across the edge. */}
                  {gate && (
                    <g style={{ pointerEvents: 'none' }}>
                      {[-4, 4].map((o) => (
                        <line
                          key={o}
                          x1={gate.x + gate.dx * o - gate.dy * 9} y1={gate.y + gate.dy * o + gate.dx * 9}
                          x2={gate.x + gate.dx * o + gate.dy * 9} y2={gate.y + gate.dy * o - gate.dx * 9}
                          stroke={pal.warn} strokeWidth={2} strokeLinecap="round"
                        />
                      ))}
                    </g>
                  )}
                  {(label || e.kind !== 'next') && mid && (() => {
                    const head = e.kind !== 'next' ? (e.protocol ? `${e.kind} · ${e.protocol}` : e.kind) : '';
                    const text = truncate([head, label].filter(Boolean).join('  '), 30);
                    const w = Math.max(40, text.length * 5.6 + 16);
                    const labelColor = e.tainted ? pal.danger : e.condition ? pal.textSub : pal.accent;
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
                          fontFamily={e.condition ? 'var(--font-sans, system-ui)' : 'var(--font-mono, monospace)'}
                          fontStyle={e.condition ? 'italic' : 'normal'}
                          fill={labelColor}
                          style={{ userSelect: 'none' }}
                        >
                          {text}
                        </text>
                      </g>
                    );
                  })()}
                  {isSelected && mid && (
                    <circle cx={mid.x} cy={mid.y - 14} r={4} fill={pal.accent} fillOpacity={0.9} style={{ pointerEvents: 'none' }} />
                  )}
                </g>
              );
            })}

            {/* ── Nodes ───────────────────────────────────────────────── */}
            {nodes.map(({ step, x, y, h }) => {
              const k = KIND[step.featureKind] ?? KIND.externality;
              // A subflow step: a whole flow in one block, drawn as a stack of cards.
              const sub = !!step.subflowId;
              const kindLabel = sub ? 'subflow' : step.featureKind;
              const footer = sub
                ? (step.subflow ? `${step.subflow.stepCount} step${step.subflow.stepCount === 1 ? '' : 's'} · flow` : 'deleted flow')
                : step.actor ? `${step.projectName} · ${step.actor}` : step.projectName;
              const dim = focus && !focus.has(step.id);
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
                  style={{ cursor: 'pointer', opacity: dim ? 0.35 : 1, transition: 'opacity 120ms' }}
                  onPointerEnter={() => setHover(step.id)}
                  onPointerLeave={() => setHover(null)}
                  role="button"
                  tabIndex={step.id === tabStopId ? 0 : -1}
                  aria-pressed={selected}
                  aria-label={`${kindLabel} ${step.featureTitle || step.featureId}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => { setStopId(step.id); onSelectStep(selected ? null : step.id); }}
                  onFocus={() => setStopId(step.id)}
                  onKeyDown={(e) => onNodeKeyDown(e, step, selected)}
                >
                  {/* A subflow's stack: two cards peeking out behind */}
                  {sub && [8, 4].map((o) => (
                    <rect key={o} x={o} y={-o} width={NODE_W} height={h} rx={R} fill={pal.bgCard} stroke={pal.cardBorder} strokeWidth={1} />
                  ))}

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
                    {kindLabel}
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
                    {truncate(footer, 40)}
                  </text>

                  {/* Tombstone */}
                  {step.tombstoned && (
                    <text x={NODE_W - 16} y={yKind} fontSize={10} fill="#f85149"
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>✕</text>
                  )}

                  <title>{sub ? `Subflow · ${title}` : `${step.projectName} · ${title}${opRaw ? ` · ${opRaw}` : ''}`}</title>
                </g>
              );
            })}

          </g>
        </svg>
      </div>

      <GraphControls onFit={() => fitTo(bounds())} onZoomIn={zoomIn} onZoomOut={zoomOut} />
    </div>
  );
}
