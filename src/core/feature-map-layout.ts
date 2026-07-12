import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from 'd3-force';
import type { SimulationNodeDatum } from 'd3-force';
import type { Feature, FeatureKind } from './types';

// ---------------------------------------------------------------------------
// Force-directed layout for the Overview feature map (PLAN-feature-graph.md).
// Structure comes from a horizontal bias by BFS depth from the interfaces
// (nodes sit near what they connect to; the flow reads left to right), then
// a d3-force simulation relaxes vertical positions and resolves collisions.
// The simulation is run to convergence synchronously with seeded initial
// positions — d3-force's internal jitter uses a seeded LCG, so the layout is
// deterministic: same data, same picture.
// ---------------------------------------------------------------------------

export const MAP_NODE_CAP = 22;

const KIND_ORDER: FeatureKind[] = ['interface', 'source', 'dependency', 'externality', 'sink'];

export interface FeatureMapNode {
  id: string;
  kind: FeatureKind;
  label: string;
  feature: Feature;
  x: number; // percent
  y: number; // percent
  r: number; // dot radius in px (scales with open findings)
}

export interface FeatureMapLayout {
  nodes: FeatureMapNode[];
  edges: [number, number][];
  truncated: number;
}

/** Dot radius: 8px base, growing with open findings, clamped at 16px. */
export function nodeRadius(openCount: number): number {
  return Math.min(16, 8 + openCount * 2);
}

/** Number of edge pairs whose straight-line segments cross. Test helper. */
export function countCrossings(
  nodes: { x: number; y: number }[],
  edges: [number, number][],
): number {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const segmentsIntersect = (
    a1: [number, number], a2: [number, number],
    b1: [number, number], b2: [number, number],
  ) => {
    const d1 = cross(b1, b2, a1);
    const d2 = cross(b1, b2, a2);
    const d3 = cross(a1, a2, b1);
    const d4 = cross(a1, a2, b2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };

  let count = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if (a === c || a === d || b === c || b === d) continue; // shared endpoint
      const pa: [number, number] = [nodes[a].x, nodes[a].y];
      const pb: [number, number] = [nodes[b].x, nodes[b].y];
      const pc: [number, number] = [nodes[c].x, nodes[c].y];
      const pd: [number, number] = [nodes[d].x, nodes[d].y];
      if (segmentsIntersect(pa, pb, pc, pd)) count++;
    }
  }
  return count;
}

interface SimNode extends SimulationNodeDatum {
  idx: number;
  targetX: number;
}

export function buildFeatureMap(
  features: Feature[],
  openByFeature: Map<string, number> = new Map(),
): FeatureMapLayout {
  // Prefer linked features: they are what makes the map informative.
  const ranked = [...features].sort((a, b) =>
    (b.linkedFeatures?.length ?? 0) - (a.linkedFeatures?.length ?? 0));
  const included = ranked.slice(0, MAP_NODE_CAP);

  // Nodes in stable kind order (colour carries kind; position will not).
  const nodes: FeatureMapNode[] = [];
  const indexById = new Map<string, number>();
  for (const kind of KIND_ORDER) {
    for (const f of included) {
      if (f.kind !== kind) continue;
      indexById.set(f.id, nodes.length);
      nodes.push({
        id: f.id, kind, label: f.title, feature: f,
        x: 50, y: 50, r: nodeRadius(openByFeature.get(f.id) ?? 0),
      });
    }
  }

  // Edges from feature links (deduplicated, both endpoints on the map).
  const edges: [number, number][] = [];
  const neighbours = new Map<number, number[]>();
  const seen = new Set<string>();
  for (const f of included) {
    const from = indexById.get(f.id);
    if (from === undefined) continue;
    for (const link of f.linkedFeatures ?? []) {
      const to = indexById.get(link.id);
      if (to === undefined) continue;
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([from, to]);
      neighbours.set(from, [...(neighbours.get(from) ?? []), to]);
      neighbours.set(to, [...(neighbours.get(to) ?? []), from]);
    }
  }

  // BFS depth from the entry points gives each node its horizontal home.
  // Interfaces seed layer 0; with none, fall back to the first kind present.
  let seeds = nodes.map((_, i) => i).filter((i) => nodes[i].kind === 'interface');
  if (seeds.length === 0) {
    for (const kind of KIND_ORDER) {
      seeds = nodes.map((_, i) => i).filter((i) => nodes[i].kind === kind);
      if (seeds.length > 0) break;
    }
  }
  const depth = new Map<number, number>();
  let frontier = seeds;
  seeds.forEach((i) => depth.set(i, 0));
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      for (const n of neighbours.get(i) ?? []) {
        if (!depth.has(n)) {
          depth.set(n, (depth.get(i) ?? 0) + 1);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  // Unreachable nodes (isolated or separate components) trail on the right.
  const maxDepth = Math.max(0, ...depth.values());
  const orphanLayer = depth.size < nodes.length ? maxDepth + 1 : maxDepth;
  nodes.forEach((_, i) => {
    if (!depth.has(i)) depth.set(i, orphanLayer);
  });
  const layerCount = Math.max(0, ...depth.values()) + 1;

  // The simulation runs in pixel space matching the panel's aspect ratio,
  // so px-based radii and distances mean what they say; positions convert
  // to percent at the end.
  const W = 400;
  const H = 260;
  const layerX = (d: number) => (layerCount === 1 ? W / 2 : W * (0.12 + (d * 0.76) / (layerCount - 1)));

  // Deterministic initial positions: column x, evenly spread y per column.
  const perLayerIndex = new Map<number, number>();
  const layerSizes = new Map<number, number>();
  nodes.forEach((_, i) => layerSizes.set(depth.get(i)!, (layerSizes.get(depth.get(i)!) ?? 0) + 1));
  const simNodes: SimNode[] = nodes.map((_, i) => {
    const d = depth.get(i)!;
    const rank = perLayerIndex.get(d) ?? 0;
    perLayerIndex.set(d, rank + 1);
    const size = layerSizes.get(d)!;
    return {
      idx: i,
      targetX: layerX(d),
      x: layerX(d),
      y: size === 1 ? H / 2 : H * (0.12 + (rank * 0.76) / (size - 1)),
    };
  });

  // Force pass: strong pull to the depth column, weak vertical centring,
  // repulsion plus collision for organic spacing, links pulling neighbours
  // level. Run synchronously to convergence — the map is a diagram.
  const simLinks = edges.map(([a, b]) => ({ source: a, target: b }));
  const sim = forceSimulation(simNodes)
    .force('x', forceX<SimNode>((n) => n.targetX).strength(0.55))
    .force('y', forceY(H / 2).strength(0.03))
    .force('charge', forceManyBody().strength(-160))
    .force('link', forceLink(simLinks).distance(64).strength(0.25))
    // Padded past the dot: labels hang beneath nodes and need clearance.
    .force('collide', forceCollide<SimNode>((n) => nodes[n.idx].r + 16))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();

  for (const sn of simNodes) {
    nodes[sn.idx].x = Math.max(6, Math.min(94, ((sn.x ?? W / 2) / W) * 100));
    nodes[sn.idx].y = Math.max(10, Math.min(86, ((sn.y ?? H / 2) / H) * 100));
  }

  return { nodes, edges, truncated: Math.max(0, features.length - included.length) };
}
