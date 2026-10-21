import { useState, useEffect, useMemo, useRef, useCallback, createContext, useContext } from 'react';
import { listProjects, getSettings, type Project } from './api';
import { avatarInitials, avatarColor } from '@bench/core/avatar';
import { useResizeDrag } from '@bench/hooks/useResizeDrag';
import { RefProviderIcon } from '@bench/components/RefProviderIcon';
import { SelectDropdown, ToneChip } from '@bench/components/SelectDropdown';
import { Skeleton, SkeletonRows } from '@bench/components/Skeleton';
import { EditableText, SaveIndicator } from '@bench/components/EditableText';
import { FlowGraphView } from './FlowGraph';
import { outline, edgeKey, reachableFrom, type GraphEdge } from './flowOutline';
import {
  parseFilter, buildFilter,
  FilterSearch, TokenFilterDropdown, SortToggle,
  TagEditor, OwnerEditor,
} from './filters';
import {
  listFolders, createFolder, renameFolder, moveItems, useFolderIndex, useDropTarget, dragSourceProps,
  FolderIcon, FolderPath, ItemMenu, FolderNameDialog, DeleteFolderDialog,
  type FlowFolder, type FolderIndex, type DragItem,
} from './flowFolders';
import './flows.css';

// ─── Inline code rendering ───────────────────────────────────────────────
// Converts `backtick spans` to <code> elements. Only backticks — no other
// markdown — so there's no sanitization concern beyond escaping HTML.

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function InlineText({ text, className }: { text: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: inlineCode(text) }} />;
}

// ─── Types ───────────────────────────────────────────────────────────────

export type FlowStatus = 'draft' | 'active' | 'archived';
// Colours for bench's status control (SelectDropdown "tinted" / ToneChip), as findings and features use.
const FLOW_STATUS_OPTIONS: { value: FlowStatus; label: string; tone: string }[] = [
  { value: 'draft', label: 'Draft', tone: 'var(--status-draft)' },
  { value: 'active', label: 'Active', tone: 'var(--accent-green)' },
  { value: 'archived', label: 'Archived', tone: 'var(--text-muted)' },
];
export const flowStatusOption = (s: string) => FLOW_STATUS_OPTIONS.find((o) => o.value === s);

export interface FlowStep {
  id: string;
  // A flow is a graph (steps + edges); the page shows it as an outline (see flowGraph.ts).
  // These three come from that outline: the step it is reached from (null for an entry
  // point), its place among that step's branches, and the condition on the edge it is
  // reached by.
  parentStepId: string | null;
  position: number;
  branchCondition?: string;
  projectSlug: string;
  featureId: string;
  // Denormalized snapshot — the backend GET /flows/{id} should embed this
  // so the UI doesn't fan out per-step on render.
  projectName: string;
  featureTitle: string;
  featureKind: FeatureKind;
  featureOperation?: string;
  featureProtocol?: string;
  note: string;
  /** Who is acting at this step (anonymous, user, admin, service:billing, …). */
  actor: string;
  /** Checks applied at this step (authn:jwt, authz:rbac, validation, …). */
  controls: string[];
  // Set when the underlying feature is gone (tombstone pattern).
  tombstoned?: boolean;
  // From bench reconciler: 'exact' | 'moved' | 'orphaned' (absent = exact)
  confidence?: string;
}

export type EdgeKind = 'next' | 'call' | 'async' | 'read' | 'write' | 'response';
export const EDGE_KINDS: { value: EdgeKind; label: string; hint: string }[] = [
  { value: 'next', label: 'Next', hint: 'Then (no particular mechanism)' },
  { value: 'call', label: 'Call', hint: 'A synchronous request' },
  { value: 'async', label: 'Async', hint: 'A message or event' },
  { value: 'read', label: 'Read', hint: 'Reads from a store' },
  { value: 'write', label: 'Write', hint: 'Writes to a store' },
  { value: 'response', label: 'Response', hint: 'A reply back' },
];

/** One hop of a flow: from one step to the next, and what travels on it. */
export interface FlowEdge {
  fromStepId: string;
  toStepId: string;
  /** Order among the edges leaving fromStepId. */
  position: number;
  kind: EdgeKind;
  protocol: string;
  /** When this path is taken (a branch label). */
  condition: string;
  /** The identity the hop carries (none, user, service, mtls, …). */
  auth: string;
  trustBoundary: boolean;
  /** What travels on the hop. */
  data: string;
  /** The data is attacker-controlled. */
  tainted: boolean;
  description: string;
  comment: string;
  tags: string[];
}

export type EdgePatch = Partial<Omit<FlowEdge, 'fromStepId' | 'toStepId'>>;

export interface Flow {
  id: string;
  name: string;
  description: string;
  status: FlowStatus;
  owner: string;
  tags: string[];
  folderId?: string;
  createdAt: string;
  updatedAt: string;
  steps: FlowStep[];
  edges: FlowEdge[];
  /** Edges outside the outline: joins into a step shown earlier, and loops back. */
  extraEdges: FlowEdge[];
}

export type FeatureKind = 'interface' | 'source' | 'sink' | 'dependency' | 'externality';

export interface FeatureRef {
  projectSlug: string;
  projectName: string;
  id: string;
  title: string;
  kind: FeatureKind;
  operation?: string;
  protocol?: string;
  anchor?: { fileId: string; commitId: string; lineRange?: { start: number; end: number } };
  tags?: string[];
}

// ─── REST client ─────────────────────────────────────────────────────────

const API = '/api/flows';

export function normalizeEdge(e: any): FlowEdge {
  return {
    fromStepId: e.fromStepId,
    toStepId: e.toStepId,
    position: e.position ?? 0,
    kind: e.kind || 'next',
    protocol: e.protocol ?? '',
    condition: e.condition ?? '',
    auth: e.auth ?? '',
    trustBoundary: !!e.trustBoundary,
    data: e.data ?? '',
    tainted: !!e.tainted,
    description: e.description ?? '',
    comment: e.comment ?? '',
    tags: e.tags ?? [],
  };
}

/** Lay the graph out as an outline: each step's parent, branch order and branch condition. */
function withOutline<T extends { id: string; position: number }>(steps: T[], edges: GraphEdge[]) {
  const o = outline(steps, edges);
  const entryOrder = new Map(o.entries.map((id, i) => [id, i]));
  return {
    outline: o,
    steps: steps.map((s) => {
      const via = o.via.get(s.id);
      return {
        ...s,
        stepOrder: s.position,
        parentStepId: o.parent.get(s.id) ?? null,
        position: via ? via.position : (entryOrder.get(s.id) ?? s.position),
        branchCondition: via?.condition ?? '',
      };
    }),
  };
}

// The backend embeds feature data in a nested `feature` object.
// Flatten it into the flat fields the UI components expect.
function normalizeFlow(f: any): Flow {
  const edges: FlowEdge[] = (f.edges ?? []).map(normalizeEdge);
  const flat = (f.steps ?? []).map((s: any) => ({
    ...s,
    note: s.note ?? '',
    actor: s.actor ?? '',
    controls: s.controls ?? [],
    projectName: s.feature?.projectName ?? s.projectName ?? '',
    featureTitle: s.feature?.title ?? s.featureTitle ?? '',
    featureKind: s.feature?.kind ?? s.featureKind ?? 'interface',
    featureOperation: s.feature?.operation ?? s.featureOperation,
    featureProtocol: s.feature?.protocol ?? s.featureProtocol,
    confidence: s.feature?.confidence ?? s.confidence,
  }));
  const { outline: o, steps } = withOutline(flat, edges);
  const extra = new Set(o.extra.map(edgeKey));
  return { ...f, steps, edges, extraEdges: edges.filter((e) => extra.has(edgeKey(e))) };
}

/** A flow list item's outline, as steps the shape glyphs can draw. */
export function shapeSteps(summary: Pick<FlowSummary, 'shape' | 'shapeEdges'>): FlowStep[] {
  const nodes = summary.shape ?? [];
  const edges = (summary.shapeEdges ?? []).map(([fromStepId, toStepId], i) => ({ fromStepId, toStepId, position: i }));
  return withOutline(nodes, edges).steps as unknown as FlowStep[];
}

// FlowSummary is the lightweight list-page representation returned by the paginated endpoint.
export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  status: FlowStatus;
  owner: string;
  tags: string[];
  folderId?: string;
  stepCount: number;
  projectSlugs: string[];
  createdAt: string;
  updatedAt: string;
  lastBaselinedAt?: string;
  baselineCount?: number;
  openFindings?: FlowFindingCounts;
  openFindingsTotal?: number;
  /** Step skeleton and its edges ([from, to] in branch order), for drawing the flow's outline. */
  shape?: { id: string; position: number; projectSlug?: string; featureId?: string }[];
  shapeEdges?: [string, string][];
}

export interface FlowBaselineSnapshotStep {
  id: string;
  projectSlug: string;
  featureId: string;
  note: string;
  actor?: string;
  controls?: string[];
  position: number;
  feature?: { title: string; kind: string; operation?: string; protocol?: string };
}

export interface FlowBaselineSnapshot {
  version?: number;
  flow: { id: string; name: string; description: string; status: string; tags: string[]; owner: string };
  steps: FlowBaselineSnapshotStep[];
  edges: FlowEdge[];
}

export interface FlowBaseline {
  id: string;
  flowId: string;
  seq: number;
  reviewer: string;
  summary: string;
  createdAt: string;
  snapshot: FlowBaselineSnapshot;
}

export interface FlowDeltaStep {
  id: string;
  projectSlug: string;
  featureId: string;
  note?: string;
}

export interface FlowDeltaChange {
  stepId: string;
  changes: string[];
}

export interface FlowDelta {
  since: { id: string; seq: number; createdAt: string };
  addedSteps: FlowDeltaStep[];
  removedSteps: FlowDeltaStep[];
  changedSteps: FlowDeltaChange[];
  movedAnchors: { stepId: string; from: unknown; to: unknown; confidence: string }[];
  addedEdges: FlowEdge[];
  removedEdges: FlowEdge[];
  changedEdges: { fromStepId: string; toStepId: string; changes: string[] }[];
}

export interface FlowFindingItem {
  id: string;
  stepId: string;
  projectSlug: string;
  title: string;
  severity: string;
  status: string;
  featureId: string;
}

export interface FlowFindingCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface FlowFindings {
  flowId: string;
  total: number;
  bySeverity: FlowFindingCounts;
  findings: FlowFindingItem[];
}

export interface FlowsPage {
  items: FlowSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface FlowView {
  id: string;
  owner: string;
  name: string;
  query: string;
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FlowFacetItem {
  value: string;
  count: number;
}

export interface FlowFacets {
  project: FlowFacetItem[];
  tag: FlowFacetItem[];
  owner: FlowFacetItem[];
  status: FlowFacetItem[];
}

export async function listFlows(params?: {
  q?: string; project?: string[]; tag?: string[]; owner?: string[];
  status?: string[]; sort?: string; order?: string;
  offset?: number; limit?: number; folder?: string; withFindings?: boolean;
}): Promise<FlowsPage> {
  const p = new URLSearchParams();
  if (params?.withFindings) p.set('withFindings', 'true');
  if (params?.q) p.set('q', params.q);
  if (params?.folder) p.set('folder', params.folder);
  params?.project?.forEach(v => p.append('project', v));
  params?.tag?.forEach(v => p.append('tag', v));
  params?.owner?.forEach(v => p.append('owner', v));
  params?.status?.forEach(v => p.append('status', v));
  if (params?.sort) p.set('sort', params.sort);
  if (params?.order) p.set('order', params.order);
  if (params?.offset != null) p.set('offset', String(params.offset));
  if (params?.limit != null) p.set('limit', String(params.limit));
  const qs = p.toString();
  const r = await fetch(qs ? `${API}?${qs}` : API);
  if (!r.ok) throw new Error(await r.text());
  const data: FlowsPage = await r.json();
  return data;
}

/** Every flow matching the filter, paging through the API's 200-per-page limit. For views that
 *  aggregate across all flows (home dashboard, a feature's "Used in flows"). */
export async function listAllFlows(params?: Omit<Parameters<typeof listFlows>[0], 'offset' | 'limit'>): Promise<FlowSummary[]> {
  const out: FlowSummary[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listFlows({ ...params, offset, limit: 200 });
    out.push(...page.items);
    if (page.items.length < 200 || out.length >= page.total) return out;
  }
}

export async function listFlowFacets(params?: {
  q?: string; project?: string[]; tag?: string[]; owner?: string[];
  status?: string[]; folder?: string;
}): Promise<FlowFacets> {
  const p = new URLSearchParams();
  if (params?.q) p.set('q', params.q);
  if (params?.folder) p.set('folder', params.folder);
  params?.project?.forEach(v => p.append('project', v));
  params?.tag?.forEach(v => p.append('tag', v));
  params?.owner?.forEach(v => p.append('owner', v));
  params?.status?.forEach(v => p.append('status', v));
  const qs = p.toString();
  const r = await fetch(qs ? `${API}/facets?${qs}` : `${API}/facets`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listFlowViews(): Promise<FlowView[]> {
  const r = await fetch('/api/flow-views');
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createFlowView(input: { name: string; query: string; owner?: string; isShared?: boolean }): Promise<FlowView> {
  const r = await fetch('/api/flow-views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteFlowView(id: string): Promise<void> {
  await fetch(`/api/flow-views/${id}`, { method: 'DELETE' });
}

export async function getFlow(id: string): Promise<Flow | null> {
  const r = await fetch(`${API}/${id}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await r.text());
  return normalizeFlow(await r.json());
}

export async function createFlow(input: { name: string; description?: string; tags?: string[]; folderId?: string }): Promise<Flow> {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(await r.text());
  return normalizeFlow(await r.json());
}

export async function updateFlow(id: string, patch: Partial<Pick<Flow, 'name' | 'description' | 'status' | 'tags' | 'owner'>>): Promise<Flow> {
  const r = await fetch(`${API}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(await r.text());
  return normalizeFlow(await r.json());
}

// ─── FlowShape SVG glyph ─────────────────────────────────────────────────

// Muted stroke colors per feature kind (lower saturation than the full chips).
const KIND_SHAPE_COLORS: Record<FeatureKind, string> = {
  interface: '#4a8ecf',
  source: '#b08020',
  sink: '#c44040',
  dependency: '#8060cc',
  externality: '#7a8490',
};

// Layout grid → pixels. Depth runs top→bottom (matching the map view);
// branches spread horizontally and each parent is centered over its subtree.
const SHAPE_PAD = 5;
const SHAPE_R = 2.5;
const SHAPE_MAX_H = 22; // content-height budget (fits the card's shape slot)
const SHAPE_MAX_W = 84;

interface ShapeNode {
  step: FlowStep;
  x: number;
  y: number;
}

// Tidy-tree layout: y = depth, leaves take sequential columns, and each parent
// is centered over the horizontal span of its children — so a split is centered.
function layoutShape(steps: FlowStep[]): { nodes: ShapeNode[]; edges: [string, string][] } {
  const pos = new Map<string, { x: number; y: number }>();
  let nextCol = 0;

  function assign(id: string, depth: number): number {
    const children = childrenOf(steps, id);
    let x: number;
    if (children.length === 0) {
      x = nextCol;
      nextCol += 1;
    } else {
      const xs = children.map((c) => assign(c.id, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2; // center over first…last child
    }
    pos.set(id, { x, y: depth });
    return x;
  }
  childrenOf(steps, null).forEach((r) => assign(r.id, 0));

  const nodes: ShapeNode[] = [];
  for (const s of steps) {
    const p = pos.get(s.id);
    if (p) nodes.push({ step: s, x: p.x, y: p.y });
  }
  const edges: [string, string][] = [];
  for (const s of steps) {
    if (s.parentStepId && pos.has(s.id) && pos.has(s.parentStepId)) {
      edges.push([s.parentStepId, s.id]);
    }
  }
  return { nodes, edges };
}

function FlowShape({ steps, large = false }: { steps: FlowStep[]; large?: boolean }) {
  if (!steps || steps.length === 0) return null;

  const { nodes, edges } = layoutShape(steps);
  if (nodes.length === 0) return null;

  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const maxY = Math.max(...nodes.map((n) => n.y));
  const spanX = maxX - minX;
  const spanY = maxY;

  // Scale cells down for deep/wide flows so the glyph stays within its slot. The large
  // variant (flow page header) has roughly four times the budget.
  const maxH = large ? 80 : SHAPE_MAX_H;
  const maxW = large ? 280 : SHAPE_MAX_W;
  const cellMaxH = large ? 34 : 11;
  const cellMaxW = large ? 40 : 13;
  const pad = large ? 10 : SHAPE_PAD;
  const cellH = spanY > 0 ? Math.min(cellMaxH, maxH / spanY) : cellMaxH;
  const cellW = spanX > 0 ? Math.min(cellMaxW, maxW / spanX) : cellMaxW;
  // Dots shrink with their cells, so a 50-step chain or fan-out still reads as its shape
  // (a line of small dots) rather than a solid bar of overlapping circles.
  const tightest = Math.min(spanX > 0 ? cellW : Infinity, spanY > 0 ? cellH : Infinity);
  const r = Math.max(large ? 1.5 : 0.8, Math.min(large ? 6 : SHAPE_R, tightest * 0.4));

  const svgW = spanX * cellW + pad * 2;
  const svgH = spanY * cellH + pad * 2;
  const px = (x: number) => pad + (x - minX) * cellW;
  const py = (y: number) => pad + y * cellH;

  const posById = new Map<string, { x: number; y: number }>();
  for (const n of nodes) posById.set(n.step.id, { x: n.x, y: n.y });

  return (
    <svg
      className="flow-card-shape"
      width={svgW}
      height={svgH}
      viewBox={`0 0 ${svgW} ${svgH}`}
      aria-hidden
    >
      {edges.map(([fromId, toId]) => {
        const from = posById.get(fromId);
        const to = posById.get(toId);
        if (!from || !to) return null;
        return (
          <line
            key={`${fromId}-${toId}`}
            x1={px(from.x)} y1={py(from.y)} x2={px(to.x)} y2={py(to.y)}
            stroke="var(--border-subtle, rgba(139,148,158,0.35))"
            strokeWidth={Math.min(large ? 2 : 1, r * 0.6)}
          />
        );
      })}
      {nodes.map(({ step, x, y }) => {
        const color = KIND_SHAPE_COLORS[step.featureKind] ?? '#7a8490';
        return (
          <circle
            key={step.id}
            cx={px(x)} cy={py(y)} r={r}
            fill={color}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

// A flow's outline drawn large and faint behind its gallery card: the same tidy-tree layout
// as the card glyph and the map, scaled to the card and faded out towards the text.
function FlowCardBackdrop({ flow }: { flow: Pick<FlowSummary, 'shape' | 'shapeEdges'> }) {
  if (!flow.shape?.length) return null;
  const steps = shapeSteps(flow);
  const { nodes, edges } = layoutShape(steps);
  if (nodes.length === 0) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x));
  const maxY = Math.max(...nodes.map((n) => n.y));
  const CELL = 36;
  const PAD = 16;
  const w = (maxX - minX) * CELL + PAD * 2;
  const h = maxY * CELL + PAD * 2;
  const pos = new Map(nodes.map((n) => [n.step.id, { x: PAD + (n.x - minX) * CELL, y: PAD + n.y * CELL }]));
  // CSS scales the drawing down to fit the card (about 240×170). Grow the dots to make up for
  // it, up to just under half a cell, so long chains and wide fans stay visible; lines keep
  // their width at any scale (non-scaling stroke).
  const scale = Math.min(1, 240 / w, 170 / h);
  const r = Math.min(CELL * 0.45, Math.max(6, 3 / scale));
  return (
    <svg className="flow-card-backdrop" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {edges.map(([a, b]) => {
        const from = pos.get(a)!; const to = pos.get(b)!;
        const midY = (from.y + to.y) / 2;
        return <path key={`${a}-${b}`} d={`M${from.x},${from.y} C${from.x},${midY} ${to.x},${midY} ${to.x},${to.y}`} />;
      })}
      {nodes.map(({ step }) => {
        const p = pos.get(step.id)!;
        return <circle key={step.id} cx={p.x} cy={p.y} r={r} />;
      })}
    </svg>
  );
}

// Children of a parent, ordered by their sibling position.
function childrenOf(steps: FlowStep[], parentStepId: string | null): FlowStep[] {
  return steps
    .filter((s) => (s.parentStepId ?? null) === parentStepId)
    .sort((a, b) => a.position - b.position);
}

/** Where a new or moved step goes; none = the end of the main path. */
export interface StepPlace {
  after?: string;
  before?: string;
  /** A new branch out of this step. */
  from?: string;
  entry?: boolean;
}

async function send(method: string, url: string, body?: unknown): Promise<Response> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r;
}

export async function addStep(flowId: string, ref: FeatureRef, place: StepPlace = {}, edge?: EdgePatch): Promise<FlowStep> {
  const r = await send('POST', `${API}/${flowId}/steps`, { ...place, projectSlug: ref.projectSlug, featureId: ref.id, ...(edge ? { edge } : {}) });
  return r.json();
}

export async function updateStep(
  flowId: string,
  stepId: string,
  patch: Partial<Pick<FlowStep, 'note' | 'actor' | 'controls' | 'featureId' | 'projectSlug'>>,
): Promise<void> {
  await send('PATCH', `${API}/${flowId}/steps/${stepId}`, patch);
}

/** splice closes the gap; subtree also removes the steps only reachable through it. */
export async function removeStep(flowId: string, stepId: string, mode: 'splice' | 'subtree' | 'isolate' = 'splice'): Promise<void> {
  await send('DELETE', `${API}/${flowId}/steps/${stepId}?mode=${mode}`);
}

export async function moveStep(flowId: string, stepId: string, direction: -1 | 1): Promise<void> {
  await send('POST', `${API}/${flowId}/steps/${stepId}/move?dir=${direction}`);
}

/** Take a step out (closing the gap) and put it back at place. */
export async function moveStepTo(flowId: string, stepId: string, place: StepPlace, edge?: EdgePatch): Promise<void> {
  await send('POST', `${API}/${flowId}/steps/${stepId}/move`, { ...place, ...(edge ? { edge } : {}) });
}

export async function setEdge(flowId: string, fromStepId: string, toStepId: string, patch: EdgePatch): Promise<FlowEdge> {
  const r = await send('PUT', `${API}/${flowId}/edges/${fromStepId}/${toStepId}`, patch);
  return normalizeEdge(await r.json());
}

export async function deleteEdge(flowId: string, fromStepId: string, toStepId: string): Promise<void> {
  await send('DELETE', `${API}/${flowId}/edges/${fromStepId}/${toStepId}`);
}

/** The flow as one JSON document (what POST /api/flows and PUT …/steps take back). */
export async function exportFlow(flowId: string): Promise<unknown> {
  return (await send('GET', `${API}/${flowId}/export`)).json();
}

// ─── Baseline REST client ─────────────────────────────────────────────────

export async function listFlowBaselines(flowId: string): Promise<FlowBaseline[]> {
  const r = await fetch(`${API}/${flowId}/baselines`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function createFlowBaseline(flowId: string, reviewer?: string, summary?: string): Promise<FlowBaseline> {
  const r = await fetch(`${API}/${flowId}/baselines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: reviewer ?? '', summary: summary ?? '' }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function deleteFlowBaseline(flowId: string, baselineId: string, confirm?: boolean): Promise<unknown> {
  const url = confirm ? `${API}/${flowId}/baselines/${baselineId}?confirm=true` : `${API}/${flowId}/baselines/${baselineId}`;
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return { ok: true };
  return r.json();
}

export async function getFlowDelta(flowId: string, sinceBaselineId?: string): Promise<FlowDelta> {
  const url = sinceBaselineId ? `${API}/${flowId}/delta?since=${sinceBaselineId}` : `${API}/${flowId}/delta`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function listFlowFindingsAPI(flowId: string): Promise<FlowFindings> {
  const r = await fetch(`${API}/${flowId}/findings`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ─── Feature catalog (cross-project) ─────────────────────────────────────

export async function searchFeatures(_projects: Project[], query: string, kindFilter?: FeatureKind, projectFilter?: string): Promise<FeatureRef[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (kindFilter) params.set('kind', kindFilter);
  if (projectFilter) params.set('project', projectFilter);
  const r = await fetch(`/api/features/search?${params}`);
  if (!r.ok) return [];
  const arr: any[] = await r.json();
  return arr.map((f): FeatureRef => ({
    projectSlug: f.projectSlug,
    projectName: f.projectName,
    id: f.id,
    title: f.title,
    kind: f.kind,
    operation: f.operation,
    protocol: f.protocol,
    anchor: f.anchor,
    tags: f.tags ?? [],
  }));
}

// ─── List page ──────────────────────────────────────────────────────────

const PAGE_LIMIT = 50;

interface FlowsListPageProps {
  /** The open folder ('' = top level). */
  folderId: string;
  onOpen: (id: string) => void;
  onOpenFolder: (folderId: string) => void;
}

type ListLayout = 'gallery' | 'table';
type FlowSort = 'updated' | 'created' | 'name' | 'stepCount' | 'risk';
const FLOW_SORTS: { id: FlowSort; label: string; defaultDir: 'asc' | 'desc' }[] = [
  { id: 'updated', label: 'Updated', defaultDir: 'desc' },
  { id: 'created', label: 'Created', defaultDir: 'desc' },
  { id: 'name', label: 'Name', defaultDir: 'asc' },
  { id: 'stepCount', label: 'Steps', defaultDir: 'desc' },
  { id: 'risk', label: 'Risk', defaultDir: 'desc' },
];
const LAYOUT_KEY = 'flows-layout';

function readLayout(): ListLayout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'table' ? 'table' : 'gallery'; } catch { return 'gallery'; }
}

export function FlowsListPage({ folderId, onOpen, onOpenFolder }: FlowsListPageProps) {
  const [page, setPage] = useState<FlowsPage>({ items: [], total: 0, offset: 0, limit: PAGE_LIMIT });
  const [facets, setFacets] = useState<FlowFacets>({ project: [], tag: [], owner: [], status: [] });
  const [folders, setFolders] = useState<FlowFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<FlowSort>('updated');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [projectsList, setProjectsList] = useState<Project[]>([]);
  const [views, setViews] = useState<FlowView[]>([]);
  const [layout, setLayoutState] = useState<ListLayout>(readLayout);
  const [dialog, setDialog] = useState<
    | { kind: 'new-folder' }
    | { kind: 'rename'; folder: FlowFolder }
    | { kind: 'delete'; folder: FlowFolder }
    | null
  >(null);
  const [moveError, setMoveError] = useState('');

  const index = useFolderIndex(folders);
  const filterState = useMemo(() => parseFilter(filter), [filter]);
  // A search or filter looks across every folder; otherwise the page shows one folder.
  const searching = filter.trim() !== '';

  function setLayout(next: ListLayout) {
    setLayoutState(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* per-viewer convenience only */ }
  }

  // Build server-side filter params from the FilterState
  const filterParams = useMemo(() => ({
    q: filterState.text || undefined,
    project: filterState.tokens.project,
    tag: filterState.tokens.tag,
    owner: filterState.tokens.owner,
    status: filterState.tokens.status,
    folder: searching ? undefined : (folderId || 'root'),
    sort,
    order,
    offset,
    limit: PAGE_LIMIT,
  }), [filterState, sort, order, offset, searching, folderId]);

  // Only the latest request may update the page: typing a search fires one request per change,
  // and an older (slower) response must not overwrite a newer one.
  const requestSeq = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const params = filterParams;
    Promise.all([
      listFlows(params),
      listFlowFacets({ q: params.q, project: params.project, tag: params.tag, owner: params.owner, status: params.status, folder: params.folder }),
      listFolders(),
    ])
      .then(([p, f, fo]) => { if (seq === requestSeq.current) { setPage(p); setFacets(f); setFolders(fo); } })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [filterParams]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    listProjects().then(setProjectsList).catch((e) => console.error('load projects:', e));
    listFlowViews().then(setViews).catch(() => {});
  }, []);

  // Reset to page 0 when filters, sort or folder change (but not offset itself)
  const prevKey = useRef(`${filter}|${sort}|${order}|${folderId}`);
  useEffect(() => {
    const key = `${filter}|${sort}|${order}|${folderId}`;
    if (key !== prevKey.current) {
      prevKey.current = key;
      setOffset(0);
    }
  }, [filter, sort, order, folderId]);

  // A folder that no longer exists (deleted elsewhere, stale link) falls back to the top level.
  useEffect(() => {
    if (!loading && folderId && !index.byId.has(folderId)) onOpenFolder('');
  }, [loading, folderId, folders, index, onOpenFolder]);

  // Facet counts from server
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { draft: 0, active: 0, archived: 0 };
    for (const item of facets.status) {
      counts[item.value] = item.count;
    }
    return counts;
  }, [facets.status]);

  const statusFacet = useMemo<FilterDropdownItem[]>(() => [
    { value: 'active', label: 'Active', count: statusCounts.active },
    { value: 'draft', label: 'Draft', count: statusCounts.draft },
    { value: 'archived', label: 'Archived', count: statusCounts.archived },
  ], [statusCounts]);

  const projectFacet = useMemo(() => {
    const labelFor = (slug: string) => projectsList.find((p) => p.slug === slug)?.name ?? slug;
    return facets.project.map(item => ({ value: item.value, label: labelFor(item.value), count: item.count }));
  }, [facets.project, projectsList]);

  const tagFacet = useMemo(() =>
    facets.tag.map(item => ({ value: item.value, label: item.value, count: item.count })),
    [facets.tag]);

  const ownerFacet = useMemo(() =>
    facets.owner.map(item => ({ value: item.value, label: item.value, count: item.count })),
    [facets.owner]);

  function setToken(key: string, values: string[]) {
    const tokens = { ...filterState.tokens };
    if (values.length) tokens[key] = values; else delete tokens[key];
    setFilter(buildFilter({ ...filterState, tokens }));
  }
  const hasTokenFilter = Object.values(filterState.tokens).some((v) => v.length > 0);

  async function handleCreate() {
    if (!newName.trim()) return;
    const created = await createFlow({ name: newName.trim(), folderId: folderId || undefined });
    setNewName('');
    setCreating(false);
    onOpen(created.id);
  }

  async function handleMove(item: DragItem, target: string) {
    setMoveError('');
    try {
      await moveItems([item], target);
      refresh();
    } catch (e: any) {
      setMoveError(`Couldn’t move ${item.name}: ${e.message}`);
    }
  }

  const totalPages = Math.ceil(page.total / PAGE_LIMIT);
  const currentPage = Math.floor(offset / PAGE_LIMIT) + 1;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_LIMIT < page.total;

  function handleSaveView(name: string) {
    createFlowView({ name, query: filter }).then((v) => setViews((prev) => [...prev, v])).catch(() => {});
  }

  function handleDeleteView(id: string) {
    deleteFlowView(id).then(() => setViews((prev) => prev.filter((v) => v.id !== id))).catch(() => {});
  }

  const activeQuery = filter === '' ? '' : (views.find((v) => v.query === filter)?.query ?? null);
  const childFolders = searching ? [] : index.childrenOf(folderId);
  const isEmpty = page.items.length === 0 && childFolders.length === 0;
  const currentFolder = folderId ? index.byId.get(folderId) : undefined;
  const folderMenu = (f: FlowFolder) => ({
    onRename: () => setDialog({ kind: 'rename', folder: f }),
    onDelete: () => setDialog({ kind: 'delete', folder: f }),
  });

  return (
    <div className="flows-list-page">
      <div className="flows-list-header">
        <div>
          <h1 className="overview-section-title">{currentFolder && !searching ? currentFolder.name : 'Flows'}</h1>
          <FolderPath
            folderId={folderId}
            index={index}
            searching={searching}
            onNavigate={(id) => { setFilter(''); onOpenFolder(id); }}
            onDrop={handleMove}
          />
        </div>
        {/* The page's actions sit top right, as "+ Add project" does on Projects. */}
        <div className="flows-list-actions">
          <button className="baseline-action-btn baseline-action-btn-outline flows-new-folder" onClick={() => setDialog({ kind: 'new-folder' })}>
            <FolderIcon /> New folder
          </button>
          <button className="baseline-action-btn baseline-action-btn-primary" onClick={() => setCreating(true)}>
            New flow
          </button>
        </div>
      </div>


      {/* Saved views only earn a tab row when there are some, or while a filter could be saved;
          on its own an "All" tab does nothing. */}
      {(views.length > 0 || activeQuery === null) && <ViewTabs
        views={views}
        activeQuery={activeQuery}
        onSelect={(q) => { setFilter(q); setOffset(0); }}
        onSaveView={handleSaveView}
        onDeleteView={handleDeleteView}
      />}

      {creating && (
        <div className="flows-create-row">
          <input
            autoFocus
            className="finding-edit-input flows-create-input"
            placeholder={currentFolder ? `Flow name, created in ${index.path(folderId)}` : 'Flow name (e.g. Checkout payment path)'}
            aria-label="New flow name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') {
                setCreating(false);
                setNewName('');
              }
            }}
          />
          <button className="baseline-action-btn baseline-action-btn-primary" onClick={handleCreate}>Create</button>
          <button className="baseline-action-btn baseline-action-btn-outline" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
        </div>
      )}

      {/* Same order as the Projects toolbar: search, filter, sort. */}
      <div className="flows-filter-bar">
        <FilterSearch value={filter} onChange={setFilter} placeholder="Search flows…  project:bench tag:mcp" className="flows-search" />
        {/* Bench's filter row (AnnotationFilters): label, dropdowns, reset. */}
        <div className="activity-filters">
          <span className="activity-filters-label">Filter</span>
          <TokenFilterDropdown label="Status" options={statusFacet} selected={filterState.tokens.status ?? []} onChange={(v) => setToken('status', v)} />
          <TokenFilterDropdown label="Project" options={projectFacet} selected={filterState.tokens.project ?? []} onChange={(v) => setToken('project', v)} />
          <TokenFilterDropdown label="Tag" options={tagFacet} selected={filterState.tokens.tag ?? []} onChange={(v) => setToken('tag', v)} />
          <TokenFilterDropdown label="Owner" options={ownerFacet} selected={filterState.tokens.owner ?? []} onChange={(v) => setToken('owner', v)} />
          <button
            type="button"
            className={`activity-filter-clear${hasTokenFilter ? ' activity-filter-clear-visible' : ''}`}
            onClick={() => setFilter(filterState.text)}
            title="Reset filters"
            aria-label="Reset filters"
          >&#x2715;</button>
        </div>
        <div className="flows-filter-bar-end">
          <SortToggle<FlowSort> options={FLOW_SORTS} value={sort} dir={order} onChange={(v, d) => { setSort(v); setOrder(d); }} />
          <div className="activity-kind-toggles flows-layout-toggle" role="group" aria-label="Layout">
            {(['gallery', 'table'] as const).map((l) => (
              <button
                key={l}
                type="button"
                className={`activity-kind-toggle${layout === l ? ' activity-kind-toggle-active' : ''}`}
                aria-pressed={layout === l}
                onClick={() => setLayout(l)}
              >{l === 'gallery' ? 'Gallery' : 'Table'}</button>
            ))}
          </div>
        </div>
      </div>

      {moveError && <div className="flows-move-error" role="alert">{moveError}</div>}

      {loading && page.items.length === 0 && folders.length === 0 ? (
        // Placeholders in the current layout's shape: gallery cards, or table rows.
        layout === 'gallery' ? (
          <div className="flows-gallery" role="status" aria-label="Loading flows">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flow-card flow-card-skeleton" aria-hidden="true">
                <Skeleton height={18} width={64} />
                <Skeleton height={18} width="55%" />
                <Skeleton height={13} width="25%" />
                <Skeleton height={22} width="40%" style={{ marginTop: 'auto' }} />
              </div>
            ))}
          </div>
        ) : <SkeletonRows rows={6} height={40} gap={6} lastWidth="100%" />
      ) : isEmpty ? (
        <div className="flows-empty">
          {searching
            ? 'No flows match this filter.'
            : folderId
              ? 'This folder is empty. Create a flow here, or drag one in.'
              : page.total === 0 && projectsList.length === 0
                ? <>
                    <p>No projects yet.</p>
                    <p className="flows-empty-hint">Add a project first, then create a flow to trace a cross-project path.</p>
                  </>
                : 'No flows yet. Create one to start tracing a cross-project path.'}
        </div>
      ) : (
        <>
          {layout === 'gallery' ? (
            <div className="flows-gallery">
              {childFolders.map((f) => (
                <FolderCard key={f.id} folder={f} index={index} currentFolderId={folderId}
                  onOpen={() => onOpenFolder(f.id)} onMove={handleMove} {...folderMenu(f)} />
              ))}
              {page.items.map((f) => (
                <FlowCard key={f.id} flow={f} projectsList={projectsList} index={index}
                  showFolder={searching} onOpen={onOpen} onMove={handleMove} />
              ))}
            </div>
          ) : (
            <div className="flows-table">
              <div className="flows-table-head">
                <div className="ft-col-flow">Flow</div>
                <div className="ft-col-status">Status</div>
                <div className="ft-col-projects">Projects</div>
                <div className="ft-col-steps">Steps</div>
                <div className="ft-col-findings">Open findings</div>
                <div className="ft-col-updated">Updated</div>
              </div>
              {childFolders.map((f) => (
                <FolderTableRow key={f.id} folder={f} index={index} onOpen={() => onOpenFolder(f.id)} onMove={handleMove} />
              ))}
              {page.items.map((f) => (
                <FlowTableRow key={f.id} flow={f} projectsList={projectsList} onOpen={onOpen}
                  folderPath={searching ? index.path(f.folderId) : ''} />
              ))}
            </div>
          )}
          <div className="flows-table-footer">
            <span className="flows-table-count">
              {page.total} flow{page.total === 1 ? '' : 's'}
              {childFolders.length > 0 && ` · ${childFolders.length} folder${childFolders.length === 1 ? '' : 's'}`}
            </span>
            {page.total > PAGE_LIMIT && (
              <>
                <button
                  className="baseline-action-btn baseline-action-btn-outline flow-pagination-btn"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
                  disabled={!hasPrev}
                >
                  ← Prev
                </button>
                <span className="flow-pagination-info">Page {currentPage} of {totalPages}</span>
                <button
                  className="baseline-action-btn baseline-action-btn-outline flow-pagination-btn"
                  onClick={() => setOffset(offset + PAGE_LIMIT)}
                  disabled={!hasNext}
                >
                  Next →
                </button>
              </>
            )}
          </div>
        </>
      )}

      {dialog?.kind === 'new-folder' && (
        <FolderNameDialog
          title={currentFolder ? `New folder in ${index.path(folderId)}` : 'New folder'}
          submitLabel="Create folder"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => { await createFolder(name, folderId || undefined); setDialog(null); refresh(); }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <FolderNameDialog
          title="Rename folder"
          initial={dialog.folder.name}
          submitLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => { await renameFolder(dialog.folder.id, name); setDialog(null); refresh(); }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteFolderDialog
          folder={dialog.folder}
          path={index.path(dialog.folder.id)}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            const deleted = dialog.folder.id;
            setDialog(null);
            // Deleting the folder you are in (or an ancestor of it) leaves you at its parent.
            if (folderId && index.isWithin(folderId, deleted)) onOpenFolder(dialog.folder.parentId ?? '');
            else refresh();
          }}
        />
      )}
    </div>
  );
}

// ─── Gallery cards ───────────────────────────────────────────────────────

function FolderCard({ folder, index, currentFolderId, onOpen, onMove, onRename, onDelete }: {
  folder: FlowFolder;
  index: FolderIndex;
  currentFolderId: string;
  onOpen: () => void;
  onMove: (item: DragItem, folderId: string) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const item: DragItem = { kind: 'folder', id: folder.id, name: folder.name };
  const drop = useDropTarget(folder.id, index, onMove);
  const parts = [
    `${folder.flowCount} flow${folder.flowCount === 1 ? '' : 's'}`,
    folder.folderCount > 0 ? `${folder.folderCount} folder${folder.folderCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return (
    <div
      className={`flow-card flow-card-folder${drop.isOver ? ' is-drop-target' : ''}`}
      data-folder-id={folder.id}
      {...dragSourceProps(item)}
      {...drop.props}
      onClick={onOpen}
    >
      <div className="flow-card-top">
        <span className="flow-card-folder-icon"><FolderIcon size={18} /></span>
        <ItemMenu item={item} index={index} currentFolderId={currentFolderId} onMove={onMove} onRename={onRename} onDelete={onDelete} />
      </div>
      <button type="button" className="flow-card-title" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
        {folder.name}
      </button>
      <span className="flow-card-meta">{parts.join(' · ')}</span>
    </div>
  );
}

function FlowCard({ flow, projectsList, index, showFolder, onOpen, onMove }: {
  flow: FlowSummary;
  projectsList: Project[];
  index: FolderIndex;
  showFolder: boolean;
  onOpen: (id: string) => void;
  onMove: (item: DragItem, folderId: string) => void;
}) {
  const item: DragItem = { kind: 'flow', id: flow.id, name: flow.name };
  const labelFor = (slug: string) => projectsList.find((p) => p.slug === slug)?.name ?? slug;
  const visible = flow.projectSlugs.slice(0, 4);
  const overflow = flow.projectSlugs.length - visible.length;
  const folderPath = index.path(flow.folderId);
  return (
    <div className="flow-card" data-flow-id={flow.id} {...dragSourceProps(item)} onClick={() => onOpen(flow.id)}>
      {flow.shape && <FlowCardBackdrop flow={flow} />}
      <div className="flow-card-top">
        <ToneChip label={flowStatusOption(flow.status)?.label ?? flow.status} tone={flowStatusOption(flow.status)?.tone} title="Status" />
        <ItemMenu item={item} index={index} currentFolderId={flow.folderId ?? ''} onMove={onMove} />
      </div>
      <button type="button" className="flow-card-title" onClick={(e) => { e.stopPropagation(); onOpen(flow.id); }}>
        {flow.name}
      </button>
      {flow.description && <p className="flow-card-desc">{flow.description}</p>}
      {showFolder && folderPath && (
        <span className="flow-card-folder-path"><FolderIcon size={12} />{folderPath}</span>
      )}
      <div className="flow-card-foot">
        <span className="ft-col-projects">
          {visible.map((slug) => <ProjectAvatar key={slug} slug={slug} name={labelFor(slug)} />)}
          {overflow > 0 && <span className="ft-avatar-overflow">+{overflow}</span>}
        </span>
        <span className="flow-card-meta">
          {flow.stepCount} step{flow.stepCount === 1 ? '' : 's'} · {relativeTime(flow.updatedAt)}
        </span>
      </div>
      {flow.openFindings && flow.openFindingsTotal ? <SeverityPills counts={flow.openFindings} /> : null}
    </div>
  );
}

function FolderTableRow({ folder, index, onOpen, onMove }: {
  folder: FlowFolder;
  index: FolderIndex;
  onOpen: () => void;
  onMove: (item: DragItem, folderId: string) => void;
}) {
  const drop = useDropTarget(folder.id, index, onMove);
  return (
    <button
      className={`flows-table-row flows-table-row-folder${drop.isOver ? ' is-drop-target' : ''}`}
      data-folder-id={folder.id}
      onClick={onOpen}
      {...dragSourceProps({ kind: 'folder', id: folder.id, name: folder.name })}
      {...drop.props}
    >
      <div className="ft-col-flow">
        <span className="ft-flow-name"><FolderIcon /> {folder.name}</span>
        <span className="ft-flow-desc">
          {folder.flowCount} flow{folder.flowCount === 1 ? '' : 's'}
          {folder.folderCount > 0 && ` · ${folder.folderCount} folder${folder.folderCount === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="ft-col-status" />
      <div className="ft-col-projects" />
      <div className="ft-col-steps" />
      <div className="ft-col-findings" />
      <div className="ft-col-updated">{relativeTime(folder.updatedAt)}</div>
    </button>
  );
}

// ─── Detail page ────────────────────────────────────────────────────────

interface FlowDetailPageProps {
  flowId: string;
  /** Back to the list, opened at the flow's folder. */
  onBack: (folderId?: string) => void;
  onOpenProject: (slug: string, hash?: string) => void;
}

const KIND_ICONS: Record<FeatureKind, string> = {
  interface: '⤓',
  source: '◀',
  sink: '▶',
  dependency: '→',
  externality: '◌',
};

const KIND_COLORS: Record<FeatureKind, string> = {
  interface: 'kind-interface',
  source: 'kind-source',
  sink: 'kind-sink',
  dependency: 'kind-dependency',
  externality: 'kind-externality',
};

// Picker context: where the picked feature goes (as a new step), or the step whose feature
// it replaces (repoint).
interface PickerContext {
  place: StepPlace;
  repoint?: string;
}


const SEV_COLORS: Record<string, string> = {
  critical: '#f85149',
  high: '#ff8c00',
  medium: '#d29922',
  low: '#3fb950',
  info: '#58a6ff',
};


function FindingsPanel({ flowId, steps, onClose, onOpenProject, inline }: {
  flowId: string;
  steps: FlowStep[];
  onClose: () => void;
  onOpenProject: (slug: string, hash?: string) => void;
  inline?: boolean;
}) {
  const [findings, setFindings] = useState<FlowFindings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    listFlowFindingsAPI(flowId)
      .then(setFindings)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load findings'))
      .finally(() => setLoading(false));
  }, [flowId]);

  const stepById = useMemo(() => {
    const m = new Map<string, FlowStep>();
    steps.forEach((s) => m.set(s.id, s));
    return m;
  }, [steps]);

  return (
    <div className={inline ? 'flow-tab-panel' : 'baselines-panel'}>
      {/* As a tab the tab itself names the panel: no title or close button, just the count. */}
      {inline ? (
        findings && findings.total > 0 && <div className="flow-tab-panel-summary">{findings.total} open finding{findings.total === 1 ? '' : 's'}</div>
      ) : (
        <div className="baselines-panel-header">
          <span className="baselines-panel-title">
            Findings
            {findings && findings.total > 0 && (
              <span className="findings-panel-count">{findings.total} open</span>
            )}
          </span>
          <button className="icon-btn baselines-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
      )}

      {loading ? (
        <SkeletonRows rows={4} height={40} gap={8} lastWidth="100%" />
      ) : error ? (
        <div className="baselines-empty findings-error">{error}</div>
      ) : !findings || findings.total === 0 ? (
        <div className="baselines-empty">No open findings linked to features in this flow.</div>
      ) : (
        <>
          <div className="findings-panel-summary">
            {(['critical', 'high', 'medium', 'low', 'info'] as Array<keyof FlowFindingCounts>).map((sev) =>
              findings.bySeverity[sev] > 0 ? (
                <span key={sev} className={`findings-sev-chip findings-sev-${sev}`}>
                  {findings.bySeverity[sev]} {sev}
                </span>
              ) : null
            )}
          </div>
          <div className="findings-panel-list">
            {findings.findings.map((ff) => {
              const step = stepById.get(ff.stepId);
              return (
                <div key={ff.id} className="finding-item">
                  <div className="finding-item-header">
                    <span className={`finding-sev-badge finding-sev-${ff.severity}`}>{ff.severity}</span>
                    <span className="finding-item-title">{ff.title}</span>
                  </div>
                  {step && (
                    <button
                      className="finding-step-link"
                      onClick={() => onOpenProject(ff.projectSlug, `#/finding/${ff.id}`)}
                      title={`Open in ${ff.projectSlug}`}
                    >
                      {step.featureTitle || ff.featureId} · {ff.projectSlug}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ─── List-page display helpers ───────────────────────────────────────────

const AVATAR_PALETTE = ['#2563eb', '#7c3aed', '#b45309', '#059669', '#0891b2', '#dc2626', '#7a8490'];

function ProjectAvatar({ slug, name }: { slug: string; name: string }) {
  const color = AVATAR_PALETTE[slug.charCodeAt(0) % AVATAR_PALETTE.length];
  return (
    <span className="ft-project-avatar" style={{ background: color }} title={name}>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function SeverityPills({ counts }: { counts: FlowFindingCounts }) {
  const SEV_INITIALS: Record<string, string> = { critical: 'C', high: 'H', medium: 'M', low: 'L', info: 'I' };
  const active = (['critical', 'high', 'medium', 'low', 'info'] as const).filter((s) => counts[s] > 0);
  if (!active.length) return null;
  return (
    <span className="ft-sev-pills">
      {active.map((s) => (
        <span key={s} className="ft-sev-pill" title={`${counts[s]} ${s}`}>
          <span className="ft-sev-dot" style={{ background: SEV_COLORS[s] }} />
          {counts[s]}{SEV_INITIALS[s]}
        </span>
      ))}
    </span>
  );
}

interface FilterDropdownItem {
  value: string;
  label: string;
  count: number;
}

function ViewTabs({
  views, activeQuery, onSelect, onSaveView, onDeleteView,
}: {
  views: FlowView[];
  activeQuery: string | null;
  onSelect: (query: string) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSaveClick() {
    setSaving(true);
    setSaveName('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleConfirmSave() {
    if (!saveName.trim()) { setSaving(false); return; }
    onSaveView(saveName.trim());
    setSaving(false);
    setSaveName('');
  }

  return (
    <div className="tab-bar tab-bar--transparent flows-view-tabs">
      <div className="tab-bar-tabs">
      <button
        className={`tab-bar-tab flows-view-tab${activeQuery === '' ? ' tab-bar-tab-active' : ''}`}
        aria-current={activeQuery === '' ? 'page' : undefined}
        onClick={() => onSelect('')}
      >
        All
      </button>
      {views.map((v) => (
        <span key={v.id} className="flows-view-tab-group">
          <button
            className={`tab-bar-tab flows-view-tab${activeQuery === v.query ? ' tab-bar-tab-active' : ''}`}
            aria-current={activeQuery === v.query ? 'page' : undefined}
            onClick={() => onSelect(v.query)}
          >
            {v.name}
          </button>
          {confirmingId === v.id ? (
            <span className="flows-view-tab-confirm" role="group" aria-label={`Delete view ${v.name}?`}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setConfirmingId(null); } }}>
              <button className="flows-view-tab-confirm-yes" autoFocus
                onClick={() => { setConfirmingId(null); onDeleteView(v.id); }}>Delete</button>
              <button className="flows-view-tab-confirm-no" onClick={() => setConfirmingId(null)}>Keep</button>
            </span>
          ) : (
            <button
              className="flows-view-tab-close"
              title={`Delete view ${v.name}`}
              aria-label={`Delete view ${v.name}`}
              onClick={() => setConfirmingId(v.id)}
            >✕</button>
          )}
        </span>
      ))}
      {saving ? (
        <div className="flows-view-tab-save-row">
          <input
            ref={inputRef}
            className="finding-edit-input flows-input-compact"
            placeholder="View name"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleConfirmSave();
              if (e.key === 'Escape') { setSaving(false); setSaveName(''); }
            }}
          />
          <button className="baseline-action-btn baseline-action-btn-primary" onClick={handleConfirmSave}>Save</button>
          <button className="baseline-action-btn baseline-action-btn-outline" onClick={() => { setSaving(false); setSaveName(''); }}>Cancel</button>
        </div>
      ) : (
        activeQuery === null && (
          <button className="flows-view-tab-save" onClick={handleSaveClick}>+ Save view</button>
        )
      )}
      </div>
    </div>
  );
}

function FlowTableRow({ flow, projectsList, onOpen, folderPath = '' }: {
  flow: FlowSummary;
  projectsList: Project[];
  onOpen: (id: string) => void;
  folderPath?: string;
}) {
  const labelFor = (slug: string) => projectsList.find((p) => p.slug === slug)?.name ?? slug;
  const visible = flow.projectSlugs.slice(0, 3);
  const overflow = flow.projectSlugs.length - visible.length;
  return (
    <button className="flows-table-row" data-flow-id={flow.id} onClick={() => onOpen(flow.id)}
      {...dragSourceProps({ kind: 'flow', id: flow.id, name: flow.name })}>
      <div className="ft-col-flow">
        <span className="ft-flow-name">{flow.name}</span>
        {folderPath && <span className="ft-flow-desc"><FolderIcon size={11} /> {folderPath}</span>}
        {flow.description && <span className="ft-flow-desc">{flow.description}</span>}
      </div>
      <div className="ft-col-status">
        <ToneChip label={flowStatusOption(flow.status)?.label ?? flow.status} tone={flowStatusOption(flow.status)?.tone} title="Status" />
      </div>
      <div className="ft-col-projects">
        {visible.map((slug) => (
          <ProjectAvatar key={slug} slug={slug} name={labelFor(slug)} />
        ))}
        {overflow > 0 && <span className="ft-avatar-overflow">+{overflow}</span>}
      </div>
      <div className="ft-col-steps">{flow.stepCount}</div>
      <div className="ft-col-findings">
        {flow.openFindings && flow.openFindingsTotal && flow.openFindingsTotal > 0
          ? <SeverityPills counts={flow.openFindings} />
          : <span className="ft-none">—</span>}
      </div>
      <div className="ft-col-updated">{relativeTime(flow.updatedAt)}</div>
    </button>
  );
}

function BaselinesPanel({ flowId, onClose, inline }: { flowId: string; onClose: () => void; inline?: boolean }) {
  const [baselines, setBaselines] = useState<FlowBaseline[]>([]);
  const [creating, setCreating] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<FlowBaseline | null>(null);
  const [delta, setDelta] = useState<FlowDelta | null>(null);
  const [loadingDelta, setLoadingDelta] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    listFlowBaselines(flowId).then(setBaselines).catch((e) => console.error('load baselines:', e));
  }, [flowId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleCreate() {
    setSaving(true);
    setError('');
    try {
      await createFlowBaseline(flowId, reviewer.trim() || undefined, summary.trim() || undefined);
      setCreating(false);
      setReviewer('');
      setSummary('');
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create baseline');
    } finally {
      setSaving(false);
    }
  }

  async function handleSelect(b: FlowBaseline) {
    setSelected(b);
    setLoadingDelta(true);
    try {
      const d = await getFlowDelta(flowId, b.id);
      setDelta(d);
    } catch (e) {
      console.error('load delta:', e);
      setDelta(null);
    } finally {
      setLoadingDelta(false);
    }
  }

  async function handleDelete(b: FlowBaseline) {
    if (!confirm(`Delete baseline v${b.seq}? This cannot be undone.`)) return;
    try {
      await deleteFlowBaseline(flowId, b.id, true);
      if (selected?.id === b.id) { setSelected(null); setDelta(null); }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete baseline');
    }
  }

  return (
    <div className={inline ? 'flow-tab-panel' : 'baselines-panel'}>
      {!inline && (
        <div className="baselines-panel-header">
          <span className="baselines-panel-title">Baselines</span>
          <button className="icon-btn baselines-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
      )}

      {selected ? (
        <div className="baselines-detail">
          <button className="fd-back baselines-back" onClick={() => { setSelected(null); setDelta(null); }}>← All baselines</button>
          <div className="baselines-detail-header">
            <span className="baselines-seq">v{selected.seq}</span>
            <span className="baselines-date">{relativeTime(selected.createdAt)}</span>
            {selected.reviewer && <span className="baselines-reviewer">{selected.reviewer}</span>}
          </div>
          {selected.summary && <p className="baselines-summary">{selected.summary}</p>}
          <div className="baselines-snapshot-meta">
            <span>{selected.snapshot.steps.length} step{selected.snapshot.steps.length === 1 ? '' : 's'}</span>
          </div>

          {loadingDelta ? (
            <div className="baselines-delta-loading">Computing delta…</div>
          ) : delta ? (
            <div className="baselines-delta">
              <div className="baselines-delta-title">Changes since this baseline</div>
              {[delta.addedSteps, delta.removedSteps, delta.changedSteps, delta.addedEdges ?? [], delta.removedEdges ?? [], delta.changedEdges ?? []].every((l) => l.length === 0) ? (
                <div className="baselines-delta-empty">No changes since this baseline.</div>
              ) : (
                <>
                  {delta.addedSteps.length > 0 && (
                    <div className="baselines-delta-section">
                      <span className="baselines-delta-label baselines-delta-added">+ {delta.addedSteps.length} step{delta.addedSteps.length === 1 ? '' : 's'} added</span>
                    </div>
                  )}
                  {delta.removedSteps.length > 0 && (
                    <div className="baselines-delta-section">
                      <span className="baselines-delta-label baselines-delta-removed">− {delta.removedSteps.length} step{delta.removedSteps.length === 1 ? '' : 's'} removed</span>
                    </div>
                  )}
                  {delta.changedSteps.length > 0 && (
                    <div className="baselines-delta-section">
                      <span className="baselines-delta-label baselines-delta-changed">~ {delta.changedSteps.length} step{delta.changedSteps.length === 1 ? '' : 's'} changed</span>
                      <span className="baselines-delta-detail">{[...new Set(delta.changedSteps.flatMap((c) => c.changes))].join(', ')}</span>
                    </div>
                  )}
                  {(delta.addedEdges ?? []).length > 0 && (
                    <div className="baselines-delta-section">
                      <span className="baselines-delta-label baselines-delta-added">+ {delta.addedEdges.length} connection{delta.addedEdges.length === 1 ? '' : 's'} added</span>
                    </div>
                  )}
                  {(delta.removedEdges ?? []).length > 0 && (
                    <div className="baselines-delta-section">
                      <span className="baselines-delta-label baselines-delta-removed">− {delta.removedEdges.length} connection{delta.removedEdges.length === 1 ? '' : 's'} removed</span>
                    </div>
                  )}
                  {(delta.changedEdges ?? []).length > 0 && (
                    <div className="baselines-delta-section">
                      <span className="baselines-delta-label baselines-delta-changed">~ {delta.changedEdges.length} connection{delta.changedEdges.length === 1 ? '' : 's'} changed</span>
                      <span className="baselines-delta-detail">{[...new Set(delta.changedEdges.flatMap((c) => c.changes))].join(', ')}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}

          <div className="baselines-detail-actions">
            <button className="flows-btn-danger baselines-delete-btn" onClick={() => handleDelete(selected)}>Delete</button>
          </div>
        </div>
      ) : (
        <>
          <div className="baselines-list">
            {baselines.length === 0 ? (
              <div className="baselines-empty">No baselines yet. Capture a baseline to track changes over time.</div>
            ) : (
              baselines.map((b) => (
                <button key={b.id} className="baseline-item" onClick={() => handleSelect(b)}>
                  <span className="baselines-seq">v{b.seq}</span>
                  <span className="baselines-date">{relativeTime(b.createdAt)}</span>
                  {b.reviewer && <span className="baselines-reviewer">{b.reviewer}</span>}
                  {b.summary && <span className="baselines-item-summary">{b.summary}</span>}
                </button>
              ))
            )}
          </div>

          {creating ? (
            <div className="baselines-create-form">
              <input
                className="finding-edit-input"
                placeholder="Reviewer (optional)"
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
              />
              <input
                className="finding-edit-input"
                placeholder="Summary (optional)"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
              {error && <div className="baselines-error">{error}</div>}
              <div className="baselines-create-actions">
                <button className="baseline-action-btn baseline-action-btn-primary" onClick={handleCreate} disabled={saving}>
                  {saving ? 'Saving…' : 'Capture baseline'}
                </button>
                <button className="baseline-action-btn baseline-action-btn-outline" onClick={() => { setCreating(false); setError(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="baseline-action-btn baseline-action-btn-primary baselines-new-btn" onClick={() => setCreating(true)}>
              + New baseline
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── MapStepPanel ────────────────────────────────────────────────────────

function parseOpMethod(op: string): { method: string | null; path: string } {
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    if (op.startsWith(m + ' ') || op === m) return { method: m, path: op.slice(m.length).trim() };
  }
  return { method: null, path: op };
}

// Grows a textarea to fit its content.
function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

const PARAM_TYPE_COLORS: Record<string, string> = {
  string: '#16a34a', integer: '#2563eb', number: '#2563eb', boolean: '#7c3aed',
  object: '#d97706', array: '#0891b2', file: '#db2777',
};

// Shared resizable width for the map step/link side panels, persisted in localStorage.
const MAP_PANEL_WIDTH_KEY = 'flow-map-panel-width';

// The comment author comes from the platform user profile (Settings → General
// → Display name). Fetched once per session and shared across panels.
let displayNamePromise: Promise<string> | null = null;
function fetchDisplayName(): Promise<string> {
  displayNamePromise ??= getSettings()
    .then((s) => {
      if (!s.general) return '';
      try { return String(JSON.parse(s.general).displayName ?? '').trim(); } catch { return ''; }
    })
    .catch(() => '');
  return displayNamePromise;
}
function useDisplayName(): string {
  const [name, setName] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetchDisplayName().then((n) => { if (!cancelled) setName(n); });
    return () => { cancelled = true; };
  }, []);
  return name;
}
function useMapPanelWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(MAP_PANEL_WIDTH_KEY));
    return saved >= 240 && saved <= 640 ? saved : 320;
  });
  const onResizeStart = useResizeDrag((w) => {
    setWidth(w);
    localStorage.setItem(MAP_PANEL_WIDTH_KEY, String(w));
  }, { min: 240, max: 640, fromRight: true });
  return { width, onResizeStart };
}

interface StepFeatureParam { id: string; name: string; type?: string; required?: boolean; pattern?: string; description?: string; }

// Per-project feature detail (parameters + resolved links), keyed `${slug}:${featureId}`.
// Built once per flow and shared with the step rows via context (no prop drilling).
interface IndexedFeature {
  parameters: StepFeatureParam[];
  links: { id: string; title?: string; kind?: FeatureKind; operation?: string }[];
  refs: StepFeatureRef[];
}
const FeatureIndexContext = createContext<Map<string, IndexedFeature>>(new Map());
interface StepFeatureComment { id: string; author: string; text: string }
interface StepFeatureLink { id: string; description?: string; title?: string; kind?: FeatureKind; operation?: string }
interface StepFeatureRef { provider: string; url: string; title?: string }
interface StepFeatureAnchor { fileId: string; commitId: string; lineRange?: { start: number; end: number } }
interface StepFeatureDetail {
  description?: string;
  anchor?: StepFeatureAnchor;
  confidence?: string;
  status?: string;
  parameters: StepFeatureParam[];
  linkedFeatures: StepFeatureLink[];
  refs: StepFeatureRef[];
  comments: StepFeatureComment[];
}

function MapStepPanel({
  step, flowId, withSave, onRefresh, onClose, onOpenProject,
}: {
  step: FlowStep;
  flowId: string;
  withSave: <T>(fn: () => Promise<T>) => Promise<T>;
  onRefresh: () => void;
  onClose: () => void;
  onOpenProject: (slug: string, hash?: string) => void;
}) {
  const [actor, setActor] = useState(step.actor);
  useEffect(() => setActor(step.actor), [step.id, step.actor]);
  const saveStep = async (patch: Partial<Pick<FlowStep, 'actor' | 'controls'>>) => {
    await withSave(() => updateStep(flowId, step.id, patch));
    onRefresh();
  };
  const { method, path: opPath } = parseOpMethod(step.featureOperation ?? step.featureProtocol ?? '');
  const [detail, setDetail] = useState<StepFeatureDetail | null>(null);
  const author = useDisplayName();
  const [commentText, setCommentText] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [commentError, setCommentError] = useState('');
  const commentBoxRef = useAutosize(commentText);
  const { width, onResizeStart } = useMapPanelWidth();

  // Post a review comment to the project workbench, linked to this step's
  // feature and anchored at the feature's current code location.
  async function postComment() {
    const text = commentText.trim();
    if (!author || !text || postingComment || !detail) return;
    setPostingComment(true);
    setCommentError('');
    try {
      const r = await fetch(`/api/projects/${step.projectSlug}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author,
          text,
          featureId: step.featureId,
          commentType: 'feature',
          ...(detail.anchor?.fileId ? { anchor: detail.anchor } : {}),
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const created = await r.json();
      setDetail((d) => (d ? { ...d, comments: [...d.comments, { id: created.id, author: created.author, text: created.text }] } : d));
      setCommentText('');
    } catch (e) {
      setCommentError(e instanceof Error && e.message ? e.message : 'Failed to post comment');
    } finally {
      setPostingComment(false);
    }
  }

  // Pull the feature's parameters, linked features, and comments from the
  // project workbench (via /api/projects/{slug}) for the sidebar preview.
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setCommentText('');
    setCommentError('');
    if (!step.featureId || !step.projectSlug || step.tombstoned) return;
    const base = `/api/projects/${step.projectSlug}`;
    const j = (url: string, fb: any) => fetch(url).then((r) => (r.ok ? r.json() : fb)).catch(() => fb);
    (async () => {
      const [feat, comments, refs] = await Promise.all([
        j(`${base}/features/${encodeURIComponent(step.featureId)}?commit=HEAD`, null),
        j(`${base}/comments?featureId=${encodeURIComponent(step.featureId)}`, []),
        j(`${base}/refs?entityType=feature&entityId=${encodeURIComponent(step.featureId)}`, []),
      ]);
      // Resolve each linked feature's title/kind (the feature only stores ids).
      const rawLinks: { id: string; description?: string }[] = feat?.linkedFeatures ?? [];
      let linkedFeatures: StepFeatureLink[] = rawLinks;
      if (rawLinks.length > 0) {
        const all: any[] = await j(`${base}/features`, []);
        const byId = new Map<string, any>(all.map((f) => [f.id, f]));
        linkedFeatures = rawLinks.map((l) => {
          const f = byId.get(l.id);
          return { id: l.id, description: l.description, title: f?.title, kind: f?.kind, operation: f?.operation };
        });
      }
      if (cancelled) return;
      setDetail({
        description: feat?.description ?? '',
        anchor: feat?.effectiveAnchor ?? feat?.anchor,
        confidence: feat?.confidence,
        status: feat?.status,
        parameters: feat?.parameters ?? [],
        linkedFeatures,
        refs: Array.isArray(refs) ? refs : [],
        comments: Array.isArray(comments) ? comments : [],
      });
    })();
    return () => { cancelled = true; };
  }, [step.featureId, step.projectSlug, step.tombstoned]);

  return (
    <div className="map-step-panel" style={{ width }}>
      <div className="map-step-panel-resize-handle" onMouseDown={onResizeStart} />
      <div className="map-step-panel-header">
        <span className={`flow-step-kind kind-${step.featureKind}`}>{step.featureKind}</span>
        <span className="map-step-panel-project">{step.projectName}</span>
        <button className="icon-btn map-step-panel-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="map-step-panel-body">
        <div className="map-step-panel-title-row">
          {method && <span className="map-step-method" data-method={method}>{method}</span>}
          <div className="map-step-panel-title">{step.featureTitle || step.featureId}</div>
          {!step.tombstoned && (
            <button
              className="flow-step-title-link"
              onClick={() => onOpenProject(step.projectSlug, `#/feature/${step.featureId}`)}
              title="Open feature detail"
              aria-label="Open feature detail"
            >↗</button>
          )}
        </div>
        {opPath && <code className="map-step-panel-path">{opPath}</code>}
        {(detail?.confidence || detail?.status) && (
          <div className="map-step-panel-meta">
            {detail.status && <span className="map-step-status">{detail.status}</span>}
            {detail.confidence && (
              <span className={`map-step-conf map-step-conf--${detail.confidence}`}>● {detail.confidence}</span>
            )}
          </div>
        )}
        {detail?.anchor?.fileId && (
          <button
            className="map-step-loc"
            onClick={() => onOpenProject(step.projectSlug, `#/browse/${detail.anchor!.fileId}`)}
            title="Open in code"
          >
            {detail.anchor.fileId}{detail.anchor.lineRange ? `:${detail.anchor.lineRange.start}` : ''}
          </button>
        )}
        {detail?.description && (
          <p className="map-step-desc">{detail.description}</p>
        )}
        {step.tombstoned && (
          <p className="map-step-panel-tombstoned">This feature has been removed from the project.</p>
        )}
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="map-step-actor">Actor</label>
          <input
            id="map-step-actor"
            className="finding-edit-input map-step-panel-input"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            onBlur={() => { if (actor !== step.actor) saveStep({ actor }); }}
            placeholder="Who acts here (anonymous, user, service:billing…)"
          />
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label">Controls</label>
          <TagEditor tags={step.controls} onChange={(controls) => saveStep({ controls })} placeholder="authn, authz, validation…" />
        </div>
        {step.note && (
          <div className="map-step-panel-field">
            <label className="map-step-panel-label">Step note</label>
            <p className="map-step-note-ro">{step.note}</p>
          </div>
        )}

        {detail && detail.parameters.length > 0 && (
          <div className="map-step-panel-field">
            <label className="map-step-panel-label">Parameters <span className="map-step-count">{detail.parameters.length}</span></label>
            <div className="map-step-sub">
              {detail.parameters.map((p) => {
                const tc = p.type ? (PARAM_TYPE_COLORS[p.type] ?? 'var(--text-muted)') : 'var(--text-muted)';
                return (
                  <div key={p.id} className="map-step-param">
                    <div className="map-step-param-head">
                      <span className="map-step-param-name">{p.name}</span>
                      {p.type && (
                        <span
                          className="map-step-param-type"
                          style={{
                            color: tc,
                            borderColor: `color-mix(in srgb, ${tc} 30%, transparent)`,
                            background: `color-mix(in srgb, ${tc} 10%, transparent)`,
                          }}
                        >{p.type}</span>
                      )}
                      {p.required && <span className="map-step-param-req">required</span>}
                    </div>
                    {p.pattern && <code className="map-step-param-pattern">{p.pattern}</code>}
                    {p.description && <div className="map-step-param-desc">{p.description}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {detail && (detail.refs.length > 0 || detail.linkedFeatures.length > 0) && (
          <div className="map-step-panel-field">
            <label className="map-step-panel-label">Links <span className="map-step-count">{detail.refs.length + detail.linkedFeatures.length}</span></label>
            <div className="map-step-sub">
              {detail.refs.map((r, i) => (
                <a
                  key={`ref-${i}`}
                  className="map-step-ref"
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  title={r.title || r.url}
                >
                  <RefProviderIcon provider={r.provider} size={13} />
                  <span className="map-step-ref-title">{r.title || r.url}</span>
                </a>
              ))}
              {detail.linkedFeatures.map((l) => (
                <button
                  key={l.id}
                  className="map-step-link"
                  onClick={() => onOpenProject(step.projectSlug, `#/feature/${l.id}`)}
                  title="Open linked feature"
                >
                  <div className="map-step-link-head">
                    {l.kind && <span className={`flow-step-kind kind-${l.kind}`}>{l.kind}</span>}
                    <span className="map-step-link-title">{l.title || l.id.slice(0, 8)}</span>
                  </div>
                  {l.description && <span className="map-step-link-desc">{l.description}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {detail && (
          <div className="map-step-panel-field">
            <label className="map-step-panel-label">Comments <span className="map-step-count">{detail.comments.length}</span></label>
            <div className="map-step-sub">
              {detail.comments.map((c) => (
                <div key={c.id} className="map-step-comment">
                  <span className="map-step-comment-avatar" style={{ background: avatarColor(c.author) }}>
                    {avatarInitials(c.author)}
                  </span>
                  <div className="map-step-comment-body">
                    <div className="map-step-comment-author">{c.author || 'anon'}</div>
                    <div className="map-step-comment-text">{c.text}</div>
                  </div>
                </div>
              ))}
              <div className="map-step-comment-form">
                <textarea
                  ref={commentBoxRef}
                  className="finding-edit-textarea map-step-panel-textarea"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postComment();
                  }}
                  placeholder="Comment on this feature…"
                  rows={2}
                />
                {commentError && <div className="map-step-comment-error">{commentError}</div>}
                <div className="map-step-comment-form-actions">
                  {!author && <span className="map-step-comment-hint">Set a display name in Settings to comment</span>}
                  <button
                    className="baseline-action-btn baseline-action-btn-primary"
                    onClick={postComment}
                    disabled={!author || !commentText.trim() || postingComment}
                  >
                    {postingComment ? 'Posting…' : 'Comment'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MapEdgePanel ─────────────────────────────────────────────────────────

const AUTH_SUGGESTIONS = ['none', 'user', 'admin', 'service', 'mtls', 'api-key', 'session-cookie', 'jwt'];

/** Short chips describing a hop: its kind (unless plain "next"), protocol, auth and flags. */
export function edgeChips(e: FlowEdge): { key: string; label: string; tone?: 'warn' | 'danger' }[] {
  const chips: { key: string; label: string; tone?: 'warn' | 'danger' }[] = [];
  if (e.kind !== 'next') chips.push({ key: 'kind', label: e.protocol ? `${e.kind} · ${e.protocol}` : e.kind });
  else if (e.protocol) chips.push({ key: 'kind', label: e.protocol });
  if (e.auth) chips.push({ key: 'auth', label: `auth: ${e.auth}` });
  if (e.trustBoundary) chips.push({ key: 'tb', label: 'trust boundary', tone: 'warn' });
  if (e.tainted) chips.push({ key: 'taint', label: 'tainted', tone: 'danger' });
  return chips;
}

function EdgeChips({ edge }: { edge: FlowEdge }) {
  const chips = edgeChips(edge);
  if (chips.length === 0) return null;
  return (
    <span className="flow-edge-chips">
      {chips.map((c) => (
        <span key={c.key} className={`flow-edge-chip${c.tone ? ` flow-edge-chip--${c.tone}` : ''}`}>{c.label}</span>
      ))}
    </span>
  );
}

function MapEdgePanel({
  edge, fromStep, toStep, flowId, onClose, onRefresh, withSave,
}: {
  edge: FlowEdge;
  fromStep: FlowStep;
  toStep: FlowStep;
  flowId: string;
  onClose: () => void;
  onRefresh: () => void;
  withSave: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const [draft, setDraft] = useState(edge);
  const [tagInput, setTagInput] = useState(edge.tags.join(', '));
  const commentRef = useAutosize(draft.comment);
  const { width, onResizeStart } = useMapPanelWidth();

  // Reset only when another connection is opened: a refresh after saving one field must not
  // wipe what is being typed into the next.
  useEffect(() => {
    setDraft(edge);
    setTagInput(edge.tags.join(', '));
  }, [edge.fromStepId, edge.toStepId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(patch: EdgePatch) {
    const changed = (Object.keys(patch) as (keyof EdgePatch)[]).some((k) => JSON.stringify(patch[k]) !== JSON.stringify(edge[k]));
    if (!changed) return;
    await withSave(() => setEdge(flowId, edge.fromStepId, edge.toStepId, patch));
    onRefresh();
  }
  const text = (k: 'protocol' | 'condition' | 'auth' | 'data' | 'description') => ({
    value: draft[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value }),
    onBlur: () => save({ [k]: draft[k] }),
  });

  async function remove() {
    await withSave(() => deleteEdge(flowId, edge.fromStepId, edge.toStepId));
    onClose();
    onRefresh();
  }

  return (
    <div className="map-step-panel" style={{ width }} aria-label="Connection">
      <div className="map-step-panel-resize-handle" onMouseDown={onResizeStart} />
      <div className="map-step-panel-header">
        <span className="map-step-panel-link-label">Connection</span>
        <button className="icon-btn map-step-panel-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="map-step-panel-body">
        <div className="map-link-panel-route">
          <span className={`flow-step-kind kind-${fromStep.featureKind}`}>{fromStep.featureKind}</span>
          <span className="map-link-panel-title">{fromStep.featureTitle || fromStep.featureId}</span>
          <span className="map-link-panel-arrow">→</span>
          <span className={`flow-step-kind kind-${toStep.featureKind}`}>{toStep.featureKind}</span>
          <span className="map-link-panel-title">{toStep.featureTitle || toStep.featureId}</span>
        </div>
        {fromStep.projectSlug !== toStep.projectSlug && (
          <div className="map-edge-cross">Crosses from {fromStep.projectName || fromStep.projectSlug} to {toStep.projectName || toStep.projectSlug}</div>
        )}
        <div className="map-edge-grid">
          <div className="map-step-panel-field">
            <label className="map-step-panel-label">Kind</label>
            <SelectDropdown<EdgeKind>
              label="Connection kind"
              options={EDGE_KINDS.map((k) => ({ value: k.value, label: k.label }))}
              value={draft.kind}
              onChange={(kind) => { setDraft({ ...draft, kind }); save({ kind }); }}
            />
          </div>
          <div className="map-step-panel-field">
            <label className="map-step-panel-label" htmlFor="edge-protocol">Protocol</label>
            <input id="edge-protocol" className="finding-edit-input map-step-panel-input" placeholder="http, grpc, sql…" {...text('protocol')} />
          </div>
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="edge-condition">Condition</label>
          <input id="edge-condition" className="finding-edit-input map-step-panel-input" placeholder="When this path is taken (if user is admin…)" {...text('condition')} />
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="edge-auth">Identity carried</label>
          <input id="edge-auth" list="edge-auth-options" className="finding-edit-input map-step-panel-input" placeholder="none, user, service, mtls…" {...text('auth')} />
          <datalist id="edge-auth-options">{AUTH_SUGGESTIONS.map((a) => <option key={a} value={a} />)}</datalist>
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="edge-data">Data</label>
          <input id="edge-data" className="finding-edit-input map-step-panel-input" placeholder="What travels on this hop" {...text('data')} />
        </div>
        <div className="map-edge-flags">
          <label className="map-edge-flag">
            <input type="checkbox" checked={draft.trustBoundary} onChange={(e) => { setDraft({ ...draft, trustBoundary: e.target.checked }); save({ trustBoundary: e.target.checked }); }} />
            Crosses a trust boundary
          </label>
          <label className="map-edge-flag">
            <input type="checkbox" checked={draft.tainted} onChange={(e) => { setDraft({ ...draft, tainted: e.target.checked }); save({ tainted: e.target.checked }); }} />
            Attacker-controlled data
          </label>
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="edge-label">Label</label>
          <input id="edge-label" className="finding-edit-input map-step-panel-input" placeholder="Short label shown on the edge…" {...text('description')} />
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="edge-comment">Comment</label>
          <textarea
            id="edge-comment"
            ref={commentRef}
            className="finding-edit-textarea map-step-panel-textarea"
            value={draft.comment}
            onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
            onBlur={() => save({ comment: draft.comment })}
            placeholder="Review note for this connection…"
            rows={3}
          />
        </div>
        <div className="map-step-panel-field">
          <label className="map-step-panel-label" htmlFor="edge-tags">Tags</label>
          <input
            id="edge-tags"
            className="finding-edit-input map-step-panel-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onBlur={() => save({ tags: tagInput.split(',').map((t) => t.trim()).filter(Boolean) })}
            placeholder="auth, high-risk, external…"
          />
        </div>
        <div className="map-edge-actions">
          <button className="flows-btn-danger" onClick={remove}>Remove connection</button>
        </div>
      </div>
    </div>
  );
}

// ─── Step menu (connect, move, change feature, remove with branch) ─────

function StepMenu({ flow, step, numbers, onConnect, onMove, onRepoint, onRemoveBranch }: {
  flow: Flow;
  step: FlowStep;
  numbers: Map<string, number>;
  onConnect: (toStepId: string) => void;
  onMove: (place: StepPlace) => void;
  onRepoint: () => void;
  onRemoveBranch?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'connect' | 'after' | 'branch'>('menu');
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      setOpen(false); setView('menu');
      if (refocus) triggerRef.current?.focus({ preventScroll: true });
    };
    const onMouse = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, view]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  const run = (fn: () => void) => { setOpen(false); setView('menu'); fn(); };

  // Targets in reading order. Connecting skips steps already connected to; moving skips the
  // steps after this one on its own branch (they would be left behind) only for "after".
  const others = [...flow.steps].filter((s) => s.id !== step.id).sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0));
  const connected = new Set(flow.edges.filter((e) => e.fromStepId === step.id).map((e) => e.toStepId));
  const targets = view === 'connect' ? others.filter((s) => !connected.has(s.id)) : others;
  const label = (s: FlowStep) => `${numbers.get(s.id) ?? '?'}. ${s.featureTitle || s.featureId}`;
  const title = `step ${numbers.get(step.id) ?? ''}`;

  return (
    <div className="flow-card-menu-wrap flow-step-menu-wrap" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="flow-step-action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${title}`}
        title="Connect, move, change feature"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flow-step-action-glyph">⋯</span>
        <span className="flow-step-action-label">More</span>
      </button>
      {open && (
        <div className="flow-card-menu flow-step-menu" role="menu" aria-label={view === 'menu' ? `Actions for ${title}` : view === 'connect' ? 'Connect to' : 'Move to'} onKeyDown={onMenuKey}>
          {view === 'menu' ? (
            <>
              <button type="button" role="menuitem" onClick={() => setView('connect')}>Connect to another step…</button>
              <button type="button" role="menuitem" onClick={() => setView('after')}>Move after…</button>
              <button type="button" role="menuitem" onClick={() => setView('branch')}>Move to a branch of…</button>
              <button type="button" role="menuitem" onClick={() => run(() => onMove({ entry: true }))}>Make an entry point</button>
              <button type="button" role="menuitem" onClick={() => run(onRepoint)}>Change feature…</button>
              {onRemoveBranch && <button type="button" role="menuitem" className="danger" onClick={() => run(onRemoveBranch)}>Remove with the steps after it</button>}
            </>
          ) : targets.length === 0 ? (
            <span className="flow-card-menu-empty">No other steps to choose</span>
          ) : targets.map((s) => (
            <button key={s.id} type="button" role="menuitem" onClick={() => run(() => {
              if (view === 'connect') onConnect(s.id);
              else onMove(view === 'after' ? { after: s.id } : { from: s.id });
            })}>
              <span>{label(s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FlowDetailPage({ flowId, onBack, onOpenProject }: FlowDetailPageProps) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [folders, setFolders] = useState<FlowFolder[]>([]);
  const folderIndex = useFolderIndex(folders);
  useEffect(() => { listFolders().then(setFolders).catch(() => {}); }, []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  // The flow page is always editable: every change autosaves (see SaveIndicator), so there is
  // no edit mode to enter or leave.
  const editing = true;
  const [picker, setPicker] = useState<PickerContext | null>(null);
  const [activeTab, setActiveTab] = useState<'flow' | 'map' | 'findings' | 'baselines'>('flow');
  const [selectedMapStepId, setSelectedMapStepId] = useState<string | null>(null);
  // The selected connection ("fromId:toId"), on the map or the outline: its side panel shows.
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  // Steps whose branch blocks are currently expanded (collapsed by default).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Save state for the auto-save indicator.
  const [saving, setSaving] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [detailFindings, setDetailFindings] = useState<FlowFindings | null>(null);
  const [featureIndex, setFeatureIndex] = useState<Map<string, IndexedFeature>>(new Map());

  useEffect(() => {
    getFlow(flowId).then((f) => {
      setFlow(f);
      if (f) setExpanded(new Set(f.steps.map((s) => s.id)));
      // New flows with no steps default to edit mode.
    });
    listProjects().then(setProjects).catch((e) => { console.error('load projects:', e); setProjects([]); });
    listFlowFacets().then((f) => setTagSuggestions(f.tag.map((t) => t.value))).catch(() => {});
    listFlowFindingsAPI(flowId).then(setDetailFindings).catch(() => {});
  }, [flowId]);

  const refresh = useCallback(() => {
    getFlow(flowId).then((f) => {
      if (f) {
        setFlow(f);
        // Merge new step IDs into expanded without collapsing existing ones.
        setExpanded((prev) => new Set([...prev, ...f.steps.map((s) => s.id)]));
      }
    });
  }, [flowId]);

  // Wrap any mutation: bump the in-flight count while it runs, record a
  // timestamp on success. Drives the "Saving…" / "Saved" indicator.
  const withSave = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setSaving((s) => s + 1);
    try {
      const out = await fn();
      setSavedAt(Date.now());
      return out;
    } finally {
      setSaving((s) => s - 1);
    }
  }, []);

  // Index each referenced project's features (parameters + resolved links) so
  // step rows can show them. One fetch per project; refetched only when the set
  // of projects in the flow changes.
  const projectSig = useMemo(
    () => (flow ? [...new Set(flow.steps.map((s) => s.projectSlug))].sort().join(',') : ''),
    [flow],
  );
  useEffect(() => {
    if (!projectSig) { setFeatureIndex(new Map()); return; }
    let cancelled = false;
    const slugs = projectSig.split(',');
    Promise.all(slugs.map((slug) =>
      Promise.all([
        fetch(`/api/projects/${slug}/features`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        fetch(`/api/projects/${slug}/refs?entityType=feature`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      ]).then(([feats, refs]: [any[], any[]]) => ({ slug, feats, refs })),
    )).then((results) => {
      if (cancelled) return;
      const idx = new Map<string, IndexedFeature>();
      for (const { slug, feats, refs } of results) {
        const byId = new Map<string, any>(feats.map((f2) => [f2.id, f2]));
        const refsByEntity = new Map<string, StepFeatureRef[]>();
        for (const r of refs) {
          const list = refsByEntity.get(r.entityId) ?? [];
          list.push({ provider: r.provider, url: r.url, title: r.title });
          refsByEntity.set(r.entityId, list);
        }
        for (const f2 of feats) {
          idx.set(`${slug}:${f2.id}`, {
            parameters: f2.parameters ?? [],
            links: (f2.linkedFeatures ?? []).map((l: any) => {
              const t = byId.get(l.id);
              return { id: l.id, title: t?.title, kind: t?.kind, operation: t?.operation };
            }),
            refs: refsByEntity.get(f2.id) ?? [],
          });
        }
      }
      setFeatureIndex(idx);
    });
    return () => { cancelled = true; };
  }, [projectSig]);

  // Build a depth-first traversal number for each step ("step 1, 2, 3…").
  // Called unconditionally so hook order stays stable across renders.
  const stepNumbers = useMemo(() => {
    const map = new Map<string, number>();
    if (!flow) return map;
    let n = 1;
    const walk = (parentId: string | null) => {
      for (const c of childrenOf(flow.steps, parentId)) {
        map.set(c.id, n++);
        walk(c.id);
      }
    };
    walk(null);
    return map;
  }, [flow]);

  if (!flow) {
    // The page's frame (title, folder path, tabs, a few steps) while the flow loads.
    return (
      <div className="flow-detail-page">
        <div className="flow-detail-main" role="status" aria-label="Loading flow">
          <div className="flow-detail-toolbar">
            <div className="flow-detail-heading">
              <Skeleton height={28} width="35%" />
              <Skeleton height={13} width="18%" />
            </div>
          </div>
          <div className="flow-detail-tab-bar"><Skeleton height={20} width={300} style={{ margin: '10px 0 24px' }} /></div>
          <SkeletonRows rows={4} height={72} gap={16} lastWidth="100%" />
        </div>
      </div>
    );
  }
  const f = flow;

  const edgeBetween = (fromId: string, toId: string) =>
    f.edges.find((l) => l.fromStepId === fromId && l.toStepId === toId);

  async function handleAddFeature(ref: FeatureRef) {
    if (!picker) return;
    if (picker.repoint) {
      await withSave(() => updateStep(f.id, picker.repoint!, { projectSlug: ref.projectSlug, featureId: ref.id }));
    } else {
      const newStep = await withSave(() => addStep(f.id, ref, picker.place));
      // Expand the new step's branch so it's immediately visible.
      setExpanded((s) => new Set(s).add(newStep.id));
    }
    setPicker(null);
    refresh();
  }

  async function handleStatusChange(status: FlowStatus) {
    await withSave(() => updateFlow(f.id, { status }));
    refresh();
  }
  async function handleNameChange(name: string) {
    if (!name.trim()) return;
    await withSave(() => updateFlow(f.id, { name: name.trim() }));
    refresh();
  }
  async function handleDescriptionChange(description: string) {
    await withSave(() => updateFlow(f.id, { description }));
    refresh();
  }
  async function handleTagsChange(tags: string[]) {
    await withSave(() => updateFlow(f.id, { tags }));
    refresh();
  }
  async function handleOwnerChange(owner: string) {
    await withSave(() => updateFlow(f.id, { owner }));
    refresh();
  }

  function toggleExpanded(stepId: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }

  const selectedEdge = selectedEdgeKey ? f.edges.find((e) => edgeKey(e) === selectedEdgeKey) : undefined;
  const selFrom = selectedEdge && f.steps.find((st) => st.id === selectedEdge.fromStepId);
  const selTo = selectedEdge && f.steps.find((st) => st.id === selectedEdge.toStepId);
  const selectedEdgePanel = selectedEdge && selFrom && selTo ? (
    <MapEdgePanel
      edge={selectedEdge}
      fromStep={selFrom}
      toStep={selTo}
      flowId={f.id}
      onClose={() => setSelectedEdgeKey(null)}
      onRefresh={refresh}
      withSave={withSave}
    />
  ) : null;

  async function downloadExport() {
    const doc = await exportFlow(f.id);
    const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${f.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'flow'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <FeatureIndexContext.Provider value={featureIndex}>
    <div className={`flow-detail-page ${picker ? 'picker-open' : ''}`}>
      <div className={`flow-detail-main${activeTab === 'map' ? ' flow-detail-main--map' : ''}`}>
        <div className="flow-detail-toolbar">
          {/* Title first, then the folder path, as on the Flows list page; shown on every tab. */}
          <div className="flow-detail-heading">
            <div className="flow-detail-name-row">
              <EditableText
                value={f.name}
                onChange={handleNameChange}
                className="flow-detail-name"
                placeholder="Flow name"
              />
              {/* Bench's status control: tinted in the status's colour. */}
              <SelectDropdown<FlowStatus>
                appearance="tinted"
                label="Flow status"
                className="flow-detail-status"
                options={FLOW_STATUS_OPTIONS}
                value={f.status}
                onChange={handleStatusChange}
              />
            </div>
            <FolderPath folderId={f.folderId ?? ''} index={folderIndex} inItem onNavigate={(id) => onBack(id || undefined)} />
          </div>
          <div className="flow-detail-toolbar-right">
            <SaveIndicator saving={saving > 0} savedAt={savedAt} />
            <button type="button" className="baseline-action-btn baseline-action-btn-outline flow-export-btn" onClick={downloadExport} title="Download this flow as JSON (for flows import / set-steps)">Export</button>
            {/* The flow's outline, at the right edge of the header; the header grows to hold it,
                so the tab bar always sits below. */}
            {f.steps.length > 0 && (
              <div className="flow-detail-shape" aria-hidden="true">
                <FlowShape steps={f.steps} large />
              </div>
            )}
          </div>
        </div>

        {/* Bench's tab bar (tabs.css), as on Settings: underline inset under the active tab. */}
        <div className="tab-bar tab-bar--transparent flow-detail-tab-bar">
          <div className="tab-bar-tabs">
            {([['flow', 'Flow'], ['map', 'Map'], ['findings', 'Findings'], ['baselines', 'Baselines']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`tab-bar-tab${activeTab === id ? ' tab-bar-tab-active' : ''}`}
                aria-current={activeTab === id ? 'page' : undefined}
                onClick={() => setActiveTab(id)}
              >{label}</button>
            ))}
          </div>
        </div>

        {activeTab === 'map' ? (
          <div className="flow-map-wrap">
            <FlowGraphView
              steps={f.steps}
              edges={f.edges}
              selectedStepId={selectedMapStepId}
              onSelectStep={(id) => { setSelectedMapStepId(id); setSelectedEdgeKey(null); }}
              selectedEdgeKey={selectedEdgeKey}
              onSelectEdge={(key) => { setSelectedEdgeKey(key); setSelectedMapStepId(null); }}
            />
            {selectedMapStepId && (() => {
              const sel = f.steps.find((s) => s.id === selectedMapStepId);
              return sel ? (
                <MapStepPanel
                  step={sel}
                  flowId={f.id}
                  withSave={withSave}
                  onRefresh={refresh}
                  onClose={() => setSelectedMapStepId(null)}
                  onOpenProject={onOpenProject}
                />
              ) : null;
            })()}
            {selectedEdgePanel}
          </div>
        ) : activeTab === 'findings' ? (
          <FindingsPanel flowId={f.id} steps={f.steps} onClose={() => setActiveTab('flow')} onOpenProject={onOpenProject} inline />
        ) : activeTab === 'baselines' ? (
          <BaselinesPanel flowId={f.id} onClose={() => setActiveTab('flow')} inline />
        ) : (
          <>
            <div className="flow-detail-meta">
              <EditableText
                value={f.description}
                onChange={handleDescriptionChange}
                className="flow-detail-desc"
                placeholder="Describe what this flow represents…"
                multiline
              />
              <div className="flow-detail-attrs">
                <div className="flow-detail-attr">
                  <span className="flow-detail-attr-label">Tags</span>
                  <TagEditor tags={f.tags} onChange={handleTagsChange} readOnly={!editing} suggestions={tagSuggestions} />
                </div>
                <div className="flow-detail-attr">
                  <span className="flow-detail-attr-label">Owner</span>
                  <OwnerEditor value={f.owner} onChange={handleOwnerChange} readOnly={!editing} placeholder="unassigned" />
                </div>
              </div>
            </div>
            <div className="flow-detail-stats">
              <div className="flow-detail-stat">
                <span className="flow-detail-stat-num">{new Set(f.steps.map((s) => s.projectSlug)).size}</span>
                <span className="flow-detail-stat-label">Projects</span>
              </div>
              <div className="flow-detail-stat">
                <span className="flow-detail-stat-num">{f.steps.length}</span>
                <span className="flow-detail-stat-label">Steps</span>
              </div>
              <div className="flow-detail-stat">
                <span className="flow-detail-stat-num">{f.edges.length}</span>
                <span className="flow-detail-stat-label">Connections</span>
              </div>
              <div className="flow-detail-stat">
                <span className="flow-detail-stat-num">{detailFindings?.total ?? 0}</span>
                <span className="flow-detail-stat-label">Open findings</span>
              </div>
            </div>

            {f.steps.length === 0 ? (
              <div className="flow-empty-stepper">
                <p className="flow-empty-primer">Start with the first externally-reachable interface in this path — the entry point where a request or event enters the system.</p>
                <button
                  className="baseline-action-btn baseline-action-btn-primary"
                  onClick={() => setPicker({ place: {} })}
                >
                  + Add first step
                </button>
              </div>
            ) : (
              <Subtree
                flow={f}
                parentStepId={null}
                depth={0}
                editing={editing}
                expanded={expanded}
                stepNumbers={stepNumbers}
                edgeBetween={edgeBetween}
                selectedEdgeKey={selectedEdgeKey}
                onSelectEdge={setSelectedEdgeKey}
                onToggleExpand={toggleExpanded}
                onOpenPicker={(ctx) => setPicker(ctx)}
                onOpenProject={onOpenProject}
                onRefresh={refresh}
                withSave={withSave}
              />
            )}
          </>
        )}
      </div>

      {activeTab === 'flow' && selectedEdgePanel}
      {picker && (
        <FeaturePicker
          projects={projects}
          context={picker}
          onPick={handleAddFeature}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
    </FeatureIndexContext.Provider>
  );
}

// ─── Subtree: recursive renderer ────────────────────────────────────────
//
// Renders the flow's outline (flowOutline.ts): a single child continues the path inline; two
// or more are branches, each announced by a connector carrying its edge's condition. Edges
// the outline doesn't follow (joins into a step shown earlier, loops back) are listed under
// the step they leave.

interface SubtreeProps {
  flow: Flow;
  parentStepId: string | null;
  depth: number;
  editing: boolean;
  expanded: Set<string>;
  stepNumbers: Map<string, number>;
  edgeBetween: (fromId: string, toId: string) => FlowEdge | undefined;
  selectedEdgeKey: string | null;
  onSelectEdge: (key: string | null) => void;
  onToggleExpand: (stepId: string) => void;
  onOpenPicker: (ctx: PickerContext) => void;
  onOpenProject: (slug: string, hash?: string) => void;
  onRefresh: () => void;
  withSave: <T>(fn: () => Promise<T>) => Promise<T>;
}

function Subtree(props: SubtreeProps) {
  const { flow, parentStepId, editing } = props;
  const children = childrenOf(flow.steps, parentStepId);

  if (children.length === 0) {
    // Terminal — show a "+ Continue this path" affordance attached to the
    // ancestor step. The parent step renders this itself; nothing to do here.
    return null;
  }

  // Linear continuation: single child, render inline as the next spine row.
  if (children.length === 1) {
    const c = children[0];
    return (
      <StepNode
        {...props}
        step={c}
      />
    );
  }

  // Branching: each child is announced by a connector arrow + condition
  // label, with its subtree indented underneath. No card — just an arrow
  // glyph in the gutter so any depth of nesting stays legible. At the top level the
  // "branches" are the flow's entry points.
  return (
    <div className="flow-branch-group">
      {children.map((c) => {
        const collapsed = !props.expanded.has(c.id);
        const count = 1 + countDescendants(flow.steps, c.id);
        const edge = parentStepId ? props.edgeBetween(parentStepId, c.id) : undefined;
        return (
          <div key={c.id} className="flow-branch-wrap">
            <BranchConnector
              step={c}
              flow={flow}
              edge={edge}
              editing={editing}
              collapsed={collapsed}
              stepCount={count}
              onToggle={() => props.onToggleExpand(c.id)}
              onSelectEdge={props.onSelectEdge}
              withSave={props.withSave}
              onRefresh={props.onRefresh}
            />
            {!collapsed && (
              <div className="flow-branch-content">
                <StepNode {...props} step={c} />
              </div>
            )}
          </div>
        );
      })}
      {editing && (
        <button
          className="flow-add-branch"
          onClick={() => props.onOpenPicker({ place: parentStepId ? { from: parentStepId } : { entry: true } })}
        >
          {parentStepId ? '⤵ add branch' : '⤵ add entry point'}
        </button>
      )}
    </div>
  );
}

function countDescendants(steps: FlowStep[], stepId: string): number {
  let n = 0;
  const walk = (id: string) => {
    for (const c of childrenOf(steps, id)) {
      n++;
      walk(c.id);
    }
  };
  walk(stepId);
  return n;
}

// ─── A single node + its outgoing edge + its subtree ───────────────────

interface StepNodeProps extends SubtreeProps {
  step: FlowStep;
}

function StepNode(props: StepNodeProps) {
  const { flow, step, editing, stepNumbers, edgeBetween, onOpenPicker, onOpenProject, onRefresh, onSelectEdge } = props;
  const childs = childrenOf(flow.steps, step.id);
  const isTerminal = childs.length === 0;
  // For a single-child continuation we render the edge between them.
  const next = childs.length === 1 ? childs[0] : null;
  const edge = next ? edgeBetween(step.id, next.id) : undefined;
  const extra = flow.extraEdges.filter((e) => e.fromStepId === step.id);
  const num = stepNumbers.get(step.id) ?? 0;
  const { dismissed, dismiss } = useWarningDismiss(flow.id, step.id);
  const warnings = useMemo(
    () => stepWarnings(flow, step).filter((w) => !dismissed.has(w.type)),
    [flow, step, dismissed],
  );
  const hasAfter = flow.edges.some((e) => e.fromStepId === step.id);
  const save = async (fn: () => Promise<unknown>) => { await props.withSave(fn); onRefresh(); };

  return (
    <div className="flow-node">
      <StepRow
        step={step}
        number={num}
        editing={editing}
        terminal={isTerminal}
        warnings={warnings}
        onDismissWarning={dismiss}
        onNoteChange={(note) => save(() => updateStep(flow.id, step.id, { note }))}
        onActorChange={(actor) => save(() => updateStep(flow.id, step.id, { actor }))}
        onControlsChange={(controls) => save(() => updateStep(flow.id, step.id, { controls }))}
        onRemove={() => save(() => removeStep(flow.id, step.id))}
        onMoveUp={() => save(() => moveStep(flow.id, step.id, -1))}
        onMoveDown={() => save(() => moveStep(flow.id, step.id, 1))}
        onJumpToProject={() => onOpenProject(step.projectSlug, `#/feature/${step.featureId}`)}
        onBranchFromHere={() => onOpenPicker({ place: { from: step.id } })}
        onContinue={() => onOpenPicker({ place: { after: step.id } })}
        onOpenProject={onOpenProject}
        menu={editing ? (
          <StepMenu
            flow={flow}
            step={step}
            numbers={stepNumbers}
            onConnect={(to) => save(() => setEdge(flow.id, step.id, to, {}))}
            onMove={(place) => save(() => moveStepTo(flow.id, step.id, place))}
            onRepoint={() => onOpenPicker({ place: {}, repoint: step.id })}
            onRemoveBranch={hasAfter && reachableFrom(flow.edges, step.id).size > 0 ? () => save(() => removeStep(flow.id, step.id, 'subtree')) : undefined}
          />
        ) : null}
      />
      {extra.map((e) => {
        const to = flow.steps.find((st) => st.id === e.toStepId);
        if (!to) return null;
        const n = stepNumbers.get(to.id) ?? 0;
        const loop = n <= num;
        return (
          <div key={edgeKey(e)} className="flow-extra-edge">
            <span className="flow-extra-edge-glyph" aria-hidden>{loop ? '↺' : '↪'}</span>
            <button type="button" className="flow-extra-edge-target" onClick={() => onSelectEdge(edgeKey(e))} title="Connection details">
              {loop ? 'loops back to' : 'also leads to'} step {n}: {to.featureTitle || to.featureId}
              {(e.condition || e.description) && <span className="flow-extra-edge-label"> — {e.condition || e.description}</span>}
            </button>
            <EdgeChips edge={e} />
            {editing && (
              <button type="button" className="flow-step-action flow-step-action-danger" onClick={() => save(() => deleteEdge(flow.id, e.fromStepId, e.toStepId))} aria-label={`Remove the connection to step ${n}`} title="Remove this connection">×</button>
            )}
          </div>
        );
      })}
      {next && edge && (
        <EdgeRow
          edge={edge}
          editing={editing}
          selected={props.selectedEdgeKey === edgeKey(edge)}
          onChange={(description) => save(() => setEdge(flow.id, step.id, next.id, { description }))}
          onDetails={() => onSelectEdge(edgeKey(edge))}
          onInsert={() => onOpenPicker({ place: { after: step.id } })}
        />
      )}
      {/* Recurse: render subtree (either the linear continuation, or branches) */}
      <Subtree {...props} parentStepId={step.id} depth={props.depth + 1} />
    </div>
  );
}

// ─── Branch connector (the ↳ arrow that announces a labeled branch) ────
//
// A single row in the same gutter+content grid as steps and edges, so the arrow lines up
// with step numbers and ↓ glyphs. Its label is the condition on the edge into the branch.
// The subtree is rendered separately and indented by the caller.

interface BranchConnectorProps {
  step: FlowStep;
  flow: Flow;
  /** The edge into the branch (absent for an entry point). */
  edge?: FlowEdge;
  editing: boolean;
  collapsed: boolean;
  stepCount: number;
  onToggle: () => void;
  onSelectEdge: (key: string | null) => void;
  withSave: <T>(fn: () => Promise<T>) => Promise<T>;
  onRefresh: () => void;
}

function BranchConnector({ step, edge, editing, collapsed, stepCount, onToggle, onSelectEdge, flow, withSave, onRefresh }: BranchConnectorProps) {
  const [editingCondition, setEditingCondition] = useState(false);
  const [draftCondition, setDraftCondition] = useState(step.branchCondition ?? '');

  useEffect(() => {
    setDraftCondition(step.branchCondition ?? '');
  }, [step.branchCondition]);

  async function commitCondition() {
    setEditingCondition(false);
    if (edge && draftCondition !== (step.branchCondition ?? '')) {
      await withSave(() => setEdge(flow.id, edge.fromStepId, edge.toStepId, { condition: draftCondition }));
      onRefresh();
    }
  }

  return (
    <div className="flow-branch-connector">
      <div className="flow-branch-arrow" aria-hidden>↳</div>
      <div className="flow-branch-label">
        {!edge ? (
          <span className="flow-branch-condition flow-branch-entry">entry point</span>
        ) : editingCondition ? (
          <input
            autoFocus
            className="flow-branch-condition-input"
            value={draftCondition}
            onChange={(e) => setDraftCondition(e.target.value)}
            onBlur={commitCondition}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitCondition(); }
              if (e.key === 'Escape') {
                setDraftCondition(step.branchCondition ?? '');
                setEditingCondition(false);
              }
            }}
            placeholder="branch condition"
          />
        ) : (
          <button
            type="button"
            className={`flow-branch-condition ${step.branchCondition ? '' : 'flow-branch-condition-empty'}`}
            onClick={editing ? () => setEditingCondition(true) : undefined}
            disabled={!editing}
          >
            {step.branchCondition
              ? <InlineText text={step.branchCondition} />
              : (editing ? 'untitled branch — click to label' : 'untitled branch')}
          </button>
        )}
        {edge && <EdgeChips edge={edge} />}
        {edge && (
          <button type="button" className="flow-edge-details" onClick={() => onSelectEdge(edgeKey(edge))} title="Connection details">details</button>
        )}
        <button
          type="button"
          className="flow-branch-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand branch' : 'Collapse branch'}
        >
          <span className="flow-branch-chevron">{collapsed ? '▸' : '▾'}</span>
          <span className="flow-branch-count">{stepCount} step{stepCount === 1 ? '' : 's'}</span>
        </button>
      </div>
    </div>
  );
}

// ─── Step warnings ──────────────────────────────────────────────────────

type StepWarning = { type: string; message: string };

function stepWarnings(flow: Flow, step: FlowStep): StepWarning[] {
  const warnings: StepWarning[] = [];
  const parent = step.parentStepId ? flow.steps.find((s) => s.id === step.parentStepId) : null;
  const parentChildren = parent ? flow.steps.filter((s) => s.parentStepId === parent.id) : [];

  // 1. Untitled branch: parent has 2+ children and this step has no branchCondition.
  if (parentChildren.length >= 2 && !step.branchCondition) {
    warnings.push({ type: 'untitled-branch', message: 'Branch has no label — add a condition to distinguish this path.' });
  }

  // 2. Cross-project hop: every edge in from a step on another project should say what the
  // hop is (its kind), unless one end is a dependency or sink.
  for (const e of flow.edges.filter((ed) => ed.toStepId === step.id)) {
    const from = flow.steps.find((s) => s.id === e.fromStepId);
    if (from && from.projectSlug !== step.projectSlug && e.kind === 'next' &&
        step.featureKind !== 'dependency' && from.featureKind !== 'dependency' &&
        step.featureKind !== 'sink' && from.featureKind !== 'sink') {
      warnings.push({ type: 'cross-project-hop', message: `Crosses from ${from.projectSlug} to ${step.projectSlug} without saying how (set the connection's kind: call, async, …).` });
      break;
    }
  }

  // 3. Orphaned anchor in an active flow.
  if ((step.confidence === 'orphaned' || step.tombstoned) && flow.status === 'active') {
    warnings.push({ type: 'orphaned-anchor', message: 'Feature anchor is orphaned — the code it was pinned to no longer exists.' });
  }

  return warnings;
}

function dismissKey(flowId: string, stepId: string, warningType: string) {
  return `flow-warn:${flowId}:${stepId}:${warningType}`;
}

function useWarningDismiss(flowId: string, stepId: string) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(`flow-warn:${flowId}:${stepId}:`));
    return new Set(keys.map((k) => k.split(':')[3]));
  });
  const dismiss = useCallback((type: string) => {
    localStorage.setItem(dismissKey(flowId, stepId, type), '1');
    setDismissed((s) => new Set(s).add(type));
  }, [flowId, stepId]);
  return { dismissed, dismiss };
}

// ─── Stepper row ────────────────────────────────────────────────────────

interface StepRowProps {
  step: FlowStep;
  number: number;
  editing: boolean;
  terminal: boolean;
  warnings: StepWarning[];
  onDismissWarning: (type: string) => void;
  onNoteChange: (note: string) => void;
  onActorChange: (actor: string) => void;
  onControlsChange: (controls: string[]) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onJumpToProject: () => void;
  onBranchFromHere: () => void;
  onContinue: () => void;
  onOpenProject: (slug: string, hash?: string) => void;
  menu: React.ReactNode;
}

function StepRow({
  step, number, editing, terminal, warnings, onDismissWarning,
  onNoteChange, onActorChange, onControlsChange, onRemove, onMoveUp, onMoveDown,
  onJumpToProject, onBranchFromHere, onContinue, onOpenProject, menu,
}: StepRowProps) {
  const featureIndex = useContext(FeatureIndexContext);
  const detail = featureIndex.get(`${step.projectSlug}:${step.featureId}`);
  return (
    <>
    <div className="flow-step">
      <div className="flow-step-pos">{number}</div>
      <div className="flow-step-body">
        <div className="flow-step-header">
          <span className="flow-step-project">{step.projectName || step.projectSlug}</span>
          {(!step.tombstoned || step.featureTitle) && (
            <span className={`flow-step-kind ${KIND_COLORS[step.featureKind]}`}>
              {KIND_ICONS[step.featureKind]} {step.featureKind}
            </span>
          )}
          {step.featureOperation && (
            <span className="flow-step-op">{step.featureOperation}</span>
          )}
          {step.tombstoned
            ? <span className="flow-step-title flow-step-title-tombstoned"><s>{step.featureTitle || '(deleted feature)'}</s></span>
            : <span className="flow-step-title">{step.featureTitle}</span>
          }
          {!step.tombstoned && (
            <button
              className="flow-step-title-link"
              onClick={onJumpToProject}
              title={`Open ${step.featureTitle} in the workbench`}
              aria-label={`Open ${step.featureTitle} in the workbench`}
            >↗</button>
          )}
          {step.confidence === 'moved' && (
            <span className="flow-anchor-chip flow-anchor-moved" title="Feature anchor moved since last review">MOVED</span>
          )}
          {(step.confidence === 'orphaned' || (step.tombstoned && step.featureTitle)) && (
            <span className="flow-anchor-chip flow-anchor-orphaned" title="Feature anchor could not be located at HEAD">ORPHANED</span>
          )}
          {step.tombstoned && !step.featureTitle && (
            <span className="flow-anchor-chip flow-anchor-tombstoned" title="Feature was deleted from the project">DELETED</span>
          )}
          {terminal && <span className="flow-step-terminal">end</span>}
          {warnings.map((w) => (
            <span key={w.type} className="flow-step-warning" title={w.message}>
              ⚠
              <button
                className="flow-step-warning-dismiss"
                onClick={() => onDismissWarning(w.type)}
                title="Dismiss"
              >×</button>
            </span>
          ))}
          <div className="flow-step-actions">
            {editing && (
              <>
                <button className="flow-step-action" onClick={onBranchFromHere} title="Branch from here">
                  <span className="flow-step-action-glyph">⤵</span>
                  <span className="flow-step-action-label">Branch</span>
                </button>
                <button className="flow-step-action" onClick={onMoveUp} title="Move up (along the path, or among sibling branches)">
                  <span className="flow-step-action-glyph">↑</span>
                  <span className="flow-step-action-label">Up</span>
                </button>
                <button className="flow-step-action" onClick={onMoveDown} title="Move down (along the path, or among sibling branches)">
                  <span className="flow-step-action-glyph">↓</span>
                  <span className="flow-step-action-label">Down</span>
                </button>
                {menu}
                <button className="flow-step-action flow-step-action-danger" onClick={onRemove} title="Remove step (the steps around it are joined up)">
                  <span className="flow-step-action-glyph">×</span>
                  <span className="flow-step-action-label">Remove</span>
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flow-step-who">
          <span className="flow-step-who-label">Actor</span>
          <EditableText
            value={step.actor}
            onChange={onActorChange}
            className="flow-step-actor"
            placeholder={editing ? 'who acts here…' : '—'}
            readOnly={!editing}
          />
          <span className="flow-step-who-label">Controls</span>
          <TagEditor tags={step.controls} onChange={onControlsChange} readOnly={!editing} placeholder="authn, authz…" />
        </div>
        <EditableText
          value={step.note}
          onChange={onNoteChange}
          className="flow-step-note"
          placeholder={editing ? 'Note for this step…' : ''}
          multiline
          readOnly={!editing}
        />
        {!step.tombstoned && detail && (detail.parameters.length > 0 || detail.links.length > 0 || detail.refs.length > 0) && (
          <div className="flow-step-details">
            {detail.parameters.length > 0 && (
              <div className="flow-step-detail-group">
                <span className="flow-step-detail-label">Parameters</span>
                <div className="flow-step-param-list">
                  {detail.parameters.map((p) => {
                    const tc = p.type ? (PARAM_TYPE_COLORS[p.type] ?? 'var(--text-muted)') : 'var(--text-muted)';
                    return (
                      <span key={p.id} className="flow-step-param">
                        <span className="flow-step-param-name">{p.name}</span>
                        <span className="flow-step-param-cell">
                          {p.type && (
                            <span
                              className="flow-step-param-type"
                              style={{ color: tc, borderColor: `color-mix(in srgb, ${tc} 30%, transparent)`, background: `color-mix(in srgb, ${tc} 10%, transparent)` }}
                            >{p.type}</span>
                          )}
                        </span>
                        <span className="flow-step-param-cell">
                          {p.required && <span className="flow-step-param-req">required</span>}
                        </span>
                        {p.description && <span className="flow-step-param-desc">{p.description}</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {(detail.links.length > 0 || detail.refs.length > 0) && (
              <div className="flow-step-detail-group">
                <span className="flow-step-detail-label">Links</span>
                <div className="flow-step-chips">
                  {detail.refs.map((r, i) => (
                    <a
                      key={`ref-${i}`}
                      className="flow-step-ref"
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      title={r.title || r.url}
                    >
                      <RefProviderIcon provider={r.provider} size={12} />
                      <span className="flow-step-link-title">{r.title || r.url}</span>
                    </a>
                  ))}
                  {detail.links.map((l) => (
                    <button
                      key={l.id}
                      className="flow-step-link flow-step-link-btn"
                      onClick={() => onOpenProject(step.projectSlug, `#/feature/${l.id}`)}
                      title="Open linked feature"
                    >
                      {l.kind && (
                        <span className={`flow-step-kind ${KIND_COLORS[l.kind]}`}>{KIND_ICONS[l.kind]} {l.kind}</span>
                      )}
                      <span className="flow-step-link-title">{l.title || l.id.slice(0, 8)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    {editing && terminal && (
      <button className="flow-step-continue" onClick={onContinue}>
        + continue this path
      </button>
    )}
    </>
  );
}

// ─── Edge row (the hop between two steps of a path) ────────────────────

interface EdgeRowProps {
  edge: FlowEdge;
  editing: boolean;
  selected: boolean;
  onChange: (s: string) => void;
  onDetails: () => void;
  onInsert: () => void;
}

function EdgeRow({ edge, editing, selected, onChange, onDetails, onInsert }: EdgeRowProps) {
  return (
    <div className={`flow-edge${selected ? ' flow-edge--selected' : ''}`}>
      <div className="flow-edge-line">↓</div>
      <div className="flow-edge-main">
        {edge.condition && <span className="flow-edge-condition"><InlineText text={edge.condition} /></span>}
        <EdgeChips edge={edge} />
        <EditableText
          value={edge.description}
          onChange={onChange}
          className="flow-edge-text"
          placeholder={editing ? 'How data moves between these steps…' : ''}
          readOnly={!editing}
        />
        <span className="flow-edge-tools">
          <button type="button" className="flow-edge-details" onClick={onDetails} title="Connection details: kind, protocol, identity, trust boundary, data">details</button>
          {editing && <button type="button" className="flow-edge-insert" onClick={onInsert} title="Insert a step here">+ insert step</button>}
        </span>
      </div>
    </div>
  );
}

// ─── Editable text helper ──────────────────────────────────────────────

// ─── Feature picker (side panel) ───────────────────────────────────────

interface FeaturePickerProps {
  projects: Project[];
  context: PickerContext;
  onPick: (ref: FeatureRef) => void;
  onClose: () => void;
}

function FeaturePicker({ projects, context, onPick, onClose }: FeaturePickerProps) {
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [kindFilter, setKindFilter] = useState<FeatureKind | ''>('');
  const [results, setResults] = useState<FeatureRef[]>([]);
  const [loading, setLoading] = useState(false);
  const isBranch = context.place.from !== undefined;
  const title = context.repoint ? 'Change feature' : isBranch ? 'Branch from step' : context.place.entry ? 'Add entry point'
    : context.place.after || context.place.before ? 'Insert step' : 'Add step';
  // Remember what opened the panel (read during the first render, before the
  // search box autofocuses) and give focus back when it closes.
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = opener.current;
    return () => { if (el && el !== document.body && el.isConnected) el.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchFeatures(projects, query, kindFilter || undefined, projectFilter || undefined)
        .then((r) => { if (!cancelled) setResults(r); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [projects, query, projectFilter, kindFilter]);

  return (
    <aside
      className="flow-picker"
      aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="flow-picker-header">
        <div>
          <div className="flow-picker-title">{title}</div>
          <div className="flow-picker-subtitle">
            {context.repoint
              ? 'The step keeps its place and connections; only the feature changes.'
              : isBranch
                ? 'Choose the first feature for this branch. You can label the branch after.'
                : context.place.entry
                  ? 'Another way into this flow, not connected to the others yet.'
                  : context.place.after || context.place.before
                    ? 'Goes between this step and the next; the path continues after it.'
                    : 'Continues the current path.'}
          </div>
        </div>
        <button className="flow-picker-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <input
        autoFocus
        className="finding-edit-input flow-picker-search"
        placeholder="Search features (title, path, tag)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="flow-picker-filters">
        <SelectDropdown<string>
          label="Project"
          options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.slug, label: p.name }))]}
          value={projectFilter}
          onChange={setProjectFilter}
        />
        <SelectDropdown<FeatureKind | ''>
          label="Feature kind"
          options={[{ value: '', label: 'All kinds' }, ...(['interface', 'source', 'sink', 'dependency', 'externality'] as const).map((k) => ({ value: k, label: k }))]}
          value={kindFilter}
          onChange={setKindFilter}
        />
      </div>
      <div className="flow-picker-results">
        {loading && <div className="flow-picker-empty">Searching…</div>}
        {!loading && results.length === 0 && (
          <div className="flow-picker-empty">
            {query || projectFilter || kindFilter ? (
              <>
                <span>No features match</span>
                {query && <span className="flow-picker-empty-filter"> "{query}"</span>}
                {projectFilter && <span className="flow-picker-empty-filter"> in {projectFilter}</span>}
                {kindFilter && <span className="flow-picker-empty-filter"> kind:{kindFilter}</span>}
                <span>.</span>
                {(projectFilter || kindFilter) && (
                  <button
                    className="flow-picker-empty-clear"
                    onClick={() => { setProjectFilter(''); setKindFilter(''); }}
                  >
                    Clear filters
                  </button>
                )}
              </>
            ) : (
              'No features found. Add features to a project in the workbench first.'
            )}
          </div>
        )}
        {!loading && results.map((r) => (
          <button key={`${r.projectSlug}:${r.id}`} className="flow-picker-result" onClick={() => onPick(r)}>
            <div className="flow-picker-result-top">
              <span className="flow-picker-result-project">{r.projectName}</span>
              <span className={`flow-step-kind ${KIND_COLORS[r.kind]}`}>
                {KIND_ICONS[r.kind]} {r.kind}
              </span>
              {r.operation && <span className="flow-step-op">{r.operation}</span>}
            </div>
            <div className="flow-picker-result-title">{r.title}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}
