import type { Finding, Origin, OriginSuggestion, Comment, FindingWithPosition, CommentWithPosition, CommitInfo, FileEntry, BranchInfo, GraphCommit, ActivityBucket, ActivityScale, ReconciledHead, JobSnapshot, ReconcileFileStatus, AnnotationPosition, PaginatedResponse, GrepMatch, Baseline, BaselineDelta, Feature, FeatureWithPosition, FeatureKind, FeatureStatus, Ref, ServiceProfile } from './types';

interface DiffResult {
  raw: string;
  fullContent: string;
}

// Module-level base URL for all API calls.
// The project's REST root, '/api/projects/{slug}'; the paths below are relative to it.
let _baseUrl = '';

/**
 * Set the base URL for all API calls. Called once when WorkbenchView mounts.
 * All stores and direct API consumers use this transparently.
 */
export function setApiBase(base: string) {
  _baseUrl = base;
}

/** Returns the current API base URL. */
export function getApiBase(): string {
  return _baseUrl;
}

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(_baseUrl + path, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const gitApi = {
  getInfo(): Promise<{ name: string; defaultBranch: string; remoteUrl: string }> {
    return fetchJSON('/git/info');
  },
  listCommits(limit = 50): Promise<CommitInfo[]> {
    return fetchJSON(`/git/commits?limit=${limit}`);
  },
  /** Resolve any commitish (including rev^ suffixes) to a concrete commit. */
  resolveCommit(ref: string): Promise<CommitInfo | null> {
    return fetchJSON<CommitInfo[]>(`/git/commits?to_commit=${encodeURIComponent(ref)}&limit=1`)
      .then((list) => list[0] ?? null)
      .catch(() => null);
  },
  listFiles(commitish: string): Promise<FileEntry[]> {
    return fetchJSON(`/git/tree/${encodeURIComponent(commitish)}`);
  },
  getFileContent(commitish: string, path: string): Promise<{ content: string }> {
    return fetchJSON(`/git/show/${encodeURIComponent(commitish)}/${path}`);
  },
  getDiff(from: string, to: string, path: string): Promise<DiffResult> {
    return fetchJSON(`/git/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&path=${encodeURIComponent(path)}`);
  },
  getDiffFiles(from: string, to: string): Promise<string[]> {
    return fetchJSON(`/git/diff-files?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  listBranches(): Promise<BranchInfo[]> {
    return fetchJSON('/git/branches');
  },
  listGraph(limit = 100): Promise<GraphCommit[]> {
    return fetchJSON(`/git/graph?limit=${limit}`);
  },
  activity(scale: ActivityScale = 'week', periods = 52): Promise<ActivityBucket[]> {
    return fetchJSON(`/git/activity?scale=${scale}&periods=${periods}`);
  },
  /** Commits and merges in from..to (from exclusive). */
  rangeStats(from: string, to = 'HEAD'): Promise<{ commits: number; merges: number }> {
    return fetchJSON(`/git/range-stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  searchCode(pattern: string, commit?: string, opts?: { path?: string; caseInsensitive?: boolean }): Promise<GrepMatch[]> {
    const params = new URLSearchParams({ pattern });
    if (commit) params.set('commit', commit);
    if (opts?.path) params.set('path', opts.path);
    if (opts?.caseInsensitive) params.set('case_insensitive', 'true');
    return fetchJSON(`/git/search?${params}`);
  },
};

export const findingsApi = {
  list(fileId?: string, commit?: string, id?: string): Promise<(Finding | FindingWithPosition)[]> {
    const params = new URLSearchParams();
    if (fileId) params.set('fileId', fileId);
    if (commit) params.set('commit', commit);
    if (id) params.set('id', id);
    params.set('include_resolved', 'true');
    return fetchJSON(`/findings?${params}`);
  },
  listPaginated(opts: { fileId?: string; commit?: string; id?: string; limit: number; offset?: number }): Promise<PaginatedResponse<Finding | FindingWithPosition>> {
    const params = new URLSearchParams();
    if (opts.fileId) params.set('fileId', opts.fileId);
    if (opts.commit) params.set('commit', opts.commit);
    if (opts.id) params.set('id', opts.id);
    params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    params.set('include_resolved', 'true');
    return fetchJSON(`/findings?${params}`);
  },
  /** One finding; with `commit`, also its effective position there (effectiveAnchor, confidence). */
  get(id: string, commit?: string): Promise<FindingWithPosition> {
    const q = commit ? `?commit=${encodeURIComponent(commit)}` : '';
    return fetchJSON(`/findings/${encodeURIComponent(id)}${q}`);
  },
  create(finding: Finding): Promise<Finding> {
    return fetchJSON('/findings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finding),
    });
  },
  setOrigin(id: string, origin: Partial<Origin>): Promise<Origin> {
    return fetchJSON(`/findings/${encodeURIComponent(id)}/origin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(origin),
    });
  },
  clearOrigin(id: string): Promise<void> {
    return fetchJSON(`/findings/${encodeURIComponent(id)}/origin`, { method: 'DELETE' });
  },
  suggestOrigin(id: string): Promise<OriginSuggestion> {
    return fetchJSON(`/findings/${encodeURIComponent(id)}/origin/suggest`);
  },
  update(id: string, updates: Partial<Finding>): Promise<Finding> {
    return fetchJSON(`/findings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/findings/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

export const commentsApi = {
  list(fileId?: string, commit?: string, findingId?: string, featureId?: string): Promise<(Comment | CommentWithPosition)[]> {
    const params = new URLSearchParams();
    if (fileId) params.set('fileId', fileId);
    if (findingId) params.set('findingId', findingId);
    if (featureId) params.set('featureId', featureId);
    if (commit) params.set('commit', commit);
    const q = params.toString() ? `?${params}` : '';
    return fetchJSON(`/comments${q}`);
  },
  listPaginated(opts: { fileId?: string; findingId?: string; commit?: string; limit: number; offset?: number }): Promise<PaginatedResponse<Comment | CommentWithPosition>> {
    const params = new URLSearchParams();
    if (opts.fileId) params.set('fileId', opts.fileId);
    if (opts.findingId) params.set('findingId', opts.findingId);
    if (opts.commit) params.set('commit', opts.commit);
    params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return fetchJSON(`/comments?${params}`);
  },
  create(comment: Comment): Promise<Comment> {
    return fetchJSON('/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comment),
    });
  },
  update(id: string, updates: {
    text?: string;
    commentType?: string;
    resolvedCommit?: string | null;
    file_id?: string;
    line_start?: number;
    line_end?: number;
    anchor_updated_at?: string;
  }): Promise<void> {
    return fetchJSON(`/comments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/comments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

export const featuresApi = {
  list(fileId?: string, kind?: FeatureKind, status?: FeatureStatus, commit?: string, linkedTo?: string, id?: string): Promise<(Feature | FeatureWithPosition)[]> {
    const params = new URLSearchParams();
    if (fileId) params.set('fileId', fileId);
    if (kind) params.set('kind', kind);
    if (status) params.set('status', status);
    if (commit) params.set('commit', commit);
    if (linkedTo) params.set('linkedTo', linkedTo);
    if (id) params.set('id', id);
    const q = params.toString() ? `?${params}` : '';
    return fetchJSON(`/features${q}`);
  },
  create(feature: Partial<Feature>): Promise<Feature> {
    return fetchJSON('/features', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feature),
    });
  },
  get(id: string, commit?: string): Promise<FeatureWithPosition> {
    const q = commit ? `?commit=${encodeURIComponent(commit)}` : '';
    return fetchJSON(`/features/${encodeURIComponent(id)}${q}`);
  },
  setOrigin(id: string, origin: Partial<Origin>): Promise<Origin> {
    return fetchJSON(`/features/${encodeURIComponent(id)}/origin`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(origin),
    });
  },
  clearOrigin(id: string): Promise<void> {
    return fetchJSON(`/features/${encodeURIComponent(id)}/origin`, { method: 'DELETE' });
  },
  suggestOrigin(id: string): Promise<OriginSuggestion> {
    return fetchJSON(`/features/${encodeURIComponent(id)}/origin/suggest`);
  },
  update(id: string, updates: Partial<Feature>): Promise<Feature> {
    return fetchJSON(`/features/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/features/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

export const refsApi = {
  list(entityType?: string, entityId?: string, provider?: string): Promise<Ref[]> {
    const params = new URLSearchParams();
    if (entityType) params.set('entityType', entityType);
    if (entityId) params.set('entityId', entityId);
    if (provider) params.set('provider', provider);
    const q = params.toString() ? `?${params}` : '';
    return fetchJSON(`/refs${q}`);
  },
  create(ref: Omit<Ref, 'id' | 'createdAt'>): Promise<Ref> {
    return fetchJSON('/refs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ref),
    });
  },
  update(id: string, updates: Partial<Pick<Ref, 'provider' | 'url' | 'title'>>): Promise<Ref> {
    return fetchJSON(`/refs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/refs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

export const reconcileApi = {
  head(): Promise<ReconciledHead> {
    return fetchJSON('/reconcile/head');
  },
  start(targetCommit: string, filePaths?: string[]): Promise<JobSnapshot> {
    return fetchJSON('/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCommit, filePaths }),
    });
  },
  jobStatus(jobId: string): Promise<JobSnapshot> {
    return fetchJSON(`/reconcile/status?jobId=${encodeURIComponent(jobId)}`);
  },
  fileStatus(fileId: string, commit: string): Promise<ReconcileFileStatus> {
    return fetchJSON(`/reconcile/status?fileId=${encodeURIComponent(fileId)}&commit=${encodeURIComponent(commit)}`);
  },
  history(type: 'finding' | 'comment' | 'feature', id: string): Promise<{ id: string; type: string; positions: AnnotationPosition[] }> {
    return fetchJSON(`/annotations/${type}/${encodeURIComponent(id)}/history`);
  },
};

export const profileApi = {
  get(): Promise<ServiceProfile> {
    return fetchJSON('/profile');
  },
  update(patch: Partial<ServiceProfile>): Promise<ServiceProfile> {
    return fetchJSON('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
};

export const settingsApi = {
  get(): Promise<Record<string, string>> {
    return fetchJSON('/settings');
  },
  put(settings: Record<string, string>): Promise<void> {
    return fetchJSON('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  },
};

export const baselinesApi = {
  list(): Promise<Baseline[]> {
    return fetchJSON('/baselines');
  },
  latest(): Promise<Baseline | null> {
    return fetchJSON<Baseline>('/baselines/latest').catch(() => null);
  },
  create(reviewer?: string, summary?: string, commitId?: string): Promise<Baseline> {
    return fetchJSON('/baselines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewer: reviewer || undefined,
        summary: summary || undefined,
        commitId: commitId || undefined,
      }),
    });
  },
  update(id: string, updates: { reviewer?: string; summary?: string }): Promise<Baseline> {
    return fetchJSON(`/baselines/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/baselines/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
  delta(): Promise<BaselineDelta | null> {
    return fetchJSON<BaselineDelta>('/baselines/delta').catch(() => null);
  },
  deltaFor(baselineId: string): Promise<BaselineDelta | null> {
    return fetchJSON<BaselineDelta>(`/baselines/${encodeURIComponent(baselineId)}/delta`).catch(() => null);
  },
};
