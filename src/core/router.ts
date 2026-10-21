import { splitHash } from './query-state';

export interface Route {
  mode: 'overview' | 'browse' | 'diff' | 'delta' | 'findings' | 'features' | 'profile' | 'feature-detail' | 'finding-detail';
  from?: string;
  to?: string;
  path?: string;
  baselineId?: string;
  featureId?: string;
  findingId?: string;
  featureFilterId?: string;
  /** #/findings/severity/{level}: open the list with only that severity selected. */
  severityFilter?: string;
}

/**
 * Parse the current hash into a Route.
 * Supported formats:
 *   #/browse              → browse mode
 *   #/browse/path/to/file → browse mode with file selected
 *   #/diff/FROM/TO        → diff mode with commit hashes
 *   #/diff/FROM/TO/path   → diff mode with file
 *   #/delta               → delta view (since latest baseline)
 *   #/delta/{id}          → delta view for specific baseline
 *   #/findings/severity/{level} → findings with only that severity selected
 *   #/finding/{id}        → one finding's detail page
 *   (empty or #/)         → delta mode (default)
 */
export function parseRoute(hash: string): Route {
  // A view's filters ride after the route (#/findings?severity=high; see query-state.ts).
  const raw = splitHash(hash)[0].replace(/^#\/?/, '');
  if (!raw) return { mode: 'delta' };

  const parts = raw.split('/');

  if (parts[0] === 'diff' && parts.length >= 3) {
    const from = parts[1];
    const to = parts[2];
    const path = parts.length > 3 ? parts.slice(3).join('/') : undefined;
    return { mode: 'diff', from, to, path };
  }

  if (parts[0] === 'overview') {
    return { mode: 'overview' };
  }

  if (parts[0] === 'findings') {
    // #/findings/feature/{id} → findings filtered to one feature;
    // #/findings/{id}         → scroll to a specific finding.
    if (parts[1] === 'feature' && parts[2]) {
      return { mode: 'findings', featureFilterId: parts[2] };
    }
    // #/findings/severity/{level} → the Severity filter set to that one level.
    if (parts[1] === 'severity' && parts[2]) {
      return { mode: 'findings', severityFilter: parts[2] };
    }
    return { mode: 'findings', findingId: parts[1] };
  }

  // 'config' is the pre-rename hash; keep parsing it so old links still land.
  if (parts[0] === 'profile' || parts[0] === 'config') {
    return { mode: 'profile' };
  }

  // Single-finding full-page detail (distinct from #/findings/{id}, the list filtered to it).
  if (parts[0] === 'finding') {
    return { mode: 'finding-detail', findingId: parts[1] };
  }

  // Single-feature full-page detail (distinct from the list scroll-to deep-link).
  if (parts[0] === 'feature') {
    return { mode: 'feature-detail', featureId: parts[1] };
  }

  // #/features/{id} used to scroll the list to a feature; it now opens the feature's page.
  if (parts[0] === 'features') {
    return parts[1] ? { mode: 'feature-detail', featureId: parts[1] } : { mode: 'features' };
  }

  if (parts[0] === 'delta') {
    const baselineId = parts.length > 1 ? parts[1] : undefined;
    return { mode: 'delta', baselineId };
  }

  // Backward compat: old review-delta URLs → redirect to delta
  if (parts[0] === 'review-delta') {
    const baselineId = parts.length > 1 ? parts[1] : undefined;
    const newHash = baselineId ? `#/delta/${baselineId}` : '#/delta';
    window.location.hash = newHash;
    return { mode: 'delta', baselineId };
  }

  if (parts[0] === 'browse') {
    const path = parts.length > 1 ? parts.slice(1).join('/') : undefined;
    return { mode: 'browse', path };
  }

  // Fallback: treat as browse
  return { mode: 'browse' };
}

/**
 * Build a hash string from route parameters.
 */
export function buildRoute(
  mode: 'overview' | 'browse' | 'diff' | 'delta' | 'findings' | 'features' | 'profile' | 'feature-detail' | 'finding-detail',
  from?: string,
  to?: string,
  path?: string,
  /** The detail page's entity: a feature (feature-detail, features) or a finding (finding-detail). */
  detailId?: string,
): string {
  if (mode === 'overview') return '#/overview';
  if (mode === 'findings') return '#/findings';
  if (mode === 'profile') return '#/profile';
  if (mode === 'feature-detail') return detailId ? `#/feature/${detailId}` : '#/features';
  if (mode === 'finding-detail') return detailId ? `#/finding/${detailId}` : '#/findings';
  if (mode === 'features') return '#/features';
  if (mode === 'delta') return '#/delta';
  if (mode === 'diff' && from && to) {
    const base = `#/diff/${from}/${to}`;
    return path ? `${base}/${path}` : base;
  }
  if (path) return `#/browse/${path}`;
  return '#/browse';
}

/**
 * Listen for hash changes and call the callback with the parsed route.
 * Returns an unsubscribe function.
 */
export function onRouteChange(callback: (route: Route) => void): () => void {
  const handler = () => callback(parseRoute(window.location.hash));
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
