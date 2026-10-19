import { useMemo } from 'react';
import type { Project, RiskWeights } from './api';
import { computeRiskScore } from './risk';
import { Skeleton, SkeletonRows } from '@bench/components/Skeleton';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;


interface DashboardCardsProps {
  projects: Project[];
  /** Still fetching: show skeletons rather than zeros. */
  loading?: boolean;
  weights: RiskWeights;
  categories?: string[];
}

export function DashboardCards({ projects, weights, categories, loading = false }: DashboardCardsProps) {
  const severityTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const sev of SEVERITIES) totals[sev] = 0;
    for (const p of projects) {
      if (!p.stats?.bySeverity) continue;
      for (const sev of SEVERITIES) {
        totals[sev] += p.stats.bySeverity[sev] ?? 0;
      }
    }
    return totals;
  }, [projects]);

  const categoryTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const p of projects) {
      if (!p.stats?.byCategory) continue;
      for (const [cat, count] of Object.entries(p.stats.byCategory)) {
        totals[cat] = (totals[cat] ?? 0) + count;
      }
    }
    const entries = Object.entries(totals);
    if (categories) {
      const order = new Map(categories.map((c, i) => [c, i]));
      entries.sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999));
    } else {
      entries.sort((a, b) => b[1] - a[1]);
    }
    return entries;
  }, [projects, categories]);

  const topProjects = useMemo(() => {
    return projects
      .filter((p) => p.stats)
      .map((p) => ({ project: p, score: computeRiskScore(p, weights) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }, [projects, weights]);

  const findingsTotal = Object.values(severityTotals).reduce((a, b) => a + b, 0);
  const maxScore = topProjects.length > 0 ? topProjects[0].score : 1;

  return (
    <div className="dashboard-cards">
      {/* By Severity */}
      <div className="dashboard-card">
        <div className="dashboard-card-title">
          Findings by Severity
          {!loading && <span className="dashboard-card-total">{findingsTotal}</span>}
        </div>
        {loading ? (
          <div className="skeleton-stack" style={{ gap: 12 }}>
            <Skeleton height={8} />
            <SkeletonRows rows={5} height={13} gap={12} lastWidth="100%" />
          </div>
        ) : findingsTotal === 0 ? (
          <div className="dashboard-empty">No findings</div>
        ) : (
          <>
            <div className="dashboard-bar-stacked">
              {SEVERITIES.map((sev) =>
                severityTotals[sev] > 0 ? (
                  <div
                    key={sev}
                    className={`dashboard-bar-segment severity-${sev}`}
                    style={{ flex: severityTotals[sev] }}
                    title={`${sev}: ${severityTotals[sev]}`}
                  />
                ) : null,
              )}
            </div>
            <div className="dashboard-legend">
              {SEVERITIES.map((sev) => (
                <div key={sev} className="dashboard-row">
                  <span className="dashboard-row-left">
                    <span className={`severity-dot severity-${sev}`} />
                    <span className="dashboard-row-label">{sev}</span>
                  </span>
                  <span className="dashboard-row-value">{severityTotals[sev]}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* By Category */}
      <div className="dashboard-card">
        <div className="dashboard-card-title">Findings by Category</div>
        {loading ? <SkeletonRows rows={5} height={13} gap={12} lastWidth="100%" /> : categoryTotals.length === 0 ? (
          <div className="dashboard-empty">No categories</div>
        ) : (
          <div className="dashboard-legend">
            {categoryTotals.map(([cat, count]) => (
              <div key={cat} className="dashboard-row">
                <span className="dashboard-row-left">
                  <span className="category-dot" style={{ backgroundColor: `var(--category-${cat}, var(--severity-info))` }} />
                  <span className="dashboard-row-label">{cat}</span>
                </span>
                <span className="dashboard-row-value">{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Top Projects by Risk */}
      <div className="dashboard-card">
        <div className="dashboard-card-title">Top Projects by Risk</div>
        {loading ? <SkeletonRows rows={5} height={28} gap={13} lastWidth="100%" /> : <>
        {topProjects.length === 0 ? (
          <div className="dashboard-empty">No projects with findings</div>
        ) : (
          <div className="dashboard-legend">
            {topProjects.map(({ project, score }) => (
              <div key={project.id} className="dashboard-row risk-row">
                <span className="dashboard-row-left">
                  <span className="dashboard-row-label">{project.name}</span>
                </span>
                <span className="risk-score-area">
                  <span className="risk-bar">
                    <span
                      className="risk-bar-fill"
                      style={{ width: `${maxScore > 0 ? (score / maxScore) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="dashboard-row-value">{score}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        </>}
      </div>
    </div>
  );
}
