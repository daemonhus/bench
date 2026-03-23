// Paginated API response envelope
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// Token for syntax highlighting pipeline
export interface Token {
  type: 'text' | 'syntax' | 'edit' | 'annotation' | 'search-match';
  value?: string;
  children?: Token[];
  className?: string;
  annotationId?: string;
}

// Diff types
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  changes: DiffChange[];
}

export interface DiffChange {
  id: string;
  type: 'insert' | 'delete' | 'normal';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

// Annotations
export interface LineRange {
  start: number;
  end: number;
}

export interface Anchor {
  fileId: string;
  commitId: string;
  lineRange?: LineRange;
}

export interface ResolvedAnchor {
  anchor: Anchor;
  resolvedLines: { start: number; end: number };
  confidence: 'exact' | 'moved' | 'orphaned';
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'draft' | 'open' | 'in-progress' | 'false-positive' | 'accepted' | 'closed';

export const FINDING_CATEGORIES = [
  'auth', 'authz', 'session', 'injection', 'ssrf', 'crypto', 'data-exposure',
  'input-validation', 'path-traversal', 'deserialization', 'race-condition',
  'config', 'error-handling', 'logging', 'business-logic', 'dependencies',
] as const;
export type FindingCategory = typeof FINDING_CATEGORIES[number];

export interface Finding {
  id: string;
  externalId?: string;
  anchor: Anchor;
  severity: Severity;
  title: string;
  description: string;
  cwe: string;
  cve: string;
  vector: string;
  score: number;
  status: FindingStatus;
  source: 'pentest' | 'tool' | 'manual';
  category?: string;
  createdAt?: string;
  resolvedCommit?: string;
  lineHash?: string;
  commentCount?: number;
}

export interface FindingWithPosition extends Finding {
  effectiveAnchor?: Anchor;
  confidence?: 'exact' | 'moved' | 'orphaned';
}

export type CommentType = 'feature' | 'improvement' | 'question' | 'concern' | '';

export const COMMENT_TYPE_ICON: Record<string, string> = {
  feature: '\u2728',      // ✨
  improvement: '\uD83D\uDCA1', // 💡
  question: '\u2753',     // ❓
  concern: '\u26A0\uFE0F',     // ⚠️
};

export const COMMENT_TYPE_LABEL: Record<string, string> = {
  feature: 'Feature',
  improvement: 'Idea',
  question: 'Question',
  concern: 'Concern',
};

export interface Comment {
  id: string;
  anchor: Anchor;
  author: string;
  text: string;
  commentType?: CommentType;
  timestamp: string;
  threadId: string;
  parentId?: string;
  findingId?: string;
  featureId?: string;
  resolvedCommit?: string;
  lineHash?: string;
}

export interface CommentWithPosition extends Comment {
  effectiveAnchor?: Anchor;
  confidence?: 'exact' | 'moved' | 'orphaned';
}

// Browse mode line (full file with interleaved diff)
export interface BrowseLine {
  id: string;
  lineNumber: number | null;  // position in new file (null for deletes)
  oldLineNumber: number | null;
  content: string;
  type: 'normal' | 'insert' | 'delete';
  inHunk: boolean;            // true if within a changed region
}

// UI state types
export type ViewMode = 'browse' | 'diff' | 'delta' | 'findings' | 'features';
// SidebarTab removed — sidebar is now a unified activity stream

// API response types (match Go backend model)
export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface FileEntry {
  path: string;
  type: string;
}

export interface CommentDragState {
  isActive: boolean;
  startLine: number | null;
  endLine: number | null;
  side: 'old' | 'new' | null;
}

// Git graph types
export interface BranchInfo {
  name: string;
  head: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface GraphCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  parents: string[];
  refs: string[];
}

// Reconciliation types
export interface AnnotationPosition {
  annotationId: string;
  annotationType: 'finding' | 'comment' | 'feature';
  commitId: string;
  fileId?: string;
  lineStart?: number;
  lineEnd?: number;
  confidence: 'exact' | 'moved' | 'orphaned';
  createdAt?: string;
}

export interface ReconcileFileStatus {
  fileId: string;
  requestedCommit: string;
  lastReconciledCommit: string;
  isReconciled: boolean;
  commitsAhead: number;
  needsRebase: boolean;
}

export interface UnreconciledFile {
  fileId: string;
  lastReconciledCommit: string;
  commitsAhead: number;
}

export interface ReconciledHead {
  reconciledHead: string | null;
  gitHead: string;
  isFullyReconciled: boolean;
  unreconciled: UnreconciledFile[];
}

export interface ReconcileSummary {
  total: number;
  exact: number;
  moved: number;
  orphaned: number;
  resolved?: number;
}

export interface ReconcileResult {
  filesReconciled: number;
  commitsWalked: number;
  annotations: ReconcileSummary;
  durationMs: number;
}

export interface JobProgress {
  filesTotal: number;
  filesDone: number;
  commitsTotal: number;
  commitsDone: number;
  currentFile: string;
}

export interface JobSnapshot {
  jobId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  targetCommit: string;
  progress: JobProgress;
  result?: ReconcileResult;
  error?: string;
}

// Feature types
export type FeatureKind = 'interface' | 'source' | 'sink' | 'dependency' | 'externality';
export type FeatureStatus = 'draft' | 'active' | 'deprecated' | 'removed' | 'orphaned';

export interface Feature {
  id: string;
  anchor: Anchor;
  kind: FeatureKind;
  title: string;
  description?: string;
  operation?: string;
  direction?: 'in' | 'out';
  protocol?: string;
  status: FeatureStatus;
  tags: string[];
  source?: string;
  createdAt?: string;
  resolvedCommit?: string;
  lineHash?: string;
}

export interface FeatureWithPosition extends Feature {
  effectiveAnchor?: Anchor;
  confidence?: 'exact' | 'moved' | 'orphaned';
}

// Baseline types
export interface Baseline {
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
  featuresTotal?: number;
  featuresActive?: number;
  byKind?: Record<string, number>;
  featureIds?: string[];
}

export interface FileStat {
  path: string;
  added: number;
  deleted: number;
}

export interface BaselineDelta {
  sinceBaseline: Baseline | null;
  headCommit: string;
  newFindings: Finding[];
  removedFindingIds: string[];
  newFeatures?: Feature[];
  removedFeatureIds?: string[];
  changedFiles: FileStat[];
  currentStats: {
    findingsTotal: number;
    findingsOpen: number;
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
    byCategory?: Record<string, number>;
    commentsTotal: number;
    commentsOpen: number;
    featuresTotal?: number;
    featuresActive?: number;
    byKind?: Record<string, number>;
  };
}

// Git grep search result
export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

// Helpers for reconciled annotations — avoids casting to WithPosition variants everywhere

export function getEffectiveLineRange(
  annotation: Finding | Comment | Feature,
): { start: number; end: number } | undefined {
  const withPos = annotation as FindingWithPosition | CommentWithPosition | FeatureWithPosition;
  return withPos.effectiveAnchor?.lineRange ?? annotation.anchor.lineRange;
}

export function getConfidence(
  annotation: Finding | Comment | Feature,
): 'exact' | 'moved' | 'orphaned' | undefined {
  return (annotation as FindingWithPosition | CommentWithPosition | FeatureWithPosition).confidence;
}
