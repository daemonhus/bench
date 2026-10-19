import type { Project, RiskWeights } from './api';
import { DEFAULT_RISK_WEIGHTS } from './api';

/** Size: the project's mapped features, all of them. */
export function projectSize(project: Project): number {
  return project.stats?.featuresTotal ?? 0;
}

export function computeRiskScore(
  project: Project,
  weights: RiskWeights = DEFAULT_RISK_WEIGHTS,
): number {
  if (!project.stats) return 0;

  const sev = project.stats.bySeverityOpen ?? project.stats.bySeverity ?? {};
  let score =
    (sev['critical'] ?? 0) * weights.critical +
    (sev['high'] ?? 0) * weights.high +
    (sev['medium'] ?? 0) * weights.medium +
    (sev['low'] ?? 0) * weights.low +
    (sev['info'] ?? 0) * weights.info;

  if (project.riskData?.latestBaselineAt) {
    const daysSince =
      (Date.now() - new Date(project.riskData.latestBaselineAt).getTime()) /
      (1000 * 60 * 60 * 24);
    score += weights.stalenessWeight * daysSince;
  }

  if (project.riskData) {
    score += weights.deltaWeight * project.riskData.deltaNewFindings;
  }

  score += (weights.sizeWeight ?? 0) * projectSize(project);

  return Math.min(100, Math.round(score));
}
