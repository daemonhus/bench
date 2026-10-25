import { blameAge } from '../core/blame';
import type { CommitInfo } from '../core/types';

/**
 * The commit a code view is on, as a card that opens the history: hash and subject, then who
 * committed it and when. `label` names it in Compare (From / To); `headOf` marks the head of the
 * review branch (or of the branch the address names).
 */
export function CommitButton({ commit, label, headOf, active, expanded, small, onClick }: {
  commit?: CommitInfo;
  label?: string;
  headOf?: string;
  active?: boolean;
  expanded?: boolean;
  small?: boolean;
  onClick: () => void;
}) {
  const date = commit ? new Date(commit.date) : null;
  return (
    <button
      type="button"
      className={`commit-button${small ? ' commit-button-small' : ''}${active ? ' commit-button-active' : ''}`}
      aria-expanded={expanded}
      aria-label={`${label ? `${label} commit` : 'Commit'}: ${commit ? `${commit.shortHash} ${commit.subject}` : 'none chosen'}. Choose from history`}
      onClick={onClick}
    >
      {label && <span className="commit-button-label">{label}</span>}
      {commit ? (
        <span className="commit-button-body">
          <span className="commit-button-line">
            <span className="commit-button-hash">{commit.shortHash}</span>
            <span className="commit-button-subject" title={commit.subject}>{commit.subject}</span>
          </span>
          <span className="commit-button-meta">
            {headOf && (
              <span className="commit-button-head" title={`The head of ${headOf}`}>
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="5" r="1.75" />
                  <path d="M4.5 5.25v5.5M11.5 6.75c0 3-7 2-7 4" />
                </svg>
                <span className="commit-button-head-name">{headOf}</span>
                <span className="sr-only"> (head)</span>
              </span>
            )}
            <span className="commit-button-who">
              {commit.author}{date && !isNaN(date.getTime()) ? ` · ${blameAge(date)} ago` : ''}
            </span>
          </span>
        </span>
      ) : (
        <span className="commit-button-body commit-button-empty">Choose a commit</span>
      )}
      <svg className="commit-button-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={expanded ? 'M2.5 6.5 5 4l2.5 2.5' : 'M2.5 4 5 6.5 7.5 4'} />
      </svg>
    </button>
  );
}
