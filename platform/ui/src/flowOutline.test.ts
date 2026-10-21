import { describe, it, expect } from 'vitest';
import { outline, stepNumbers, reachableFrom, type GraphEdge, type GraphStep } from './flowOutline';

const steps = (...ids: string[]): GraphStep[] => ids.map((id, position) => ({ id, position }));
const edge = (from: string, to: string, position = 0, condition = ''): GraphEdge => ({ fromStepId: from, toStepId: to, position, condition });

describe('outline', () => {
  it('reads a path in order', () => {
    const o = outline(steps('a', 'b', 'c'), [edge('b', 'c'), edge('a', 'b')]);
    expect(o.order).toEqual(['a', 'b', 'c']);
    expect(o.parent.get('c')).toBe('b');
    expect(o.entries).toEqual(['a']);
    expect(o.extra).toEqual([]);
  });

  it('puts branches in branch order and numbers depth first', () => {
    const o = outline(steps('a', 'b', 'c', 'd'), [edge('a', 'c', 1, 'else'), edge('a', 'b', 0, 'if admin'), edge('b', 'd')]);
    expect(o.order).toEqual(['a', 'b', 'd', 'c']);
    expect(o.children.get('a')).toEqual(['b', 'c']);
    expect(o.via.get('c')?.condition).toBe('else');
    expect(stepNumbers(o).get('c')).toBe(4);
  });

  it('lists joins and loops as extra edges', () => {
    const join = edge('c', 'd');
    const loop = edge('d', 'a', 1);
    const o = outline(steps('a', 'b', 'c', 'd'), [edge('a', 'b'), edge('a', 'c', 1), edge('b', 'd'), join, loop]);
    expect(o.order).toEqual(['a', 'b', 'd', 'c']);
    expect(o.extra).toEqual([join, loop]);
  });

  it('keeps several entry points in step order', () => {
    const o = outline(steps('x', 'y', 'z'), [edge('y', 'z')]);
    expect(o.entries).toEqual(['x', 'y']);
    expect(o.children.get(null)).toEqual(['x', 'y']);
  });

  it('still shows a loop with no way in', () => {
    const o = outline(steps('a', 'b'), [edge('a', 'b'), edge('b', 'a')]);
    expect(o.entries).toEqual([]);
    expect(o.order).toEqual(['a', 'b']);
    expect(o.extra).toHaveLength(1);
  });

  it('ignores edges to steps it does not have', () => {
    const o = outline(steps('a'), [edge('a', 'ghost')]);
    expect(o.order).toEqual(['a']);
    expect(o.extra).toEqual([]);
  });
});

describe('reachableFrom', () => {
  it('follows edges, through loops, without itself', () => {
    const r = reachableFrom([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], 'a');
    expect([...r].sort()).toEqual(['b', 'c']);
  });
});
