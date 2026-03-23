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
