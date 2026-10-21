import { useEffect, useRef, useState } from 'react';
import type { FeatureKind, EdgeKind } from './flows';

// Shared drawing kit for the SVG maps (a flow's map, the service map): theme-aware palettes,
// connection styles by kind, smooth edge paths, method badges and pan/zoom.

// SVG can't read CSS custom properties, so we maintain two explicit palettes
// and switch based on the data-theme attribute on <html>.

// stripe = accent bar colour; label = readable kind text on card body
export interface KindTokens { stripe: string; label: string }

export const KIND_DARK: Record<FeatureKind, KindTokens> = {
  interface:   { stripe: '#58a6ff', label: '#7cb9ff' },
  source:      { stripe: '#d29922', label: '#e0b340' },
  sink:        { stripe: '#f85149', label: '#ff7b75' },
  dependency:  { stripe: '#a371f7', label: '#bb93f9' },
  externality: { stripe: '#7a8490', label: '#9ba5b8' },
};

export const KIND_LIGHT: Record<FeatureKind, KindTokens> = {
  interface:   { stripe: '#2563eb', label: '#2563eb' },
  source:      { stripe: '#b45309', label: '#b45309' },
  sink:        { stripe: '#dc2626', label: '#dc2626' },
  dependency:  { stripe: '#7c3aed', label: '#7c3aed' },
  externality: { stripe: '#4b5563', label: '#4b5563' },
};

export interface Palette {
  bgCard: string; cardBorder: string; bgRow: string;
  textMain: string; textSub: string;
  accent: string; treeEdge: string; danger: string; warn: string;
  shadowColor: string; shadowSelColor: string;
}

export const PAL_DARK: Palette = {
  bgCard:         '#111827',
  cardBorder:     'rgba(255,255,255,0.08)',
  bgRow:          'rgba(255,255,255,0.03)',
  textMain:       '#e4eaf4',
  textSub:        '#9ba5b8',
  accent:         '#818cf8',
  treeEdge:       'rgba(148,163,184,0.45)',
  danger:         '#f85149',
  warn:           '#d29922',
  shadowColor:    'rgba(0,0,0,0.45)',
  shadowSelColor: 'rgba(129,140,248,0.45)',
};

export const PAL_LIGHT: Palette = {
  bgCard:         '#ffffff',
  cardBorder:     'rgba(0,0,0,0.09)',
  bgRow:          'rgba(0,0,0,0.025)',
  textMain:       '#111827',
  textSub:        '#4b5563',
  accent:         '#4f46e5',
  treeEdge:       'rgba(100,116,139,0.45)',
  danger:         '#dc2626',
  warn:           '#b45309',
  shadowColor:    'rgba(0,0,0,0.08)',
  shadowSelColor: 'rgba(79,70,229,0.3)',
};

/** How each kind of connection is drawn: a plain "next" is the quiet tree colour, the others
 *  take the accent; async, reads/writes and replies are dashed so they read apart at a glance. */
export const EDGE_DASH: Record<EdgeKind, string | undefined> = {
  next: undefined,
  call: undefined,
  async: '7 5',
  read: '2 4',
  write: '2 4',
  response: '4 3',
};

export function edgeColor(kind: EdgeKind, pal: Palette, opts: { tainted?: boolean } = {}): string {
  if (opts.tainted) return pal.danger;
  return kind === 'next' ? pal.treeEdge : pal.accent;
}

export function useTheme(): 'dark' | 'light' {
  const get = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const [theme, setTheme] = useState<'dark' | 'light'>(get);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(get()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export function usePalette() {
  const theme = useTheme();
  return { theme, pal: theme === 'light' ? PAL_LIGHT : PAL_DARK, KIND: theme === 'light' ? KIND_LIGHT : KIND_DARK };
}

/** Smooth S-curve cubic bezier through waypoints running top to bottom. */
export function smoothPath(pts: { x: number; y: number }[]): string {
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

/** A left-to-right S-curve from (x1, y1) to (x2, y2), bowing out when it runs backwards. */
export function horizontalPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(60, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export function parseMethod(op: string): { method: string | null; path: string } {
  for (const m of HTTP_METHODS) {
    if (op.startsWith(m + ' ') || op === m) {
      return { method: m, path: op.slice(m.length).trim() };
    }
  }
  return { method: null, path: op };
}

/** Approximate badge width: monospace 10px ≈ 6.5px/char + 12px h-padding. */
export function badgeW(method: string) { return method.length * 6.5 + 12; }

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ─── Pan/zoom ─────────────────────────────────────────────────────────────

export interface PZ { x: number; y: number; scale: number }
export const INITIAL_PZ: PZ = { x: 0, y: 0, scale: 1 };
const MIN_SCALE = 0.12;
const MAX_SCALE = 5;

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** Pan (drag the background) and zoom (wheel, buttons) for an SVG canvas. */
export function usePanZoom() {
  const [pz, setPz] = useState<PZ>(INITIAL_PZ);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ ox: number; oy: number; tx: number; ty: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  function fitTo(b: Bounds | null, pad = 64) {
    if (!canvasRef.current || !b) { setPz(INITIAL_PZ); return; }
    const { width, height } = canvasRef.current.getBoundingClientRect();
    const scale = Math.max(MIN_SCALE, Math.min(1.4, Math.min(width / (b.maxX - b.minX + pad * 2), height / (b.maxY - b.minY + pad * 2))));
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    setPz({ scale, x: width / 2 - cx * scale, y: height / 2 - cy * scale });
  }
  /** Zoom by factor about a canvas point (the centre by default), keeping it in place. */
  function zoomBy(factor: number, at?: { x: number; y: number }) {
    const r = canvasRef.current?.getBoundingClientRect();
    const px = at?.x ?? (r ? r.width / 2 : 0);
    const py = at?.y ?? (r ? r.height / 2 : 0);
    setPz((p) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, p.scale * factor));
      const k = scale / p.scale;
      return { scale, x: px - (px - p.x) * k, y: py - (py - p.y) * k };
    });
  }
  const handlers = {
    onWheel(e: React.WheelEvent) {
      e.preventDefault();
      // Scale the zoom step to the wheel delta (clamped) so trackpads — which
      // fire many small events — don't zoom in huge jumps.
      const d = Math.max(-50, Math.min(50, e.deltaY));
      const r = canvasRef.current?.getBoundingClientRect();
      zoomBy(Math.exp(-d * 0.0012), r ? { x: e.clientX - r.left, y: e.clientY - r.top } : undefined);
    },
    onPointerDown(e: React.PointerEvent) {
      if (e.button !== 0) return;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      drag.current = { ox: e.clientX, oy: e.clientY, tx: pz.x, ty: pz.y };
      setDragging(true);
    },
    onPointerMove(e: React.PointerEvent) {
      if (!drag.current) return;
      const d = drag.current;
      setPz((p) => ({ ...p, x: d.tx + e.clientX - d.ox, y: d.ty + e.clientY - d.oy }));
    },
    onPointerUp(e: React.PointerEvent) {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      drag.current = null;
      setDragging(false);
    },
  };
  return { pz, setPz, dragging, canvasRef, handlers, fitTo, zoomIn: () => zoomBy(1.3), zoomOut: () => zoomBy(1 / 1.3) };
}

export function GraphControls({ onFit, onZoomIn, onZoomOut, children }: {
  onFit: () => void; onZoomIn: () => void; onZoomOut: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="flow-graph-controls">
      <button type="button" className="flow-graph-ctrl-btn" onClick={onFit} title="Fit to content" aria-label="Fit to content">⊙</button>
      <div className="flow-graph-ctrl-sep" />
      <button type="button" className="flow-graph-ctrl-btn" onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">+</button>
      <button type="button" className="flow-graph-ctrl-btn" onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">−</button>
      {children}
    </div>
  );
}

/** Arrowhead markers, one per colour in use (ids "arr-<n>"). */
export function ArrowMarkers({ colors }: { colors: string[] }) {
  return (
    <>
      {colors.map((c, i) => (
        <marker key={c} id={`arr-${i}`} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
          <path d="M0,0 L0,9 L9,4.5 z" fill={c} />
        </marker>
      ))}
    </>
  );
}
