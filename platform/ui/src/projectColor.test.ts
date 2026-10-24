import { describe, it, expect } from 'vitest';
import { assignHues } from './projectColor';

const project = (slug: string, day: number) => ({ slug, createdAt: `2026-01-${String(day).padStart(2, '0')} 10:00:00` });

describe('assignHues', () => {
  it('gives the first twelve projects twelve different colours', () => {
    const projects = Array.from({ length: 12 }, (_, i) => project(`svc-${i}`, i + 1));
    expect(new Set(assignHues(projects).values()).size).toBe(12);
  });

  it('keeps every colour when a project is added', () => {
    const before = [project('alpha', 1), project('beta', 2), project('gamma', 3)];
    const after = assignHues([...before, project('delta', 4)]);
    for (const [slug, hue] of assignHues(before)) expect(after.get(slug)).toBe(hue);
  });

  it('separates projects whose names hash alike', () => {
    // alpha and beta hash to the same hue; the later one moves on.
    const hues = assignHues([project('beta', 2), project('alpha', 1)]);
    expect(hues.get('alpha')).not.toBe(hues.get('beta'));
  });

  it('spreads a thirteenth project onto a colour used once', () => {
    const projects = Array.from({ length: 13 }, (_, i) => project(`svc-${i}`, i + 1));
    const counts = new Map<number, number>();
    for (const hue of assignHues(projects).values()) counts.set(hue, (counts.get(hue) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([...Array(11).fill(1), 2]);
  });

  it('is the same whatever order the projects are listed in', () => {
    const projects = [project('a', 3), project('b', 1), project('c', 2)];
    expect(assignHues(projects)).toEqual(assignHues([...projects].reverse()));
  });
});
