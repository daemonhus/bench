import React from 'react';
import { MultiSelectDropdown } from './MultiSelectDropdown';
import type { Severity, FindingStatus } from '../core/types';

const SEVERITY_OPTIONS: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' },
];

const STATUS_OPTIONS: { value: FindingStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'open', label: 'Open' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'false-positive', label: 'False Positive' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'closed', label: 'Closed' },
];

export const ALL_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const ALL_STATUSES: FindingStatus[] = ['draft', 'open', 'in-progress', 'false-positive', 'accepted', 'closed'];

interface AnnotationFiltersProps {
  severities: Set<Severity>;
  onSeveritiesChange: (next: Set<Severity>) => void;
  statuses?: Set<FindingStatus>;
  onStatusesChange?: (next: Set<FindingStatus>) => void;
  actors: string[];
  selectedActors: Set<string> | null;
  onActorsChange: (next: Set<string> | null) => void;
  hasActiveFilter: boolean;
  onReset: () => void;
}

export const AnnotationFilters: React.FC<AnnotationFiltersProps> = ({
  severities,
  onSeveritiesChange,
  statuses,
  onStatusesChange,
  actors,
  selectedActors,
  onActorsChange,
  hasActiveFilter,
  onReset,
}) => (
  <div className="activity-filters">
    <span className="activity-filters-label">Filter</span>
    <MultiSelectDropdown<Severity>
      label="Severity"
      options={SEVERITY_OPTIONS}
      selected={severities}
      onChange={onSeveritiesChange}
    />
    {statuses && onStatusesChange && (
      <MultiSelectDropdown<FindingStatus>
        label="Status"
        options={STATUS_OPTIONS}
        selected={statuses}
        onChange={onStatusesChange}
      />
    )}
    {actors.length > 0 && (
      <MultiSelectDropdown<string>
        label="Actor"
        options={actors.map((a) => ({ value: a, label: a }))}
        selected={selectedActors ?? new Set(actors)}
        onChange={(next) => onActorsChange(next.size === actors.length ? null : next)}
      />
    )}
    <button
      className={`activity-filter-clear${hasActiveFilter ? ' activity-filter-clear-visible' : ''}`}
      onClick={onReset}
      title="Reset filters"
    >
      &#x2715;
    </button>
  </div>
);
