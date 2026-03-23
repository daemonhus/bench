export interface Route {
  mode: 'browse' | 'diff' | 'delta' | 'findings' | 'features';
  from?: string;
  to?: string;
  path?: string;
  baselineId?: string;
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
 *   (empty or #/)         → delta mode (default)
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return { mode: 'delta' };

  const parts = raw.split('/');

  if (parts[0] === 'diff' && parts.length >= 3) {
    const from = parts[1];
    const to = parts[2];
    const path = parts.length > 3 ? parts.slice(3).join('/') : undefined;
    return { mode: 'diff', from, to, path };
  }

  // Redirect legacy overview URLs to delta
  if (parts[0] === 'overview') {
    window.location.hash = '#/delta';
    return { mode: 'delta' };
  }

  if (parts[0] === 'findings') {
    return { mode: 'findings' };
  }

  if (parts[0] === 'features') {
    return { mode: 'features' };
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
  mode: 'browse' | 'diff' | 'delta' | 'findings' | 'features',
  from?: string,
  to?: string,
  path?: string,
): string {
  if (mode === 'findings') return '#/findings';
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
