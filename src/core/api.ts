import type { Finding, Comment, FindingWithPosition, CommentWithPosition, CommitInfo, FileEntry, BranchInfo, GraphCommit, ReconciledHead, JobSnapshot, ReconcileFileStatus, AnnotationPosition, PaginatedResponse, GrepMatch, Baseline, BaselineDelta, Feature, FeatureWithPosition, FeatureKind, FeatureStatus, Ref } from './types';

interface DiffResult {
  raw: string;
  fullContent: string;
}

// Module-level base URL for all API calls.
// Standalone: '' (empty, relative paths). Platform: '/api/p/project-slug'.
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
    return fetchJSON('/api/git/info');
  },
  listCommits(limit = 50): Promise<CommitInfo[]> {
    return fetchJSON(`/api/git/commits?limit=${limit}`);
  },
  listFiles(commitish: string): Promise<FileEntry[]> {
    return fetchJSON(`/api/git/tree/${encodeURIComponent(commitish)}`);
  },
  getFileContent(commitish: string, path: string): Promise<{ content: string }> {
    return fetchJSON(`/api/git/show/${encodeURIComponent(commitish)}/${path}`);
  },
  getDiff(from: string, to: string, path: string): Promise<DiffResult> {
    return fetchJSON(`/api/git/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&path=${encodeURIComponent(path)}`);
  },
  getDiffFiles(from: string, to: string): Promise<string[]> {
    return fetchJSON(`/api/git/diff-files?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },
  listBranches(): Promise<BranchInfo[]> {
    return fetchJSON('/api/git/branches');
  },
  listGraph(limit = 100): Promise<GraphCommit[]> {
    return fetchJSON(`/api/git/graph?limit=${limit}`);
  },
  searchCode(pattern: string, commit?: string, opts?: { path?: string; caseInsensitive?: boolean }): Promise<GrepMatch[]> {
    const params = new URLSearchParams({ pattern });
    if (commit) params.set('commit', commit);
    if (opts?.path) params.set('path', opts.path);
    if (opts?.caseInsensitive) params.set('case_insensitive', 'true');
    return fetchJSON(`/api/git/search?${params}`);
  },
};

export const findingsApi = {
  list(fileId?: string, commit?: string): Promise<(Finding | FindingWithPosition)[]> {
    const params = new URLSearchParams();
    if (fileId) params.set('fileId', fileId);
    if (commit) params.set('commit', commit);
    const q = params.toString() ? `?${params}` : '';
    return fetchJSON(`/api/findings${q}`);
  },
  listPaginated(opts: { fileId?: string; commit?: string; limit: number; offset?: number }): Promise<PaginatedResponse<Finding | FindingWithPosition>> {
    const params = new URLSearchParams();
    if (opts.fileId) params.set('fileId', opts.fileId);
    if (opts.commit) params.set('commit', opts.commit);
    params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return fetchJSON(`/api/findings?${params}`);
  },
  create(finding: Finding): Promise<Finding> {
    return fetchJSON('/api/findings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finding),
    });
  },
  update(id: string, updates: Partial<Finding>): Promise<Finding> {
    return fetchJSON(`/api/findings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/api/findings/${encodeURIComponent(id)}`, {
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
    return fetchJSON(`/api/comments${q}`);
  },
  listPaginated(opts: { fileId?: string; findingId?: string; commit?: string; limit: number; offset?: number }): Promise<PaginatedResponse<Comment | CommentWithPosition>> {
    const params = new URLSearchParams();
    if (opts.fileId) params.set('fileId', opts.fileId);
    if (opts.findingId) params.set('findingId', opts.findingId);
    if (opts.commit) params.set('commit', opts.commit);
    params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return fetchJSON(`/api/comments?${params}`);
  },
  create(comment: Comment): Promise<Comment> {
    return fetchJSON('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comment),
    });
  },
  update(id: string, updates: { text?: string; commentType?: string; resolvedCommit?: string | null }): Promise<void> {
    return fetchJSON(`/api/comments/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/api/comments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

export const featuresApi = {
  list(fileId?: string, kind?: FeatureKind, status?: FeatureStatus, commit?: string): Promise<(Feature | FeatureWithPosition)[]> {
    const params = new URLSearchParams();
    if (fileId) params.set('fileId', fileId);
    if (kind) params.set('kind', kind);
    if (status) params.set('status', status);
    if (commit) params.set('commit', commit);
    const q = params.toString() ? `?${params}` : '';
    return fetchJSON(`/api/features${q}`);
  },
  create(feature: Partial<Feature>): Promise<Feature> {
    return fetchJSON('/api/features', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feature),
    });
  },
  update(id: string, updates: Partial<Feature>): Promise<Feature> {
    return fetchJSON(`/api/features/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/api/features/${encodeURIComponent(id)}`, {
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
    return fetchJSON(`/api/refs${q}`);
  },
  create(ref: Omit<Ref, 'id' | 'createdAt'>): Promise<Ref> {
    return fetchJSON('/api/refs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ref),
    });
  },
  update(id: string, updates: Partial<Pick<Ref, 'provider' | 'url' | 'title'>>): Promise<Ref> {
    return fetchJSON(`/api/refs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/api/refs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

export const reconcileApi = {
  head(): Promise<ReconciledHead> {
    return fetchJSON('/api/reconcile/head');
  },
  start(targetCommit: string, filePaths?: string[]): Promise<JobSnapshot> {
    return fetchJSON('/api/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCommit, filePaths }),
    });
  },
  jobStatus(jobId: string): Promise<JobSnapshot> {
    return fetchJSON(`/api/reconcile/status?jobId=${encodeURIComponent(jobId)}`);
  },
  fileStatus(fileId: string, commit: string): Promise<ReconcileFileStatus> {
    return fetchJSON(`/api/reconcile/status?fileId=${encodeURIComponent(fileId)}&commit=${encodeURIComponent(commit)}`);
  },
  history(type: 'finding' | 'comment', id: string): Promise<{ id: string; type: string; positions: AnnotationPosition[] }> {
    return fetchJSON(`/api/annotations/${type}/${encodeURIComponent(id)}/history`);
  },
};

export const settingsApi = {
  get(): Promise<Record<string, string>> {
    return fetchJSON('/api/settings');
  },
  put(settings: Record<string, string>): Promise<void> {
    return fetchJSON('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  },
};

export const baselinesApi = {
  list(): Promise<Baseline[]> {
    return fetchJSON('/api/baselines');
  },
  latest(): Promise<Baseline | null> {
    return fetchJSON<Baseline>('/api/baselines/latest').catch(() => null);
  },
  create(reviewer?: string, summary?: string, commitId?: string): Promise<Baseline> {
    return fetchJSON('/api/baselines', {
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
    return fetchJSON(`/api/baselines/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
  delete(id: string): Promise<void> {
    return fetchJSON(`/api/baselines/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
  delta(): Promise<BaselineDelta | null> {
    return fetchJSON<BaselineDelta>('/api/baselines/delta').catch(() => null);
  },
  deltaFor(baselineId: string): Promise<BaselineDelta | null> {
    return fetchJSON<BaselineDelta>(`/api/baselines/${encodeURIComponent(baselineId)}/delta`).catch(() => null);
  },
};
