import { describe, it, expect, vi } from 'vitest';
import { buttonProps } from '../core/a11y';
import { nextResizeWidth, RESIZE_KEY_STEP, resizeHandleProps } from '../hooks/useResizeDrag';

describe('buttonProps (U6)', () => {
  const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  it('makes the element a labelled button with a tab stop', () => {
    const p = buttonProps(() => {}, 'Copy ID');
    expect(p.role).toBe('button');
    expect(p.tabIndex).toBe(0);
    expect(p['aria-label']).toBe('Copy ID');
    expect('aria-label' in buttonProps(() => {})).toBe(false);
  });

  it('Enter and Space activate exactly like a click; other keys do not', () => {
    const fn = vi.fn();
    const p = buttonProps(fn);
    for (const k of ['Enter', ' ']) {
      const e = key(k);
      p.onKeyDown(e as never);
      expect(e.preventDefault).toHaveBeenCalled(); // Space must not scroll
      expect(e.stopPropagation).toHaveBeenCalled(); // must not also trigger the card's Enter/Space
    }
    expect(fn).toHaveBeenCalledTimes(2);
    p.onKeyDown(key('a') as never);
    p.onKeyDown(key('Tab') as never);
    expect(fn).toHaveBeenCalledTimes(2);
    p.onClick({} as never);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('nextResizeWidth (U7)', () => {
  const left = { min: 180, max: 500 };
  const right = { min: 200, max: 800, fromRight: true };

  it('ArrowRight grows a left-anchored pane and shrinks a right-anchored one', () => {
    expect(nextResizeWidth('ArrowRight', 260, left)).toBe(260 + RESIZE_KEY_STEP);
    expect(nextResizeWidth('ArrowLeft', 260, left)).toBe(260 - RESIZE_KEY_STEP);
    expect(nextResizeWidth('ArrowLeft', 500, right)).toBe(500 + RESIZE_KEY_STEP); // moving the divider left widens it
    expect(nextResizeWidth('ArrowRight', 500, right)).toBe(500 - RESIZE_KEY_STEP);
  });

  it('clamps to the limits; Home/End jump; other keys are not resize keys', () => {
    expect(nextResizeWidth('ArrowRight', 495, left)).toBe(500);
    expect(nextResizeWidth('ArrowLeft', 185, left)).toBe(180);
    expect(nextResizeWidth('Home', 300, left)).toBe(180);
    expect(nextResizeWidth('End', 300, left)).toBe(500);
    expect(nextResizeWidth('a', 300, left)).toBeNull();
    expect(nextResizeWidth('ArrowUp', 300, left)).toBeNull();
  });

  it('resizeHandleProps is an ARIA vertical separator reporting the width, and resizes on arrows', () => {
    const set = vi.fn();
    const p = resizeHandleProps('Resize x', 300.4, set, left);
    expect(p.role).toBe('separator');
    expect(p['aria-orientation']).toBe('vertical');
    expect(p['aria-valuenow']).toBe(300);
    expect(p['aria-valuemin']).toBe(180);
    expect(p['aria-valuemax']).toBe(500);
    const e = { key: 'ArrowRight', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    p.onKeyDown(e as never);
    expect(set).toHaveBeenCalledWith(300.4 + RESIZE_KEY_STEP);
    expect(e.preventDefault).toHaveBeenCalled();
    const other = { key: 'x', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    p.onKeyDown(other as never);
    expect(set).toHaveBeenCalledTimes(1);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});
