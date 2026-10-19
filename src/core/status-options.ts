import type { Severity, FindingStatus, FeatureKind, FeatureStatus } from './types';

// The choices behind every status control (SelectDropdown appearance="tinted"), each with its
// colour, so a finding's severity or a feature's status reads the same on a list card, a detail
// page and anywhere else. Tones are theme tokens, so both themes follow.

export const SEVERITY_OPTIONS: { value: Severity; label: string; tone: string }[] = [
  { value: 'critical', label: 'Critical', tone: 'var(--severity-critical)' },
  { value: 'high', label: 'High', tone: 'var(--severity-high)' },
  { value: 'medium', label: 'Medium', tone: 'var(--severity-medium)' },
  { value: 'low', label: 'Low', tone: 'var(--severity-low)' },
  { value: 'info', label: 'Info', tone: 'var(--severity-info)' },
];

export const FINDING_STATUS_OPTIONS: { value: FindingStatus; label: string; tone: string }[] = [
  { value: 'draft', label: 'Draft', tone: 'var(--status-draft)' },
  { value: 'open', label: 'Open', tone: 'var(--status-open)' },
  { value: 'in-progress', label: 'In Progress', tone: 'var(--status-in-progress)' },
  { value: 'false-positive', label: 'False Positive', tone: 'var(--status-false-positive)' },
  { value: 'accepted', label: 'Accepted', tone: 'var(--status-accepted)' },
  { value: 'closed', label: 'Closed', tone: 'var(--status-closed)' },
];

export const FEATURE_KIND_OPTIONS: { value: FeatureKind; label: string; tone: string }[] = [
  { value: 'interface', label: 'Interface', tone: 'var(--kind-interface)' },
  { value: 'source', label: 'Source', tone: 'var(--kind-source)' },
  { value: 'sink', label: 'Sink', tone: 'var(--kind-sink)' },
  { value: 'dependency', label: 'Dependency', tone: 'var(--kind-dependency)' },
  { value: 'externality', label: 'Externality', tone: 'var(--kind-externality)' },
];

export const FEATURE_STATUS_OPTIONS: { value: FeatureStatus; label: string; tone: string }[] = [
  { value: 'draft', label: 'Draft', tone: 'var(--status-draft)' },
  { value: 'active', label: 'Active', tone: 'var(--status-closed)' },
  { value: 'deprecated', label: 'Deprecated', tone: 'var(--status-in-progress)' },
  { value: 'removed', label: 'Removed', tone: 'var(--status-open)' },
  { value: 'orphaned', label: 'Orphaned', tone: 'var(--severity-high)' },
];

// HTTP methods on interface features: the coloured method badge on feature cards, linked-feature
// badges and the feature page.
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const METHOD_COLORS: Record<string, string> = {
  GET: '#16a34a', POST: '#2563eb', PUT: '#d97706', PATCH: '#7c3aed',
  DELETE: '#dc2626', HEAD: '#6b7280', OPTIONS: '#6b7280',
};
