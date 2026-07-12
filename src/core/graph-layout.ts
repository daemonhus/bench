import type { GraphCommit } from './types';

export interface GraphNode {
  commit: GraphCommit;
  lane: number;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  maxLanes: number;
}

/**
 * Assigns each commit to a lane (column) and computes edges between rows.
 * Input must be topologically ordered (children before parents).
 */
export function computeGraphLayout(commits: GraphCommit[]): GraphLayout {
  if (commits.length === 0) {
    return { nodes: [], edges: [], maxLanes: 0 };
  }

  // Map from commit hash → row index
  const hashToRow = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    hashToRow.set(commits[i].hash, i);
  }

  // Active lanes: each entry is the hash we're waiting to see (following a parent)
  // null means the lane is free
  const lanes: (string | null)[] = [];
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let maxLanes = 0;

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];

    // Find which lane(s) are expecting this commit
    const matchingLanes: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) {
        matchingLanes.push(i);
      }
    }

    let assignedLane: number;

    if (matchingLanes.length > 0) {
      // Place in the leftmost matching lane
      assignedLane = matchingLanes[0];
      // Free up any additional lanes that were also tracking this commit (merge target)
      for (let i = 1; i < matchingLanes.length; i++) {
        lanes[matchingLanes[i]] = null;
      }
    } else {
      // No lane expects this commit — it's a branch head. Find a free lane or add new one.
      const freeLane = lanes.indexOf(null);
      if (freeLane >= 0) {
        assignedLane = freeLane;
      } else {
        assignedLane = lanes.length;
        lanes.push(null);
      }
    }

    nodes.push({ commit, lane: assignedLane });

    // Assign parents to lanes (guard null from JSON)
    const parents = commit.parents ?? [];
    for (let p = 0; p < parents.length; p++) {
      const parentHash = parents[p];
      const parentRow = hashToRow.get(parentHash);

      if (p === 0) {
        // First parent continues this commit's lane
        lanes[assignedLane] = parentHash;
        if (parentRow !== undefined) {
          edges.push({ fromRow: row, fromLane: assignedLane, toRow: parentRow, toLane: assignedLane });
        }
      } else {
        // Additional parents (merge sources) — find free lane or open new one
        // But first check if parent is already tracked by another lane
        const existingLane = lanes.indexOf(parentHash);
        if (existingLane >= 0 && parentRow !== undefined) {
          // Parent already tracked — just draw edge to that lane
          edges.push({ fromRow: row, fromLane: assignedLane, toRow: parentRow, toLane: existingLane });
        } else {
          // Open new lane for this parent
          const freeLane = lanes.indexOf(null);
          let newLane: number;
          if (freeLane >= 0) {
            newLane = freeLane;
          } else {
            newLane = lanes.length;
            lanes.push(null);
          }
          lanes[newLane] = parentHash;
          if (parentRow !== undefined) {
            edges.push({ fromRow: row, fromLane: assignedLane, toRow: parentRow, toLane: newLane });
          }
        }
      }
    }

    // If no parents, free the lane (root commit)
    if (parents.length === 0) {
      lanes[assignedLane] = null;
    }

    maxLanes = Math.max(maxLanes, lanes.length);
  }

  // Ensure maxLanes is at least 1 if we have commits
  if (maxLanes === 0 && commits.length > 0) maxLanes = 1;

  return { nodes, edges, maxLanes };
}

// ---------------------------------------------------------------------------
// Shared rendering geometry for the commit graph (used by GitTreePanel and
// the Overview page so the graph looks identical everywhere).
// ---------------------------------------------------------------------------

export const LANE_WIDTH = 20;
export const ROW_HEIGHT = 32;
export const NODE_RADIUS = 5;

const LANE_COLORS = [
  '#58a6ff', // blue
  '#3fb950', // green
  '#bc8cff', // purple
  '#f0883e', // orange
  '#f778ba', // pink
  '#79c0ff', // light blue
  '#d29922', // gold
  '#ff7b72', // red
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

export function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

export function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export function edgePath(
  fromRow: number,
  fromLane: number,
  toRow: number,
  toLane: number,
): string {
  const x1 = laneX(fromLane);
  const y1 = rowY(fromRow) + NODE_RADIUS;
  const x2 = laneX(toLane);
  const y2 = rowY(toRow) - NODE_RADIUS;

  // Same lane: straight line
  if (fromLane === toLane) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // Cross-lane: quick S-curve near the source, then straight down to target
  const dy = y2 - y1;
  const curveH = Math.min(ROW_HEIGHT * 1.2, dy);

  if (dy <= ROW_HEIGHT * 1.2) {
    // Short span — single smooth S-curve
    return `M ${x1} ${y1} C ${x1} ${y1 + dy * 0.4}, ${x2} ${y2 - dy * 0.4}, ${x2} ${y2}`;
  }

  // Long span — S-curve transition near source, then straight to target
  return (
    `M ${x1} ${y1} ` +
    `C ${x1} ${y1 + curveH * 0.5}, ${x2} ${y1 + curveH * 0.5}, ${x2} ${y1 + curveH} ` +
    `L ${x2} ${y2}`
  );
}

// ---------------------------------------------------------------------------
// Branch attribution. Git only stores refs at branch tips, so most commits
// have no refs. Infer the branch each commit was made on by:
//   1. seeding tip commits with their ref names,
//   2. propagating each commit's branch to its first parent (the chain the
//      commit was made on), and
//   3. naming the second-parent side of a merge from the merge subject
//      ("Merge branch 'x'", "Merge pull request #N from owner/x").
// Input must be topologically ordered (children before parents), as with
// computeGraphLayout. Heuristic: rewritten subjects or shallow history leave
// commits unattributed rather than guessed.
// ---------------------------------------------------------------------------

/** Extract the merged (second-parent side) branch name from a merge subject. */
export function parseMergedBranch(subject: string): string | null {
  let m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (m) return m[1].replace(/^origin\//, '');
  m = subject.match(/^Merge pull request #\d+ from (\S+)/);
  if (m) {
    const ref = m[1];
    const idx = ref.indexOf('/');
    return idx >= 0 ? ref.slice(idx + 1) : ref;
  }
  return null;
}

/** Extract the receiving branch from a "… into y" merge subject. */
function parseMergeTarget(subject: string): string | null {
  const m = subject.match(/ into '?([^\s']+)'?$/);
  return m ? m[1] : null;
}

export function attributeBranches(commits: GraphCommit[]): Map<string, string> {
  const branchOf = new Map<string, string>();
  const tipName = (c: GraphCommit): string | null => {
    for (const r of c.refs ?? []) {
      const name = r.replace(/^HEAD -> /, '');
      if (name) return name;
    }
    return null;
  };

  for (const c of commits) {
    let name = branchOf.get(c.hash) ?? tipName(c);
    const parents = c.parents ?? [];
    const isMerge = parents.length > 1;

    // A merge subject can name the branch the merge itself landed on.
    if (!name && isMerge) {
      name = parseMergeTarget(c.subject);
    }
    if (name && !branchOf.has(c.hash)) branchOf.set(c.hash, name);

    // The first parent is the chain this commit was made on.
    if (name && parents.length > 0 && !branchOf.has(parents[0])) {
      branchOf.set(parents[0], name);
    }
    // The second-parent side of a merge carries the merged branch's name.
    if (isMerge) {
      const merged = parseMergedBranch(c.subject);
      if (merged && !branchOf.has(parents[1])) {
        branchOf.set(parents[1], merged);
      }
    }
  }
  return branchOf;
}
