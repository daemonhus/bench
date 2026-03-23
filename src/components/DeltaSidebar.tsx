import React, { useState } from 'react';
import { useBaselineStore } from '../stores/baseline-store';
import { useUIStore } from '../stores/ui-store';
import { useRepoStore } from '../stores/repo-store';

export const DeltaSidebar: React.FC = () => {
  const delta = useBaselineStore((s) => s.delta);
  const [removedExpanded, setRemovedExpanded] = useState(false);

  const navigateToFile = (fileId: string) => {
    useUIStore.getState().setViewMode('browse');
    useRepoStore.getState().selectFile(fileId);
  };

  const changedFiles = delta?.changedFiles ?? [];
  const removedIds = delta?.removedFindingIds ?? [];

  return (
    <div className="delta-sidebar">
      <div className="delta-sidebar-header">
        <span className="delta-sidebar-title">Changed Files</span>
        <span className="overview-section-count">{changedFiles.length}</span>
      </div>
      <div className="delta-sidebar-body">
        {changedFiles.length > 0 ? (
          <ul className="delta-file-list">
            {changedFiles.map((f) => (
              <li key={f.path}>
                <span className="delta-file-stat">
                  {f.added > 0 && <span className="delta-file-added">+{f.added}</span>}
                  {f.deleted > 0 && <span className="delta-file-deleted">-{f.deleted}</span>}
                </span>
                <span
                  className="delta-file-link"
                  onClick={() => navigateToFile(f.path)}
                >{f.path}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="overview-empty">No changed files</div>
        )}

        {removedIds.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3
              className="overview-subsection-title overview-subsection-toggle"
              onClick={() => setRemovedExpanded(!removedExpanded)}
            >
              <span className={`overview-subsection-chevron${removedExpanded ? ' overview-subsection-chevron-open' : ''}`}>&#x25B8;</span>
              Removed Findings
              <span className="overview-subsection-count">{removedIds.length}</span>
            </h3>
            {removedExpanded && (
              <ul className="delta-file-list">
                {removedIds.map((id) => (
                  <li key={id} className="delta-removed-id">{id}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
