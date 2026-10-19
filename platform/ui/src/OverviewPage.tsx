import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  listProjects,
  getSettings,
  DEFAULT_RISK_WEIGHTS,
  type Project,
  type RiskWeights,
} from './api';
import {
  parseFilter, buildFilter, withToken, computeFacetCounts,
  FilterSearch, FacetGroup, type FilterState,
} from './filters';
import { DashboardCards } from './DashboardCards';
import { ProjectList } from './ProjectList';

const POLL_INTERVAL = 30_000;

interface OverviewPageProps {
  onSelect: (slug: string) => void;
  onOpen?: (slug: string, hash: string) => void;
}

function matchProject(p: Project, state: FilterState): boolean {
  if (state.tokens.tag) {
    if (!state.tokens.tag.some((t) => p.tags?.includes(t))) return false;
  }
  if (state.tokens.owner) {
    if (!state.tokens.owner.includes(p.owner || '(none)')) return false;
  }
  if (state.text) {
    try {
      const re = new RegExp(state.text, 'i');
      const hay = [p.name, p.slug, p.repoPath, p.remoteUrl ?? '', (p.tags ?? []).join(' '), p.owner ?? ''].join(' ');
      if (!re.test(hay)) return false;
    } catch {
      const q = state.text.toLowerCase();
      const hay = [p.name, p.slug, p.repoPath, p.remoteUrl ?? '', (p.tags ?? []).join(' '), p.owner ?? ''].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  return true;
}

export function OverviewPage({ onSelect, onOpen }: OverviewPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState('');
  const [weights, setWeights] = useState<RiskWeights>(DEFAULT_RISK_WEIGHTS);
  const [categories, setCategories] = useState<string[] | undefined>();
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const refresh = useCallback(() => {
    listProjects()
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    getSettings()
      .then((s) => {
        if (s.riskWeights) {
          try { setWeights((w) => ({ ...w, ...JSON.parse(s.riskWeights) })); } catch {}
        }
        if (s.categories) {
          try {
            const parsed = JSON.parse(s.categories);
            if (Array.isArray(parsed) && parsed.length > 0) setCategories(parsed);
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [refresh]);

  const filterState = useMemo(() => parseFilter(filter), [filter]);
  const filtered = useMemo(() => projects.filter((p) => matchProject(p, filterState)), [projects, filterState]);

  const tagFacet = useMemo(() => computeFacetCounts(projects, filterState, 'tag',
    (p) => p.tags ?? [], matchProject), [projects, filterState]);
  const ownerFacet = useMemo(() => computeFacetCounts(projects, filterState, 'owner',
    (p) => p.owner ? [p.owner] : [], matchProject), [projects, filterState]);

  function toggleFacet(key: string, value: string, on: boolean) {
    setFilter(buildFilter(withToken(filterState, key, value, on)));
  }

  return (
    <div className="overview-page">
      <div className={`overview-columns${tagFacet.length + ownerFacet.length === 0 ? ' overview-columns--no-facets' : ''}`}>
        <aside className="overview-col-facets">
          <FacetGroup
            title="Tag"
            items={tagFacet}
            selected={filterState.tokens.tag ?? []}
            onToggle={(v, on) => toggleFacet('tag', v, on)}
          />
          <FacetGroup
            title="Owner"
            items={ownerFacet}
            selected={filterState.tokens.owner ?? []}
            onToggle={(v, on) => toggleFacet('owner', v, on)}
          />
        </aside>
        <div className="overview-col-left">
          <ProjectList
            projects={filtered}
            loading={loading}
            weights={weights}
            onSelect={onSelect}
            onOpen={onOpen}
            onRefresh={refresh}
            toolbar={<FilterSearch value={filter} onChange={setFilter} placeholder="Search projects…  tag:auth owner:alice" />}
            countLabel={loading ? undefined : filter ? `${filtered.length} of ${projects.length}` : String(projects.length)}
          />
        </div>
        <div className="overview-col-right">
          <DashboardCards projects={filtered} weights={weights} categories={categories} loading={loading} />
        </div>
      </div>
    </div>
  );
}
