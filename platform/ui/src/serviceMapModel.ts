import dagre from 'dagre';
import type { EdgeKind, FeatureKind } from './flows';

// The service map's data (GET /api/service-map), what the filters keep of it, and where each
// service card and feature row goes. Pure, so it is unit tested; ServiceMap.tsx draws it.

export interface MapFlowRef { id: string; name: string }

export interface MapFeature {
  id: string;
  kind: FeatureKind;
  title: string;
  operation?: string;
  protocol?: string;
  direction?: string;
  status?: string;
  tags: string[];
  openFindings: number;
  flowCount: number;
  flows: MapFlowRef[];
  missing?: boolean;
}

export interface MapService { slug: string; name: string; features: MapFeature[] }

export interface MapConnection {
  fromProject: string;
  fromFeature: string;
  toProject: string;
  toFeature: string;
  kind: EdgeKind;
  protocol: string;
  auth: string[];
  trustBoundary: boolean;
  tainted: boolean;
  count: number;
  flows: MapFlowRef[];
}

export interface ServiceMapData {
  services: MapService[];
  connections: MapConnection[];
  internal: MapConnection[];
}

/** Which features a service card lists: those with a connection shown, those on any flow, or all. */
export type FeatureScope = 'connected' | 'flows' | 'all';

export interface MapFields { operation: boolean; protocol: boolean; findings: boolean; flows: boolean }

export interface MapFilters {
  hiddenServices: string[];
  connectionKinds: EdgeKind[];
  featureKinds: FeatureKind[];
  scope: FeatureScope;
  /** Show the edges between features of one service too. */
  internal: boolean;
  fields: MapFields;
}

export const ALL_EDGE_KINDS: EdgeKind[] = ['next', 'call', 'async', 'read', 'write', 'response'];
export const ALL_FEATURE_KINDS: FeatureKind[] = ['interface', 'source', 'sink', 'dependency', 'externality'];

export const DEFAULT_FILTERS: MapFilters = {
  hiddenServices: [],
  connectionKinds: ALL_EDGE_KINDS,
  featureKinds: ALL_FEATURE_KINDS,
  scope: 'flows',
  internal: false,
  fields: { operation: true, protocol: false, findings: true, flows: true },
};

export const connectionKey = (c: MapConnection) =>
  `${c.fromProject}:${c.fromFeature}>${c.toProject}:${c.toFeature}:${c.kind}:${c.protocol.toLowerCase()}`;
export const featureKey = (slug: string, id: string) => `${slug}:${id}`;

export interface VisibleMap {
  services: MapService[];
  connections: MapConnection[];
}

/** What the filters keep: services not hidden, connections of an enabled kind whose two ends
 *  are shown, and in each service the features of an enabled kind within the scope. */
export function applyFilters(data: ServiceMapData, f: MapFilters): VisibleMap {
  const hidden = new Set(f.hiddenServices);
  const kinds = new Set(f.connectionKinds);
  const fkinds = new Set(f.featureKinds);
  const services = data.services.filter((s) => !hidden.has(s.slug));
  const shown = new Set(services.map((s) => s.slug));
  const kindOf = new Map<string, FeatureKind>();
  for (const s of data.services) for (const ft of s.features) kindOf.set(featureKey(s.slug, ft.id), ft.kind);
  const pool = f.internal ? [...data.connections, ...data.internal] : data.connections;
  const connections = pool.filter((c) =>
    kinds.has(c.kind) && shown.has(c.fromProject) && shown.has(c.toProject) &&
    fkinds.has(kindOf.get(featureKey(c.fromProject, c.fromFeature)) ?? 'externality') &&
    fkinds.has(kindOf.get(featureKey(c.toProject, c.toFeature)) ?? 'externality'));
  const connected = new Set(connections.flatMap((c) => [featureKey(c.fromProject, c.fromFeature), featureKey(c.toProject, c.toFeature)]));
  return {
    connections,
    services: services.map((s) => ({
      ...s,
      features: s.features
        .filter((ft) => fkinds.has(ft.kind))
        .filter((ft) => f.scope === 'all' || connected.has(featureKey(s.slug, ft.id)) || (f.scope === 'flows' && ft.flowCount > 0))
        .sort((a, b) => ALL_FEATURE_KINDS.indexOf(a.kind) - ALL_FEATURE_KINDS.indexOf(b.kind) || a.title.localeCompare(b.title)),
    })),
  };
}

// ─── Layout ─────────────────────────────────────────────────────────────

export const CARD_W = 300;
export const HEADER_H = 46;
export const ROW_H = 28;
export const CARD_PAD = 8;
/** Rows a card lists before the rest fold into "+N more" (a service can have hundreds). */
export const ROW_CAP = 12;
/** Space between packed groups and cards. */
const GAP = 56;

export interface CardLayout {
  service: MapService;
  /** Top-left corner. */
  x: number;
  y: number;
  h: number;
  /** The features listed, in order (all of them when the card is expanded). */
  rows: MapFeature[];
  /** Features folded into the "+N more" row, and that row's centre. */
  more: number;
  moreY: number;
  /** Feature id → the y (centre) of its row, relative to the card's top; a folded feature's
   *  connections land on the "+N more" row. */
  rowY: Map<string, number>;
}

export interface MapLayout {
  cards: CardLayout[];
  /** Each connection's ends in canvas coordinates: out of the right of one row, into the left of another. */
  links: { connection: MapConnection; x1: number; y1: number; x2: number; y2: number; internal: boolean; back: boolean }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface LayoutOptions {
  /** Services whose cards list every feature. */
  expanded?: Set<string>;
  /** Features (featureKey) kept in view before others: search matches, the selection. */
  pinned?: Set<string>;
}

/** The rows a card lists: connected and pinned features first, then those with open findings or
 *  on flows, up to ROW_CAP; shown in the service's own order (kind, then title). */
function cardRows(s: MapService, connected: Set<string>, opts: LayoutOptions): { rows: MapFeature[]; more: number } {
  if (opts.expanded?.has(s.slug) || s.features.length <= ROW_CAP) return { rows: s.features, more: 0 };
  const rank = (f: MapFeature) => {
    const k = featureKey(s.slug, f.id);
    return opts.pinned?.has(k) ? 0 : connected.has(k) ? 1 : f.openFindings > 0 ? 2 : f.flowCount > 0 ? 3 : 4;
  };
  const keep = new Set([...s.features].map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).slice(0, ROW_CAP).map((x) => x.f.id));
  const rows = s.features.filter((f) => keep.has(f.id));
  return { rows, more: s.features.length - rows.length };
}

export function cardHeight(rows: number, more: number): number {
  return HEADER_H + Math.max(1, rows) * ROW_H + (more > 0 ? ROW_H : 0) + CARD_PAD;
}

interface Block { w: number; h: number; place: (x: number, y: number) => void; order: number; name: string }

/**
 * Lays the map out so it reads at any size. Services joined by connections form groups; each
 * group runs left to right in the direction its connections go (dagre). The groups, then the
 * services with no connections, are packed in rows to fill a screen-shaped area, rather than
 * stacked in one column.
 */
export function layoutMap(v: VisibleMap, opts: LayoutOptions = {}): MapLayout {
  const connected = new Set(v.connections.flatMap((c) => [featureKey(c.fromProject, c.fromFeature), featureKey(c.toProject, c.toFeature)]));
  const cards: CardLayout[] = v.services.map((s) => {
    const { rows, more } = cardRows(s, connected, opts);
    const h = cardHeight(rows.length, more);
    const moreY = HEADER_H + Math.max(1, rows.length) * ROW_H + ROW_H / 2;
    const rowY = new Map(rows.map((ft, i) => [ft.id, HEADER_H + i * ROW_H + ROW_H / 2]));
    for (const ft of s.features) if (!rowY.has(ft.id)) rowY.set(ft.id, moreY);
    return { service: s, x: 0, y: 0, h, rows, more, moreY, rowY };
  });
  const bySlug = new Map(cards.map((c) => [c.service.slug, c]));

  // Groups: services joined by a connection between two of them.
  const parent = new Map(cards.map((c) => [c.service.slug, c.service.slug]));
  const find = (x: string): string => { const p = parent.get(x)!; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const edges = v.connections.filter((c) => c.fromProject !== c.toProject && bySlug.has(c.fromProject) && bySlug.has(c.toProject));
  for (const c of edges) parent.set(find(c.fromProject), find(c.toProject));
  const groups = new Map<string, CardLayout[]>();
  for (const c of cards) groups.set(find(c.service.slug), [...(groups.get(find(c.service.slug)) ?? []), c]);

  const blocks: Block[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      const c = members[0];
      blocks.push({ w: CARD_W, h: c.h, order: 1, name: c.service.name, place: (x, y) => { c.x = x; c.y = y; } });
      continue;
    }
    const g = new dagre.graphlib.Graph({ multigraph: false });
    g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 140, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    const slugs = new Set(members.map((c) => c.service.slug));
    for (const c of members) g.setNode(c.service.slug, { width: CARD_W, height: c.h });
    for (const c of edges) if (slugs.has(c.fromProject) && slugs.has(c.toProject)) g.setEdge(c.fromProject, c.toProject);
    dagre.layout(g);
    const local = members.map((c) => { const n = g.node(c.service.slug); return { c, x: n.x - CARD_W / 2, y: n.y - c.h / 2 }; });
    const minX = Math.min(...local.map((l) => l.x));
    const minY = Math.min(...local.map((l) => l.y));
    const w = Math.max(...local.map((l) => l.x + CARD_W)) - minX;
    const h = Math.max(...local.map((l) => l.y + l.c.h)) - minY;
    blocks.push({ w, h, order: 0, name: members[0].service.name, place: (x, y) => { for (const l of local) { l.c.x = x + l.x - minX; l.c.y = y + l.y - minY; } } });
  }

  // Bigger groups first, then lone services by name; packed in rows about 16:9 overall.
  blocks.sort((a, b) => a.order - b.order || (a.order === 0 ? b.w * b.h - a.w * a.h : a.name.localeCompare(b.name)));
  const area = blocks.reduce((n, b) => n + (b.w + GAP) * (b.h + GAP), 0);
  const rowWidth = Math.max(Math.sqrt(area * 16 / 9), ...blocks.map((b) => b.w));
  let x = 0, y = 0, shelf = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > rowWidth) { x = 0; y += shelf + GAP; shelf = 0; }
    b.place(x, y);
    x += b.w + GAP;
    shelf = Math.max(shelf, b.h);
  }

  const links: MapLayout['links'] = [];
  for (const c of v.connections) {
    const a = bySlug.get(c.fromProject);
    const b = bySlug.get(c.toProject);
    const ay = a?.rowY.get(c.fromFeature);
    const by = b?.rowY.get(c.toFeature);
    if (!a || !b || ay === undefined || by === undefined) continue;
    const internal = a === b;
    links.push({ connection: c, internal, back: !internal && b.x < a.x + CARD_W, x1: a.x + CARD_W, y1: a.y + ay, x2: internal ? b.x + CARD_W : b.x, y2: b.y + by });
  }
  const bounds = cards.length === 0 ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : {
    minX: Math.min(...cards.map((c) => c.x)),
    minY: Math.min(...cards.map((c) => c.y)),
    maxX: Math.max(...cards.map((c) => c.x + CARD_W)),
    maxY: Math.max(...cards.map((c) => c.y + c.h)),
  };
  return { cards, links, bounds };
}

/** Everything one hop from a feature or service: for hover highlighting. */
export function neighbourhood(v: VisibleMap, focus: { slug: string; feature?: string }): { features: Set<string>; connections: Set<string> } {
  const features = new Set<string>();
  const connections = new Set<string>();
  const touches = (slug: string, id: string) => slug === focus.slug && (!focus.feature || focus.feature === id);
  for (const c of v.connections) {
    if (touches(c.fromProject, c.fromFeature) || touches(c.toProject, c.toFeature)) {
      connections.add(connectionKey(c));
      features.add(featureKey(c.fromProject, c.fromFeature));
      features.add(featureKey(c.toProject, c.toFeature));
    }
  }
  if (focus.feature) features.add(featureKey(focus.slug, focus.feature));
  return { features, connections };
}
