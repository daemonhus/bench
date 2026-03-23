import { describe, it, expect, beforeEach } from 'vitest';
import { parseRoute, buildRoute } from '../core/router';

describe('delta/browse navigation', () => {
  describe('route parsing', () => {
    it('redirects #/overview to delta mode', () => {
      const route = parseRoute('#/overview');
      expect(route.mode).toBe('delta');
    });

    it('parses empty hash as delta mode (default)', () => {
      const route = parseRoute('');
      expect(route.mode).toBe('delta');
    });

    it('parses #/browse/path as browse mode with file', () => {
      const route = parseRoute('#/browse/src/main.ts');
      expect(route.mode).toBe('browse');
      expect(route.path).toBe('src/main.ts');
    });

    it('parses #/browse/nested/deep/path.tsx correctly', () => {
      const route = parseRoute('#/browse/src/components/App.tsx');
      expect(route.mode).toBe('browse');
      expect(route.path).toBe('src/components/App.tsx');
    });

    it('parses #/browse with no path as browse mode without file', () => {
      const route = parseRoute('#/browse');
      expect(route.mode).toBe('browse');
      expect(route.path).toBeUndefined();
    });
  });

  describe('route building', () => {
    it('builds browse route with file path', () => {
      const hash = buildRoute('browse', undefined, undefined, 'src/main.ts');
      expect(hash).toBe('#/browse/src/main.ts');
    });

    it('builds browse route without file', () => {
      const hash = buildRoute('browse');
      expect(hash).toBe('#/browse');
    });
  });

  describe('file selection produces browse route', () => {
    // Simulates the contract: clicking a file sets
    // window.location.hash = `#/browse/${path}`, which when parsed
    // yields browse mode with the correct file path.

    it('selecting a file navigates to browse mode', () => {
      const filePath = 'src/components/FileTree.tsx';
      const hash = `#/browse/${filePath}`;
      const route = parseRoute(hash);

      expect(route.mode).toBe('browse');
      expect(route.path).toBe(filePath);
    });

    it('selecting a root-level file navigates correctly', () => {
      const filePath = 'README.md';
      const hash = `#/browse/${filePath}`;
      const route = parseRoute(hash);

      expect(route.mode).toBe('browse');
      expect(route.path).toBe(filePath);
    });

    it('selecting a deeply nested file navigates correctly', () => {
      const filePath = 'src/stores/annotation-store.ts';
      const hash = `#/browse/${filePath}`;
      const route = parseRoute(hash);

      expect(route.mode).toBe('browse');
      expect(route.path).toBe(filePath);
    });

    it('round-trips: buildRoute output parses back to same route', () => {
      const path = 'src/core/api.ts';
      const hash = buildRoute('browse', undefined, undefined, path);
      const route = parseRoute(hash);

      expect(route.mode).toBe('browse');
      expect(route.path).toBe(path);
    });
  });
});
