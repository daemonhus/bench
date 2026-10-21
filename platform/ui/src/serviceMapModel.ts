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

export interface CardLayout {
  service: MapService;
  /** Top-left corner. */
  x: number;
  y: number;
  h: number;
  /** Feature id → the y (centre) of its row, relative to the card's top. */
  rowY: Map<string, number>;
}

export interface MapLayout {
  cards: CardLayout[];
  /** Each connection's ends in canvas coordinates: out of the right of one row, into the left of another. */
  links: { connection: MapConnection; x1: number; y1: number; x2: number; y2: number; internal: boolean; back: boolean }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export function cardHeight(s: MapService): number {
  return HEADER_H + Math.max(1, s.features.length) * ROW_H + CARD_PAD;
}

/** Lays the services out left to right in the direction their connections run. */
export function layoutMap(v: VisibleMap): MapLayout {
  const g = new dagre.graphlib.Graph({ multigraph: false });
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 140, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const s of v.services) g.setNode(s.slug, { width: CARD_W, height: cardHeight(s) });
  for (const c of v.connections) {
    if (c.fromProject !== c.toProject && g.hasNode(c.fromProject) && g.hasNode(c.toProject)) g.setEdge(c.fromProject, c.toProject);
  }
  dagre.layout(g);

  const cards: CardLayout[] = v.services.map((s) => {
    const n = g.node(s.slug);
    const h = cardHeight(s);
    const rowY = new Map(s.features.map((ft, i) => [ft.id, HEADER_H + i * ROW_H + ROW_H / 2]));
    return { service: s, x: (n?.x ?? 0) - CARD_W / 2, y: (n?.y ?? 0) - h / 2, h, rowY };
  });
  const bySlug = new Map(cards.map((c) => [c.service.slug, c]));
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
