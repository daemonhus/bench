// A flow is a graph: steps joined by edges. To show it as a readable outline (numbered steps,
// a path that continues, branches indented under the step they leave), walk it depth first
// from its entry points: the edges that walk takes form a tree ("tree edges"), and every other
// edge (a join into a step already shown, or a loop back) is listed separately ("extra").

export interface GraphStep {
  id: string;
  /** The flow's step order: it orders the entry points. */
  position: number;
}

export interface GraphEdge {
  fromStepId: string;
  toStepId: string;
  /** Order among the edges leaving fromStepId (its branches). */
  position: number;
  condition?: string;
}

export interface Outline {
  /** Steps in reading order (step N is order[N-1]). */
  order: string[];
  /** Each step's parent in the outline (null for an entry point). */
  parent: Map<string, string | null>;
  /** The edge each step is reached by in the outline (absent for an entry point). */
  via: Map<string, GraphEdge>;
  /** Each step's outline children, in branch order; key null holds the entry points. */
  children: Map<string | null, string[]>;
  /** Edges not in the outline: joins and loops. */
  extra: GraphEdge[];
  /** Steps with no edge into them, in step order. */
  entries: string[];
}

const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

export function outEdges(edges: GraphEdge[], id: string): GraphEdge[] {
  return edges.filter((e) => e.fromStepId === id).sort(byPosition);
}

export function outline(steps: GraphStep[], edges: GraphEdge[]): Outline {
  const ids = new Set(steps.map((s) => s.id));
  const live = edges.filter((e) => ids.has(e.fromStepId) && ids.has(e.toStepId));
  const ordered = [...steps].sort(byPosition);
  const hasIn = new Set(live.map((e) => e.toStepId));
  const entries = ordered.filter((s) => !hasIn.has(s.id)).map((s) => s.id);

  const o: Outline = { order: [], parent: new Map(), via: new Map(), children: new Map([[null, []]]), extra: [], entries };
  const treeEdges = new Set<GraphEdge>();
  const visit = (id: string, parent: string | null, via?: GraphEdge) => {
    o.order.push(id);
    o.parent.set(id, parent);
    if (via) o.via.set(id, via);
    if (!o.children.has(parent)) o.children.set(parent, []);
    o.children.get(parent)!.push(id);
    o.children.set(id, o.children.get(id) ?? []);
    for (const e of outEdges(live, id)) {
      if (o.parent.has(e.toStepId)) continue;
      treeEdges.add(e);
      visit(e.toStepId, id, e);
    }
  };
  for (const id of entries) visit(id, null);
  // Steps only in a loop with no way in: start from the first of them.
  for (const s of ordered) if (!o.parent.has(s.id)) visit(s.id, null);
  o.extra = live.filter((e) => !treeEdges.has(e));
  return o;
}

/** Step numbers in reading order: step id → 1, 2, 3, … */
export function stepNumbers(o: Outline): Map<string, number> {
  return new Map(o.order.map((id, i) => [id, i + 1]));
}

/** The steps reachable from id (excluding it) by following edges. */
export function reachableFrom(edges: GraphEdge[], id: string): Set<string> {
  const seen = new Set<string>();
  const stack = outEdges(edges, id).map((e) => e.toStepId);
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n) || n === id) continue;
    seen.add(n);
    for (const e of outEdges(edges, n)) stack.push(e.toStepId);
  }
  return seen;
}

export const edgeKey = (e: { fromStepId: string; toStepId: string }) => `${e.fromStepId}:${e.toStepId}`;
