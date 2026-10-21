import type { ForeignFeature, ForeignFinding, OtherProjects } from '@bench/core/extensions';
import type { FeatureKind } from '@bench/core/types';
import { listProjects } from './api';

// The workbench's view of the server's other projects (WorkbenchExtensions.otherProjects):
// the link picker searches their features, cards resolve "<project>:<id>" references to
// titles, and a click opens the page in its own project.

interface CatalogFeature {
  projectSlug: string;
  projectName: string;
  id: string;
  title: string;
  kind: FeatureKind;
  operation?: string;
  anchor?: { fileId?: string };
  tombstoned?: boolean;
}

const asForeign = (c: CatalogFeature): ForeignFeature => ({
  ref: `${c.projectSlug}:${c.id}`, project: c.projectSlug, projectName: c.projectName || c.projectSlug, id: c.id,
  title: c.title, kind: c.kind, operation: c.operation, fileId: c.anchor?.fileId, missing: c.tombstoned,
});

let names: Promise<Map<string, string>> | null = null;
const projectNames = () => (names ??= listProjects().then((ps) => new Map(ps.map((p) => [p.slug, p.name]))).catch(() => { names = null; return new Map(); }));

export function otherProjectsFor(slug: string, open: (project: string, hash: string) => void): OtherProjects {
  return {
    async searchFeatures(q) {
      const res = await fetch(`/api/features/search?q=${encodeURIComponent(q)}&limit=40`);
      if (!res.ok) return [];
      return ((await res.json()) as CatalogFeature[]).filter((c) => c.projectSlug !== slug).slice(0, 12).map(asForeign);
    },
    async features(refs) {
      if (!refs.length) return [];
      const res = await fetch(`/api/features?refs=${refs.map(encodeURIComponent).join(',')}`);
      if (!res.ok) return [];
      return ((await res.json()) as CatalogFeature[] | null ?? []).map(asForeign);
    },
    async findings(refs) {
      const byName = await projectNames();
      const out = await Promise.all(refs.map(async (ref): Promise<ForeignFinding> => {
        const at = ref.indexOf(':');
        const project = ref.slice(0, at);
        const id = ref.slice(at + 1);
        const base = { ref, project, projectName: byName.get(project) ?? project, id };
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(project)}/findings/${encodeURIComponent(id)}`);
          if (!res.ok) return { ...base, title: 'Removed finding', severity: 'info', status: 'closed', missing: true };
          const f = await res.json() as { title: string; severity: string; status: string };
          return { ...base, title: f.title, severity: f.severity, status: f.status };
        } catch {
          return { ...base, title: 'Unreachable finding', severity: 'info', status: 'closed', missing: true };
        }
      }));
      return out;
    },
    open,
  };
}
