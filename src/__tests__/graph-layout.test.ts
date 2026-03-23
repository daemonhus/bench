import { describe, it, expect } from 'vitest';
import { computeGraphLayout } from '../core/graph-layout';
import type { GraphCommit } from '../core/types';

function makeCommit(
  hash: string,
  parents: string[] = [],
  refs: string[] = [],
): GraphCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'test',
    date: '2024-01-01T00:00:00Z',
    subject: `commit ${hash}`,
    parents,
    refs,
  };
}

describe('computeGraphLayout', () => {
  it('returns empty layout for empty input', () => {
    const layout = computeGraphLayout([]);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.maxLanes).toBe(0);
  });

  it('handles a single commit (root)', () => {
    const commits = [makeCommit('aaa')];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].lane).toBe(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.maxLanes).toBe(1);
  });

  it('handles a linear chain of commits', () => {
    // Topological order: child before parent
    const commits = [
      makeCommit('ccc', ['bbb']),
      makeCommit('bbb', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(3);
    // All should be in the same lane
    const lanes = layout.nodes.map((n) => n.lane);
    expect(lanes[0]).toBe(lanes[1]);
    expect(lanes[1]).toBe(lanes[2]);

    // Should have 2 edges: ccc->bbb and bbb->aaa
    expect(layout.edges).toHaveLength(2);
  });

  it('assigns different lanes to parallel branches', () => {
    // Two branches diverging from the same parent:
    //   ddd (parent: aaa) - branch 1 tip
    //   ccc (parent: aaa) - branch 2 tip
    //   bbb (parent: aaa) - another commit (or we simplify)
    //   aaa - root
    //
    // Simpler: two children of the same parent
    const commits = [
      makeCommit('bbb', ['aaa']), // branch 1
      makeCommit('ccc', ['aaa']), // branch 2
      makeCommit('aaa'),          // root
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(3);
    // bbb and ccc should be in different lanes since they're both branch heads
    // (neither is a parent of the other)
    const bbbLane = layout.nodes[0].lane;
    const cccLane = layout.nodes[1].lane;
    // After bbb is placed and its parent aaa assigned to its lane,
    // ccc has no lane expecting it, so it gets a new lane
    expect(bbbLane).not.toBe(cccLane);
  });

  it('handles a merge commit', () => {
    // Merge: ddd has two parents bbb and ccc
    //   ddd (parents: bbb, ccc)
    //   bbb (parent: aaa)
    //   ccc (parent: aaa)
    //   aaa
    const commits = [
      makeCommit('ddd', ['bbb', 'ccc']),
      makeCommit('bbb', ['aaa']),
      makeCommit('ccc', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(4);
    // ddd should produce edges to both bbb and ccc
    const dddEdges = layout.edges.filter((e) => e.fromRow === 0);
    expect(dddEdges).toHaveLength(2);
  });

  it('preserves commit order in nodes', () => {
    const commits = [
      makeCommit('ccc', ['bbb']),
      makeCommit('bbb', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes[0].commit.hash).toBe('ccc');
    expect(layout.nodes[1].commit.hash).toBe('bbb');
    expect(layout.nodes[2].commit.hash).toBe('aaa');
  });

  it('edges connect correct rows', () => {
    const commits = [
      makeCommit('bbb', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0].fromRow).toBe(0);
    expect(layout.edges[0].toRow).toBe(1);
  });

  it('handles commits with refs', () => {
    const commits = [
      makeCommit('bbb', ['aaa'], ['main', 'HEAD']),
      makeCommit('aaa', [], ['v1.0']),
    ];
    const layout = computeGraphLayout(commits);

    // Refs should be preserved on the commits
    expect(layout.nodes[0].commit.refs).toEqual(['main', 'HEAD']);
    expect(layout.nodes[1].commit.refs).toEqual(['v1.0']);
  });

  it('handles parent not in the commit list (truncated history)', () => {
    // Parent 'zzz' is not in the commit list (history was truncated)
    const commits = [
      makeCommit('bbb', ['zzz']),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(1);
    // Should not crash; edge to missing parent should not be created
    expect(layout.edges).toHaveLength(0);
  });

  it('handles long linear chain with correct maxLanes', () => {
    const commits = [
      makeCommit('eee', ['ddd']),
      makeCommit('ddd', ['ccc']),
      makeCommit('ccc', ['bbb']),
      makeCommit('bbb', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(5);
    // Linear chain should use only 1 lane
    expect(layout.maxLanes).toBe(1);
    expect(layout.edges).toHaveLength(4);
  });

  it('handles diamond merge pattern', () => {
    // Diamond:
    //   eee (merge: ccc, ddd)
    //   ccc (parent: bbb) - left branch
    //   ddd (parent: bbb) - right branch
    //   bbb (parent: aaa)
    //   aaa
    const commits = [
      makeCommit('eee', ['ccc', 'ddd']),
      makeCommit('ccc', ['bbb']),
      makeCommit('ddd', ['bbb']),
      makeCommit('bbb', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);

    expect(layout.nodes).toHaveLength(5);
    // Merge commit should have 2 edges out
    const mergeEdges = layout.edges.filter((e) => e.fromRow === 0);
    expect(mergeEdges).toHaveLength(2);
    // Total edges: eee->ccc, eee->ddd, ccc->bbb, ddd->bbb, bbb->aaa = 5
    expect(layout.edges).toHaveLength(5);
  });

  it('maxLanes is at least 1 for non-empty input', () => {
    const commits = [makeCommit('aaa')];
    const layout = computeGraphLayout(commits);
    expect(layout.maxLanes).toBeGreaterThanOrEqual(1);
  });

  it('assigns lanes consistently for first parent', () => {
    // In a linear chain, first parent should keep the same lane
    const commits = [
      makeCommit('ddd', ['ccc']),
      makeCommit('ccc', ['bbb']),
      makeCommit('bbb', ['aaa']),
      makeCommit('aaa'),
    ];
    const layout = computeGraphLayout(commits);
    const lanes = layout.nodes.map((n) => n.lane);
    // All should be in lane 0 (linear first-parent chain)
    expect(lanes).toEqual([0, 0, 0, 0]);
  });
});
