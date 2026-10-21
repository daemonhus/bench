import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkbenchExtensions, type ForeignFeature, type ForeignFinding, type OtherProjects } from './extensions';
import type { Feature } from './types';

// Links that span projects. On a bench server a feature can link to, and a finding affect,
// another project's feature; the reference is "<project>:<id>" where an id would be (a
// project's own ids never contain a colon). The host resolves and opens such references
// (WorkbenchExtensions.otherProjects); a standalone workbench has none.

/** The project and id of a "<project>:<id>" reference, or null for a plain id. */
function splitRef(ref: string): { project: string; id: string } | null {
  const at = ref.indexOf(':');
  return at > 0 && at < ref.length - 1 ? { project: ref.slice(0, at), id: ref.slice(at + 1) } : null;
}

export const isCrossRef = (id: string) => splitRef(id) !== null;

/** A feature as the cards and lists show it; another project's carries its project's name. */
export type LinkedFeatureView = Feature & { projectName?: string; missing?: boolean };

/** Another project's feature in the shape the cards draw (its id is the reference). */
export function foreignAsFeature(f: ForeignFeature): LinkedFeatureView {
  return {
    id: f.ref, kind: f.kind, title: f.missing ? 'Removed feature' : f.title, operation: f.operation,
    description: f.description, anchor: { fileId: f.fileId ?? '', commitId: '' }, status: 'active', tags: [],
    createdAt: '', source: '', projectName: f.projectName || f.project, missing: f.missing,
  } as LinkedFeatureView;
}

// Resolved references, shared by every card for the session (another project's feature
// rarely changes under a review); a reference not seen yet is fetched once.
const featureCache = new Map<string, Promise<ForeignFeature | undefined>>();
const findingCache = new Map<string, Promise<ForeignFinding | undefined>>();

function resolveAll<T extends { ref: string }>(cache: Map<string, Promise<T | undefined>>, refs: string[], fetch: (refs: string[]) => Promise<T[]>) {
  const missing = refs.filter((r) => !cache.has(r));
  if (missing.length) {
    const batch = fetch(missing).catch(() => [] as T[]);
    for (const r of missing) cache.set(r, batch.then((list) => list.find((x) => x.ref === r)));
  }
  return Promise.all(refs.map((r) => cache.get(r)!));
}

function useForeign<T extends { ref: string }>(refs: string[], cache: Map<string, Promise<T | undefined>>, fetch: ((o: OtherProjects, refs: string[]) => Promise<T[]>)): Map<string, T> {
  const other = useWorkbenchExtensions().otherProjects;
  const key = refs.filter(isCrossRef).sort().join(',');
  const [found, setFound] = useState<Map<string, T>>(new Map());
  useEffect(() => {
    if (!other || !key) { setFound(new Map()); return; }
    let live = true;
    resolveAll(cache, key.split(','), (r) => fetch(other, r)).then((list) => {
      const next = new Map<string, T>();
      for (const x of list) if (x) next.set(x.ref, x as T);
      if (live) setFound(next);
    });
    return () => { live = false; };
  }, [other, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return found;
}

/** Other projects' features among these ids, resolved. */
export function useForeignFeatures(ids: string[]): Map<string, ForeignFeature> {
  return useForeign(ids, featureCache, (o, r) => o.features(r));
}

/** Other projects' findings among these references, resolved. */
export function useForeignFindings(refs: string[]): Map<string, ForeignFinding> {
  return useForeign(refs, findingCache, (o, r) => o.findings(r));
}

/** These ids as features to draw, in order: this project's from `local`, other projects' resolved
 *  through the host (shown once resolved; an unknown local id is left out, as before). */
export function useLinkedFeatures(ids: string[], local: Feature[]): LinkedFeatureView[] {
  const foreign = useForeignFeatures(ids);
  return useMemo(() => {
    const byId = new Map(local.map((f) => [f.id, f]));
    return ids
      .map((id): LinkedFeatureView | undefined => (isCrossRef(id) ? (foreign.get(id) && foreignAsFeature(foreign.get(id)!)) : byId.get(id)))
      .filter((f): f is LinkedFeatureView => !!f);
  }, [ids, local, foreign]);
}

/** "POST /login" for another project's feature, as the detail pages list it; undefined if unknown. */
export function foreignLabel(f?: ForeignFeature): string | undefined {
  if (!f) return undefined;
  return f.missing ? 'removed feature' : [f.operation && !f.title.toUpperCase().startsWith(f.operation.toUpperCase()) ? f.operation : '', f.title].filter(Boolean).join(' ');
}

/** Opens a feature or finding by id or reference: here by its hash route, in its own project
 *  through the host. */
export function useOpenRef(): (id: string, kind: 'feature' | 'finding') => void {
  const other = useWorkbenchExtensions().otherProjects;
  return useCallback((id, kind) => {
    const ref = splitRef(id);
    if (ref && other) other.open(ref.project, `#/${kind}/${ref.id}`);
    else if (!ref) window.location.hash = `#/${kind}/${id}`;
  }, [other]);
}
