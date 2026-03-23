import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { gitApi } from '../core/api';
import type { GraphCommit, BranchInfo } from '../core/types';

interface Props {
  onConfirm: (commitHash: string) => void;
  onClose: () => void;
  branches: BranchInfo[];
  headCommit: string | null;
  defaultToHead?: boolean;
}

export const SetBaselineModal: React.FC<Props> = ({ onConfirm, onClose, branches, headCommit, defaultToHead = false }) => {
  const [graphCommits, setGraphCommits] = useState<GraphCommit[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    gitApi.listGraph(10000).then(commits => {
      setGraphCommits(commits);
      if (commits.length > 0) {
        setSelectedCommit(defaultToHead
          ? (headCommit ?? commits[0].hash)
          : commits[commits.length - 1].hash
        );
      }
    }).finally(() => setLoading(false));
  }, []);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Filter commits by branch reachability (BFS over parents)
  const filteredCommits = useMemo(() => {
    if (!selectedBranch) return graphCommits;

    const branch = branches.find(b => b.name === selectedBranch);
    if (!branch) return graphCommits;

    const branchHead = graphCommits.find(
      c => c.hash === branch.head || c.hash.startsWith(branch.head)
    );
    if (!branchHead) return graphCommits;

    const commitMap = new Map(graphCommits.map(c => [c.hash, c]));
    const reachable = new Set<string>();
    const queue = [branchHead.hash];
    while (queue.length > 0) {
      const hash = queue.shift()!;
      if (reachable.has(hash)) continue;
      reachable.add(hash);
      const commit = commitMap.get(hash);
      if (commit) {
        for (const parent of commit.parents) {
          if (!reachable.has(parent)) queue.push(parent);
        }
      }
    }
    return graphCommits.filter(c => reachable.has(c.hash));
  }, [graphCommits, selectedBranch, branches]);

  // Auto-select head of chosen branch (or default when cleared)
  useEffect(() => {
    if (!selectedBranch) {
      if (graphCommits.length > 0) {
        setSelectedCommit(defaultToHead
          ? (headCommit ?? graphCommits[0].hash)
          : graphCommits[graphCommits.length - 1].hash
        );
      }
      return;
    }
    const branch = branches.find(b => b.name === selectedBranch);
    if (branch) {
      const match = graphCommits.find(
        c => c.hash === branch.head || c.hash.startsWith(branch.head)
      );
      if (match) setSelectedCommit(match.hash);
    }
  }, [selectedBranch, branches, graphCommits, headCommit]);

  const listRef = useRef<HTMLDivElement>(null);

  // Scroll to the selected commit's position once commits load
  useEffect(() => {
    if (!loading && listRef.current) {
      listRef.current.scrollTop = defaultToHead ? 0 : listRef.current.scrollHeight;
    }
  }, [loading, filteredCommits]);

  const shortDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  return (
    <div className="set-baseline-overlay" onClick={onClose}>
      <div className="set-baseline-modal" onClick={e => e.stopPropagation()}>
        <div className="set-baseline-header">
          <span className="set-baseline-title">Set Baseline</span>
          <button className="shortcuts-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>
        <p className="set-baseline-hint">Select a branch to filter commits, then pick the commit to baseline from. The oldest commit is selected by default.</p>
        <div className="set-baseline-body">
          <div className="set-baseline-branch-row">
            <label>Branch</label>
            <select
              value={selectedBranch ?? ''}
              onChange={e => setSelectedBranch(e.target.value || null)}
            >
              <option value="">All branches</option>
              {branches.map(b => (
                <option key={b.name} value={b.name}>
                  {b.name}{b.isCurrent ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="set-baseline-commit-list" ref={listRef}>
            {loading && <div className="set-baseline-loading">Loading commits...</div>}
            {!loading && filteredCommits.length === 0 && (
              <div className="set-baseline-loading">No commits found</div>
            )}
            {filteredCommits.map(c => (
              <div
                key={c.hash}
                className={`set-baseline-commit-row${c.hash === selectedCommit ? ' selected' : ''}`}
                onClick={() => setSelectedCommit(c.hash)}
              >
                <span className="overview-commit-ref">{c.shortHash}</span>
                {c.hash === headCommit && <span className="commit-head-badge">HEAD</span>}
                {(c.refs ?? []).map(ref => (
                  <span key={ref} className="commit-branch-badge">{ref}</span>
                ))}
                <span className="set-baseline-commit-subject">{c.subject}</span>
                <span className="set-baseline-commit-date">{shortDate(c.date)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="set-baseline-footer">
          <button className="baseline-action-btn" onClick={onClose}>Cancel</button>
          <button
            className="baseline-action-btn baseline-action-btn-primary"
            onClick={() => onConfirm(selectedCommit)}
            disabled={!selectedCommit}
          >
            Set Baseline
          </button>
        </div>
      </div>
    </div>
  );
};
