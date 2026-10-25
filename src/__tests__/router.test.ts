import { describe, it, expect } from 'vitest';
import { browseAtHref, parseRoute } from '../core/router';

describe('parseRoute: findings filters', () => {
  it('reads a severity filter', () => {
    expect(parseRoute('#/findings/severity/high')).toEqual({ mode: 'findings', severityFilter: 'high' });
  });
  it('keeps the feature filter and single-finding forms', () => {
    expect(parseRoute('#/findings/feature/f1')).toEqual({ mode: 'findings', featureFilterId: 'f1' });
    expect(parseRoute('#/findings/abc')).toEqual({ mode: 'findings', findingId: 'abc' });
  });
});

describe('parseRoute: detail pages', () => {
  it('opens a finding and a feature page', () => {
    expect(parseRoute('#/finding/abc')).toEqual({ mode: 'finding-detail', findingId: 'abc' });
    expect(parseRoute('#/feature/f1')).toEqual({ mode: 'feature-detail', featureId: 'f1' });
  });
  it('sends the old list deep link #/features/{id} to the feature page', () => {
    expect(parseRoute('#/features/f1')).toEqual({ mode: 'feature-detail', featureId: 'f1' });
    expect(parseRoute('#/features')).toEqual({ mode: 'features' });
  });
});

describe('browseAtHref', () => {
  it('names the branch in Browse\'s address, slashes as they are', () => {
    expect(browseAtHref('fix/login')).toBe('#/browse?at=fix/login');
    expect(parseRoute(browseAtHref('fix/login'))).toEqual({ mode: 'browse' });
  });
  it('escapes what a query cannot carry', () => {
    expect(browseAtHref('a&b#c')).toBe('#/browse?at=a%26b%23c');
  });
});
