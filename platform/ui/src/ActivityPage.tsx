import { useMemo, useState } from 'react';
import { SearchBox } from '@bench/components/SearchBox';
import { SkeletonRows } from '@bench/components/Skeleton';
import { SelectDropdown } from '@bench/components/SelectDropdown';
import { MultiSelectDropdown } from '@bench/components/MultiSelectDropdown';
import { qp, useQueryState, pathQuery, type QuerySchema } from '@bench/core/query-state';
import { SEVERITY_OPTIONS } from '@bench/core/status-options';
import type { Sev } from './projectInsight';
import { useSearchIndex } from './SearchPage';
import { useSearchComments } from './SearchParts';
import { useSearchContext } from './SearchResultCard';
import { ActivityCard } from './ActivityCard';
import {
  buildFeed, filterFeed, groupByDay, ACTIVITY_KINDS, ACTIVITY_LABEL, SINCE,
  type ActivityFilter, type ActivityKind, type Since,
} from './activityModel';

// Activity across every project: new findings and features, and findings passing their fix
// deadline, newest first and grouped by day: each project's Changes, side by side. Filters
// live in the address (/activity?kinds=finding,sla&severity=critical,high&since=7d).

const SEVS = SEVERITY_OPTIONS.map((s) => s.value as Sev);
const ACTIVITY_QUERY: QuerySchema<ActivityFilter> = {
  kinds: qp.set<ActivityKind>('kinds', ACTIVITY_KINDS),
  projects: qp.only('project'),
  severity: qp.set<Sev>('severity', SEVS),
  since: qp.oneOf<Since>('since', SINCE.map((s) => s.value), '30d').remembered(),
  q: qp.string('q'),
};
const ACTIVITY_URL = pathQuery('/activity');
const ACTIVITY_REMEMBER = { key: 'activity-feed' };
const PAGE = 50;

export function ActivityPage({ onOpen, onOpenFlow }: {
  onOpen: (slug: string, hash?: string) => void;
  onOpenFlow: (id: string) => void;
}) {
  const [filter, setFilter] = useQueryState(ACTIVITY_QUERY, ACTIVITY_URL, ACTIVITY_REMEMBER);
  const { projects, data, flows, loading } = useSearchIndex();
  const comments = useSearchComments(projects, true);
  const ctx = useSearchContext(projects, data, flows, comments);
  const [limit, setLimit] = useState(PAGE);

  const feed = useMemo(() => buildFeed(projects, data, comments), [projects, data, comments]);
  // Counts per kind under the other filters, for the toggles.
  const counts = useMemo(() => {
    const all = filterFeed(feed, { ...filter, kinds: ACTIVITY_KINDS });
    return Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, all.filter((i) => i.kind === k).length])) as Record<ActivityKind, number>;
  }, [feed, filter]);
  const shown = useMemo(() => filterFeed(feed, filter), [feed, filter]);
  const groups = useMemo(() => groupByDay(shown.slice(0, limit)), [shown, limit]);

  const set = (patch: Partial<ActivityFilter>) => { setFilter(patch); setLimit(PAGE); };
  const toggleKind = (k: ActivityKind) => set({ kinds: filter.kinds.includes(k) ? filter.kinds.filter((x) => x !== k) : [...filter.kinds, k] });
  const narrowed = filter.kinds.length < ACTIVITY_KINDS.length || filter.projects !== null || filter.severity.length < SEVS.length;
  const slugs = projects.map((p) => p.slug);
  const period = SINCE.find((s) => s.value === filter.since)!;

  return (
    <div className="search-page activity-page">
      <div className="activity-page-head">
        <h2 className="overview-section-title">Activity</h2>
        {!loading && (
          <span className="activity-page-summary" role="status">
            {shown.length} {shown.length === 1 ? 'item' : 'items'}{filter.since === 'all' ? '' : ` in the ${period.label.toLowerCase()}`}
            {comments === null && ' · loading comments…'}
          </span>
        )}
      </div>

      {/* The Flows page's filter bar: what to show, then the filters and reset, then the search. */}
      <div className="flows-filter-bar activity-filter-bar">
        <div className="activity-kind-toggles" role="group" aria-label="Show">
          {ACTIVITY_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`activity-kind-toggle${filter.kinds.includes(k) ? ' activity-kind-toggle-active' : ''}`}
              aria-pressed={filter.kinds.includes(k)}
              onClick={() => toggleKind(k)}
            >
              {ACTIVITY_LABEL[k]}{!loading && <span className="activity-page-count">{counts[k]}</span>}
            </button>
          ))}
        </div>
        <div className="activity-filters" role="group" aria-label="Activity filters">
          <span className="activity-filters-label">Filter</span>
          <MultiSelectDropdown<string>
            label="Projects"
            options={[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.slug, label: p.name }))}
            selected={new Set(filter.projects ?? slugs)}
            onChange={(next) => set({ projects: next.size === slugs.length ? null : slugs.filter((s) => next.has(s)) })}
          />
          <MultiSelectDropdown<Sev>
            label="Severity"
            options={SEVERITY_OPTIONS.map((s) => ({ value: s.value as Sev, label: s.label, icon: <span className="select-dropdown-dot" style={{ background: s.tone }} aria-hidden="true" /> }))}
            selected={new Set(filter.severity)}
            onChange={(next) => set({ severity: SEVS.filter((s) => next.has(s)) })}
          />
          <SelectDropdown<Since>
            label="Period"
            options={SINCE.map((s) => ({ value: s.value, label: s.label }))}
            value={filter.since}
            onChange={(since) => set({ since })}
          />
          <button
            type="button"
            className={`activity-filter-clear${narrowed ? ' activity-filter-clear-visible' : ''}`}
            onClick={() => set({ kinds: ACTIVITY_KINDS, projects: null, severity: SEVS })}
            title="Reset filters"
            aria-label="Reset filters"
          >&#x2715;</button>
        </div>
        <SearchBox
          value={filter.q}
          onChange={(q) => set({ q })}
          placeholder="Search the feed…"
          ariaLabel="Search the feed"
          shortcut={['/']}
          expand
          className="filter-search activity-search"
        />
      </div>

      <div className="search-page-body">
        {loading && feed.length === 0 ? (
          <SkeletonRows rows={6} height={64} gap={8} lastWidth="100%" />
        ) : shown.length === 0 ? (
          <div className="search-page-empty">
            {feed.length === 0
              ? 'Nothing yet. New findings and features from every project show here as they are recorded.'
              : `Nothing matches${filter.since === 'all' ? '' : ` in the ${period.label.toLowerCase()}`}.`}
          </div>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.label} className="activity-day" aria-label={g.label}>
                <h3 className="home-search-section activity-day-title">{g.label}</h3>
                <ul className="search-page-list">
                  {g.items.map((it) => <ActivityCard key={it.key} item={it} ctx={ctx} onOpen={onOpen} onOpenFlow={onOpenFlow} />)}
                </ul>
              </section>
            ))}
            {shown.length > limit && (
              <button type="button" className="home-more search-page-more" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
