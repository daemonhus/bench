import { describe, it, expect, beforeEach } from 'vitest';
import { parseRoute, buildRoute } from '../core/router';

describe('delta/browse navigation', () => {
  describe('route parsing', () => {
    it('parses #/overview as overview mode', () => {
      const route = parseRoute('#/overview');
      expect(route.mode).toBe('overview');
    });

    it('round-trips overview through buildRoute', () => {
      expect(buildRoute('overview')).toBe('#/overview');
      expect(parseRoute(buildRoute('overview')).mode).toBe('overview');
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

    it('parses #/findings/{id} as findings mode with findingId', () => {
      const route = parseRoute('#/findings/f-abc123');
      expect(route.mode).toBe('findings');
      expect(route.findingId).toBe('f-abc123');
    });

    it('parses #/findings/feature/{id} as a feature-filtered findings view', () => {
      const route = parseRoute('#/findings/feature/feat-1');
      expect(route.mode).toBe('findings');
      expect(route.featureFilterId).toBe('feat-1');
      expect(route.findingId).toBeUndefined();
    });

    it('parses #/config as config mode', () => {
      const route = parseRoute('#/config');
      expect(route.mode).toBe('config');
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

  describe('config route building', () => {
    it('builds config route', () => {
      expect(buildRoute('config')).toBe('#/config');
    });

    it('round-trips config through parse', () => {
      expect(parseRoute(buildRoute('config')).mode).toBe('config');
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
