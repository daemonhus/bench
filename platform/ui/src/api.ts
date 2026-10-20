export interface ProjectStats {
  findingsTotal: number;
  findingsOpen: number;
  bySeverity: Record<string, number>;
  bySeverityOpen: Record<string, number>;
  byStatus: Record<string, number>;
  byCategory?: Record<string, number>;
  commentsTotal: number;
  commentsOpen: number;
  featuresTotal?: number;
  featuresActive?: number;
}

export interface RiskData {
  latestBaselineAt?: string;
  deltaNewFindings: number;
  commitsSince: number;
  filesChangedSince: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  remoteUrl?: string;
  createdAt: string;
  tags: string[];
  owner: string;
  stats?: ProjectStats;
  riskData?: RiskData;
  /** The default branch's last push (newest commit) and commits over the last `months` months. */
  activity?: { branch: string; lastCommitAt?: string; commits: number; months: number; weekly?: number[] };
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch('/api/platform/projects');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createProject(name: string, repoPath: string): Promise<Project> {
  const res = await fetch('/api/platform/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, repoPath }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateProject(slug: string, fields: { name?: string; repoPath?: string; tags?: string[]; owner?: string }): Promise<Project> {
  const res = await fetch(`/api/platform/projects/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteProject(slug: string): Promise<void> {
  const res = await fetch(`/api/platform/projects/${slug}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await res.text());
}

export interface PlatformBaseline {
  projectSlug: string;
  projectName: string;
  id: string;
  seq: number;
  commitId: string;
  reviewer: string;
  summary: string;
  createdAt: string;
  findingsTotal: number;
  findingsOpen: number;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  byCategory?: Record<string, number>;
  commentsTotal: number;
  commentsOpen: number;
  findingIds: string[];
}

export async function listAllBaselines(): Promise<PlatformBaseline[]> {
  const res = await fetch('/api/platform/baselines');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Project Findings ──

export interface Finding {
  id: string;
  externalId?: string;
  anchor: { fileId: string; commitId: string; lineRange?: { start: number; end: number } };
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  cwe: string;
  cve: string;
  vector: string;
  score: number;
  status: string;
  source: string;
  category?: string;
  createdAt?: string;
  resolvedCommit?: string;
  resolvedAt?: string;
  commentCount?: number;
}

export async function listProjectFindings(slug: string, includeResolved = false): Promise<Finding[]> {
  const res = await fetch(`/api/p/${slug}/api/findings${includeResolved ? '?include_resolved=true' : ''}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── Settings ──

export interface RiskWeights {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  stalenessWeight: number;
  deltaWeight: number;
  /** Per mapped feature: bigger projects have more attack surface. */
  sizeWeight: number;
}

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  critical: 10,
  high: 5,
  medium: 3,
  low: 1,
  info: 0,
  stalenessWeight: 0.5,
  deltaWeight: 2.0,
  sizeWeight: 0.2,
};

export const DEFAULT_CATEGORIES: string[] = [
  'auth', 'authz', 'session', 'injection', 'ssrf', 'crypto', 'data-exposure',
  'input-validation', 'path-traversal', 'deserialization', 'race-condition',
  'config', 'error-handling', 'logging', 'business-logic', 'dependencies',
];

export async function getSettings(): Promise<Record<string, string>> {
  const res = await fetch('/api/platform/settings');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function putSettings(settings: Record<string, string>): Promise<void> {
  const res = await fetch('/api/platform/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(await res.text());
}
