import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { gitApi } from '../core/api';
import { computeGraphLayout } from '../core/graph-layout';
import type { GraphCommit, ReconciledHead } from '../core/types';

const LANE_WIDTH = 20;
const ROW_HEIGHT = 32;
const NODE_RADIUS = 5;

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

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function edgePath(
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

interface GitTreePanelProps {
  isOpen: boolean;
  currentCommit: string | null;
  compareFrom: string;
  compareTo: string;
  viewMode: 'browse' | 'diff';
  diffSelectTarget: 'from' | 'to' | null;
  reconciledHead?: ReconciledHead | null;
  onSelectCommit: (hash: string) => void;
  onSelectDiffCommit: (hash: string, which: 'from' | 'to') => void;
  onClose: () => void;
}

export const GitTreePanel: React.FC<GitTreePanelProps> = ({
  isOpen,
  currentCommit,
  compareFrom,
  compareTo,
  viewMode,
  diffSelectTarget,
  reconciledHead,
  onSelectCommit,
  onSelectDiffCommit,
  onClose,
}) => {
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [panelHeight, setPanelHeight] = useState(300);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const panelTop = panelRef.current?.getBoundingClientRect().top ?? 0;
    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const newHeight = Math.max(100, Math.min(window.innerHeight * 0.8, ev.clientY - panelTop));
      setPanelHeight(newHeight);
    };
    const onMouseUp = () => {
      resizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    gitApi.listGraph(limit).then((data) => {
      setCommits(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [isOpen, limit]);

  const layout = useMemo(() => computeGraphLayout(commits), [commits]);

  // Compute allowed hashes for the current selection target
  const allowedHashes = useMemo(() => {
    if (!diffSelectTarget || commits.length === 0) return null;
    const parentMap = new Map<string, string[]>();
    const childMap = new Map<string, string[]>();
    for (const c of commits) {
      parentMap.set(c.hash, c.parents ?? []);
      for (const p of c.parents ?? []) {
        const existing = childMap.get(p) ?? [];
        existing.push(c.hash);
        childMap.set(p, existing);
      }
    }

    if (diffSelectTarget === 'from' && compareTo) {
      // Only allow ancestors of "to" (older commits)
      const ancestors = new Set<string>();
      const work = [...(parentMap.get(compareTo) ?? [])];
      while (work.length > 0) {
        const hash = work.pop()!;
        if (ancestors.has(hash)) continue;
        ancestors.add(hash);
        const parents = parentMap.get(hash);
        if (parents) work.push(...parents);
      }
      return ancestors;
    }

    if (diffSelectTarget === 'to' && compareFrom) {
      // Only allow descendants of "from" (newer commits)
      const descendants = new Set<string>();
      const work = [...(childMap.get(compareFrom) ?? [])];
      while (work.length > 0) {
        const hash = work.pop()!;
        if (descendants.has(hash)) continue;
        descendants.add(hash);
        const children = childMap.get(hash);
        if (children) work.push(...children);
      }
      return descendants;
    }

    return null;
  }, [diffSelectTarget, compareFrom, compareTo, commits]);

  // Commits ahead of the reconciled HEAD (unreconciled, shown with amber tint)
  const aheadHashes = useMemo(() => {
    const reconHead = reconciledHead?.reconciledHead;
    if (!reconHead || commits.length === 0) return null;

    const childMap = new Map<string, string[]>();
    for (const c of commits) {
      for (const p of c.parents ?? []) {
        const existing = childMap.get(p) ?? [];
        existing.push(c.hash);
        childMap.set(p, existing);
      }
    }

    const descendants = new Set<string>();
    const work = [...(childMap.get(reconHead) ?? [])];
    while (work.length > 0) {
      const hash = work.pop()!;
      if (descendants.has(hash)) continue;
      descendants.add(hash);
      const children = childMap.get(hash);
      if (children) work.push(...children);
    }
    return descendants;
  }, [reconciledHead, commits]);

  const graphWidth = (layout.maxLanes + 1) * LANE_WIDTH;
  const svgHeight = commits.length * ROW_HEIGHT;

  const handleRowClick = (commit: GraphCommit) => {
    if (viewMode === 'diff' && diffSelectTarget) {
      // Block clicks on disabled rows
      if (allowedHashes && !allowedHashes.has(commit.hash)) return;
      onSelectDiffCommit(commit.hash, diffSelectTarget);
    } else {
      onSelectCommit(commit.hash);
    }
  };

  return (
    <div
      ref={panelRef}
      className={`git-tree-panel ${isOpen ? 'git-tree-panel-open' : ''}`}
      style={isOpen ? { height: panelHeight } : undefined}
    >
      <div className="git-tree-header">
        <span className="git-tree-title">
          {diffSelectTarget ? `Select ${diffSelectTarget} commit` : 'History'}
        </span>
        <button className="git-tree-close-btn" onClick={onClose}>&times;</button>
      </div>
      <div className="git-tree-scroll">
        {loading && commits.length === 0 ? (
          <div className="git-tree-loading">Loading...</div>
        ) : (
          <div className="git-tree-graph" style={{ position: 'relative' }}>
            {/* SVG edges and nodes */}
            <svg
              className="git-tree-svg"
              width={graphWidth}
              height={svgHeight}
              style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}
            >
              {layout.edges.map((edge, i) => (
                <path
                  key={i}
                  d={edgePath(edge.fromRow, edge.fromLane, edge.toRow, edge.toLane)}
                  stroke={laneColor(edge.toLane)}
                  strokeWidth={2}
                  fill="none"
                  opacity={0.7}
                />
              ))}
              {layout.nodes.map((node, i) => (
                <circle
                  key={node.commit.hash}
                  cx={laneX(node.lane)}
                  cy={rowY(i)}
                  r={NODE_RADIUS}
                  fill={
                    node.commit.hash === currentCommit
                      ? '#fff'
                      : laneColor(node.lane)
                  }
                  stroke={laneColor(node.lane)}
                  strokeWidth={node.commit.hash === currentCommit ? 2 : 0}
                />
              ))}
            </svg>

            {/* Rows */}
            {layout.nodes.map((node) => {
              const isCurrent = node.commit.hash === currentCommit;
              const isFrom = node.commit.hash === compareFrom;
              const isTo = node.commit.hash === compareTo;
              const isDisabled = allowedHashes !== null && !allowedHashes.has(node.commit.hash);
              const isReconciledCommit = reconciledHead?.reconciledHead === node.commit.hash;
              const isAhead = aheadHashes !== null && aheadHashes.has(node.commit.hash);

              return (
                <div
                  key={node.commit.hash}
                  className={`git-tree-row ${isCurrent ? 'git-tree-row-current' : ''} ${isDisabled ? 'git-tree-row-disabled' : ''} ${isAhead ? 'git-tree-row-ahead' : ''}`}
                  style={{ height: ROW_HEIGHT, paddingLeft: graphWidth + 4 }}
                  onClick={() => handleRowClick(node.commit)}
                >
                  <span className="git-tree-hash">{node.commit.shortHash}</span>
                  {reconciledHead?.gitHead === node.commit.hash && (
                    <span className="commit-head-badge">HEAD</span>
                  )}
                  {(node.commit.refs ?? []).map((ref) => (
                    <span key={ref} className="git-tree-ref-badge">{ref}</span>
                  ))}
                  {isReconciledCommit && (
                    <span className="git-tree-diff-badge git-tree-reconciled">RECONCILED</span>
                  )}
                  {viewMode === 'diff' && isFrom && (
                    <span className="git-tree-diff-badge git-tree-diff-from">FROM</span>
                  )}
                  {viewMode === 'diff' && isTo && (
                    <span className="git-tree-diff-badge git-tree-diff-to">TO</span>
                  )}
                  <span className="git-tree-subject">{node.commit.subject}</span>
                </div>
              );
            })}
          </div>
        )}
        {commits.length >= limit && (
          <button
            className="git-tree-load-more"
            onClick={() => setLimit((l) => l + 100)}
          >
            Load more...
          </button>
        )}
      </div>
      <div className="git-tree-resize-handle" onMouseDown={handleResizeMouseDown} />
    </div>
  );
};
