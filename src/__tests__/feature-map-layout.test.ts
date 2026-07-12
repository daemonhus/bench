import { describe, it, expect } from 'vitest';
import { buildFeatureMap, countCrossings, nodeRadius } from '../core/feature-map-layout';
import type { Feature, FeatureKind } from '../core/types';

let seq = 0;
function feat(kind: FeatureKind, title: string, links: string[] = []): Feature {
  return {
    id: `f-${title}`,
    anchor: { fileId: 'a.go', commitId: 'c1' },
    kind,
    title,
    status: 'active',
    tags: [],
    linkedFeatures: links.map((id) => ({ id: `f-${id}` })),
    createdAt: `2026-01-0${(seq++ % 8) + 1}`,
  };
}

describe('buildFeatureMap (force layout)', () => {
  it('is deterministic: same input, same layout', () => {
    const features = [
      feat('interface', 'i1', ['s1', 'k1']),
      feat('interface', 'i2', ['s1']),
      feat('source', 's1', ['k1']),
      feat('sink', 'k1'),
      feat('externality', 'cron', ['s1']),
    ];
    const a = buildFeatureMap(features);
    const b = buildFeatureMap(features);
    expect(a.nodes.map((n) => [n.id, n.x, n.y])).toEqual(b.nodes.map((n) => [n.id, n.x, n.y]));
    expect(a.edges).toEqual(b.edges);
  });

  it('orders columns by graph distance from the interfaces', () => {
    // i1 → s1 → src1: each hop lands further right despite kind.
    const { nodes } = buildFeatureMap([
      feat('interface', 'i1', ['s1']),
      feat('sink', 's1', ['src1']),
      feat('source', 'src1'),
    ]);
    const byLabel = new Map(nodes.map((n) => [n.label, n]));
    expect(byLabel.get('i1')!.x).toBeLessThan(byLabel.get('s1')!.x);
    expect(byLabel.get('s1')!.x).toBeLessThan(byLabel.get('src1')!.x);
  });

  it('parks unlinked nodes in a band below the flow', () => {
    const { nodes } = buildFeatureMap([
      feat('interface', 'i1', ['s1']),
      feat('sink', 's1'),
      feat('externality', 'isolated'),
    ]);
    const byLabel = new Map(nodes.map((n) => [n.label, n]));
    expect(byLabel.get('isolated')!.y).toBeGreaterThan(byLabel.get('i1')!.y);
    expect(byLabel.get('isolated')!.y).toBeGreaterThan(byLabel.get('s1')!.y);
  });

  it('does not stack unlinked nodes on top of each other', () => {
    // Unlinked nodes have no attractive force: before the band, repulsion
    // flung them to a wall where the final clamp stacked them.
    const features = [
      feat('interface', 'i1', ['s1']),
      feat('sink', 's1'),
      ...['u1', 'u2', 'u3', 'u4', 'u5'].map((t) => feat('externality', t)),
    ];
    const { nodes } = buildFeatureMap(features);
    const unlinked = nodes.filter((n) => n.label.startsWith('u'));
    for (let i = 0; i < unlinked.length; i++) {
      for (let j = i + 1; j < unlinked.length; j++) {
        const dx = (unlinked[i].x - unlinked[j].x) / 100 * 400;
        const dy = (unlinked[i].y - unlinked[j].y) / 100 * 260;
        expect(Math.hypot(dx, dy)).toBeGreaterThan(unlinked[i].r + unlinked[j].r);
      }
    }
  });

  it('resolves collisions: no two nodes closer than their radii allow', () => {
    // Six siblings in one column force the collision pass to spread them.
    const features = [
      feat('interface', 'i1', ['a', 'b', 'c', 'd', 'e', 'f']),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((t) => feat('sink', t)),
    ];
    const { nodes } = buildFeatureMap(features);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        expect(Math.hypot(dx, dy)).toBeGreaterThan(3);
      }
    }
  });

  it('keeps positions inside the drawable area', () => {
    const features = [
      feat('interface', 'i1', ['a', 'b', 'c', 'd']),
      ...['a', 'b', 'c', 'd'].map((t) => feat('sink', t, ['deep'])),
      feat('source', 'deep'),
    ];
    const { nodes } = buildFeatureMap(features);
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(6);
      expect(n.x).toBeLessThanOrEqual(94);
      expect(n.y).toBeGreaterThanOrEqual(10);
      expect(n.y).toBeLessThanOrEqual(86);
    }
  });

  it('deduplicates bidirectional links into single edges', () => {
    const features = [
      feat('interface', 'i1', ['s1']),
      feat('sink', 's1', ['i1']), // reverse direction of the same link
    ];
    const { edges } = buildFeatureMap(features);
    expect(edges).toHaveLength(1);
  });

  it('scales node radius with open findings, clamped', () => {
    expect(nodeRadius(0)).toBe(8);
    expect(nodeRadius(2)).toBe(12);
    expect(nodeRadius(10)).toBe(16);
    const openBy = new Map([['f-i1', 3]]);
    const { nodes } = buildFeatureMap([feat('interface', 'i1')], openBy);
    expect(nodes[0].r).toBe(14);
  });
});

describe('countCrossings', () => {
  it('detects a crossing X and ignores shared endpoints', () => {
    const nodes = [
      { x: 0, y: 0 }, { x: 100, y: 100 },   // edge A: top-left → bottom-right
      { x: 0, y: 100 }, { x: 100, y: 0 },   // edge B: bottom-left → top-right
    ];
    expect(countCrossings(nodes, [[0, 1], [2, 3]])).toBe(1);
    // Sharing an endpoint is not a crossing.
    expect(countCrossings(nodes, [[0, 1], [0, 3]])).toBe(0);
  });
});
