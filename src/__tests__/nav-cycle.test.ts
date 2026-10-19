import { describe, it, expect } from 'vitest';
import { nextNavArea } from '../core/nav-cycle';

// U3: Tab / Shift+Tab area cycling (App.tsx TAB_CYCLES consumer).
const BROWSE = ['filetree', 'codeview', 'sidebar'] as const;
const all = () => true;

describe('nextNavArea', () => {
  it('advances forward and wraps', () => {
    expect(nextNavArea(BROWSE, all, 'filetree', false).area).toBe('codeview');
    expect(nextNavArea(BROWSE, all, 'sidebar', false).area).toBe('filetree');
  });

  it('goes backward and wraps with Shift', () => {
    expect(nextNavArea(BROWSE, all, 'codeview', true).area).toBe('filetree');
    expect(nextNavArea(BROWSE, all, 'filetree', true).area).toBe('sidebar');
  });

  it('skips areas that are not in the DOM, in both directions', () => {
    const noSidebar = (a: string) => a !== 'sidebar';
    expect(nextNavArea(BROWSE, noSidebar, 'codeview', false).area).toBe('filetree');
    expect(nextNavArea(BROWSE, noSidebar, 'filetree', true).area).toBe('codeview');
  });

  it('starts at the first live area when focus is outside any area (body / unknown)', () => {
    expect(nextNavArea(BROWSE, all, null, false).area).toBe('filetree');
    expect(nextNavArea(BROWSE, all, undefined, true).area).toBe('filetree');
    expect(nextNavArea(BROWSE, all, 'not-in-cycle', false).area).toBe('filetree');
    expect(nextNavArea(BROWSE, (a) => a !== 'filetree', null, false).area).toBe('codeview');
  });

  it('swallows Tab without moving when only one area is live', () => {
    const onlyCode = (a: string) => a === 'codeview';
    expect(nextNavArea(BROWSE, onlyCode, 'codeview', false)).toEqual({ area: null, suppress: true });
    // ...but focus outside the area still enters it.
    expect(nextNavArea(BROWSE, onlyCode, null, false)).toEqual({ area: 'codeview', suppress: false });
  });

  it('does nothing for views without a cycle or with nothing mounted', () => {
    expect(nextNavArea(undefined, all, 'x', false)).toEqual({ area: null, suppress: false });
    expect(nextNavArea([], all, 'x', false)).toEqual({ area: null, suppress: false });
    expect(nextNavArea(BROWSE, () => false, 'filetree', false)).toEqual({ area: null, suppress: false });
  });
});
