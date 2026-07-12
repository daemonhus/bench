import type { Origin } from '../core/types';
import { avatarInitials, avatarColor } from '../core/avatar';

// ---------------------------------------------------------------------------
// Historical context (origin) display, shared by finding and feature cards:
// a brain icon whose hover card shows how the annotation's subject came to
// be and the git coordinates of its introduction.
// ---------------------------------------------------------------------------

/** updatedAt is always stamped, so presence alone does not mean content. */
export function originHasContent(o?: Origin): o is Origin {
  return !!o && !!(o.explanation || o.introducedCommit || o.introducedDate || o.actor || o.branch);
}

/** Lucide "brain" glyph, sized for inline badges. */
export function OriginIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  );
}

/** Branch flows are stored as "source -> target"; render with a real arrow. */
function branchFlowLabel(branch: string): string {
  return branch.replace(/\s*->\s*/g, ' → ');
}

/** Origin details shown while hovering the brain icon. CSS-driven: the card
 *  is a child of the hover wrapper, so it persists while the pointer is on it. */
export function OriginHover({ origin }: { origin: Origin }) {
  return (
    <span className="origin-hover" onClick={(e) => e.stopPropagation()}>
      <span className="origin-hover-icon" aria-label="Historical context" tabIndex={0}>
        <OriginIcon />
      </span>
      <span className="origin-card" role="tooltip">
        <span className="origin-card-title">Historical context</span>
        {origin.explanation && <span className="origin-card-explanation">{origin.explanation}</span>}
        {(origin.introducedDate || origin.actor || origin.branch || origin.introducedCommit) && (
          <span className="origin-card-meta">
            {origin.introducedDate && (
              <span className="origin-card-row">
                <span className="origin-card-label">Introduced</span>
                {origin.introducedDate.slice(0, 10)}
              </span>
            )}
            {origin.actor && (
              <span className="origin-card-row">
                <span className="origin-card-label">Actor</span>
                <span className="origin-card-actor">
                  <span className="comment-avatar origin-card-avatar" style={{ backgroundColor: avatarColor(origin.actor) }} aria-hidden="true">
                    {avatarInitials(origin.actor)}
                  </span>
                  {origin.actor}
                </span>
              </span>
            )}
            {origin.branch && (
              <span className="origin-card-row">
                <span className="origin-card-label">Branch</span>
                {branchFlowLabel(origin.branch)}
              </span>
            )}
            {origin.introducedCommit && (
              <span className="origin-card-row">
                <span className="origin-card-label">Commit</span>
                <a
                  className="origin-card-commit origin-card-commit-link"
                  href={`#/diff/${origin.introducedCommit}^/${origin.introducedCommit}`}
                  title="Compare this commit with the one before it"
                >
                  {origin.introducedCommit.slice(0, 7)}
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5l5-5M4 3.5h4.5V8" />
                  </svg>
                </a>
              </span>
            )}
          </span>
        )}
      </span>
    </span>
  );
}
