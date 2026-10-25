import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRepoStore } from '../stores/repo-store';
import type { BranchInfo } from '../core/types';

// Picking a branch remounts the workbench (see branchEpoch); the new picker takes the focus back.
let refocusOnMount = false;

const FILTER_FROM = 8; // branches before the list gets a filter box

function BranchIcon() {
  return (
    <svg className="review-branch-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" /><circle cx="4.5" cy="12.5" r="1.75" /><circle cx="11.5" cy="5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 6.75c0 3-7 2-7 4" />
    </svg>
  );
}

/**
 * The project's review branch, beside the project name: what Browse, Changes, Findings and the
 * rest look at, for everyone on the project. Picking one saves it for the project; an address
 * naming another (?branch=) shows that one, for whoever opens the link, and says so.
 */
export function ReviewBranchPicker() {
  const review = useRepoStore((s) => s.reviewBranch);
  const branches = useRepoStore((s) => s.branches);
  const setReviewBranch = useRepoStore((s) => s.setReviewBranch);
  const followProjectBranch = useRepoStore((s) => s.followProjectBranch);

  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const baseId = useId();

  // The default branch first, then by name.
  const local = useMemo(() => {
    const list = branches.filter((b) => !b.isRemote);
    const def = review?.defaultBranch;
    return [...list.filter((b) => b.name === def), ...list.filter((b) => b.name !== def).sort((a, b) => a.name.localeCompare(b.name))];
  }, [branches, review?.defaultBranch]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? local.filter((b) => b.name.toLowerCase().includes(q)) : local;
  }, [local, filter]);

  useEffect(() => {
    if (refocusOnMount && review) {
      refocusOnMount = false;
      triggerRef.current?.focus();
    }
  }, [review]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // The list hangs from the chip, kept on screen. It lives in a portal, so no scrolling or clipped
  // bar can cut it off.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(340, window.innerWidth - 32);
      setPos({ top: r.bottom + 8, left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setError(null);
    setActive(Math.max(0, local.findIndex((b) => b.name === review?.name)));
    // The filter box when there is one, else the list, takes the keys.
    requestAnimationFrame(() => (filterRef.current ?? listRef.current)?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector(`#${CSS.escape(`${baseId}-opt-${active}`)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, baseId]);

  if (!review) return null;

  const projectBranch = review.saved || review.defaultBranch;
  const close = () => { setOpen(false); triggerRef.current?.focus(); };

  const run = async (change: () => Promise<void>) => {
    setError(null);
    refocusOnMount = true;
    try {
      await change();
      setOpen(false);
    } catch (e) {
      refocusOnMount = false;
      setError(e instanceof Error ? e.message.replace(/^\d+: /, '') : String(e));
    }
  };

  const pick = (b: BranchInfo) => {
    if (b.name === review.name && !review.override) { close(); return; }
    // The default branch is saved as "the default", so the project follows it if it changes.
    run(() => setReviewBranch(b.name === review.defaultBranch ? '' : b.name));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { stop(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { stop(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Home' && e.target === listRef.current) { stop(); setActive(0); }
    else if (e.key === 'End' && e.target === listRef.current) { stop(); setActive(shown.length - 1); }
    else if (e.key === 'Enter') { stop(); if (shown[active]) pick(shown[active]); }
    else if (e.key === 'Escape') { stop(); close(); }
  };

  const title = review.override
    ? `Review branch ${review.name}, from this link (the project reviews ${projectBranch})`
    : `Review branch ${review.name}: what Browse, Changes and Findings look at`;

  // One branch and nothing to explain: it's shown, not offered.
  if (local.length <= 1 && !review.override && !review.missing) {
    return (
      <span className="review-branch review-branch--static" title={title}>
        <BranchIcon /><span className="review-branch-name">{review.name}</span>
      </span>
    );
  }

  return (
    <div className="review-branch" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`review-branch-trigger${review.override ? ' review-branch-trigger--link' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Review branch: ${review.name}${review.override ? ', from this link' : ''}`}
        title={title}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <BranchIcon />
        <span className="review-branch-name">{review.name}</span>
        {review.override && <span className="review-branch-tag">link</span>}
        <svg className="review-branch-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? 'M2.5 6.5 5 4l2.5 2.5' : 'M2.5 4 5 6.5 7.5 4'} />
        </svg>
      </button>

      {open && pos && createPortal(
        <div className="review-branch-popover" role="dialog" aria-label="Branch" ref={popRef}
          style={{ top: pos.top, left: pos.left }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (!popRef.current?.contains(to) && !rootRef.current?.contains(to)) setOpen(false);
          }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
          <div className="review-branch-head">
            <span className="review-branch-heading">Branch</span>
          </div>

          {review.missing && (
            <p className="review-branch-note" role="status">
              <code>{review.missing}</code> no longer exists, so this shows <code>{review.name}</code>.
            </p>
          )}
          {review.override && (
            <div className="review-branch-note">
              <span>This link shows <code>{review.name}</code>; the project reviews <code>{projectBranch}</code>.</span>
              <span className="review-branch-note-actions">
                <button type="button" className="review-branch-action" onClick={() => run(() => setReviewBranch(review.name === review.defaultBranch ? '' : review.name))}>
                  Review {review.name} for everyone
                </button>
                <button type="button" className="review-branch-action" onClick={() => run(followProjectBranch)}>
                  Back to {projectBranch}
                </button>
              </span>
            </div>
          )}

          {local.length >= FILTER_FROM && (
            <input
              ref={filterRef}
              className="review-branch-filter"
              type="text"
              placeholder="Find a branch"
              aria-label="Find a branch"
              aria-controls={`${baseId}-list`}
              aria-activedescendant={shown[active] ? `${baseId}-opt-${active}` : undefined}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
            />
          )}
          <div
            ref={listRef}
            id={`${baseId}-list`}
            className="review-branch-list"
            role="listbox"
            aria-label="Branches"
            tabIndex={local.length >= FILTER_FROM ? -1 : 0}
            aria-activedescendant={local.length < FILTER_FROM && shown[active] ? `${baseId}-opt-${active}` : undefined}
            onKeyDown={onKeyDown}
          >
            {shown.map((b, i) => {
              const selected = b.name === review.name;
              return (
                <div
                  key={b.name}
                  id={`${baseId}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  className={`review-branch-option${selected ? ' review-branch-option--selected' : ''}${i === active ? ' review-branch-option--active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(b)}
                >
                  <span className="review-branch-check" aria-hidden="true" />
                  <span className="review-branch-option-name">{b.name}</span>
                  {b.name === review.defaultBranch && <span className="review-branch-meta">default</span>}
                  {b.isCurrent && <span className="review-branch-meta">checked out</span>}
                  <span className="review-branch-hash">{b.head.slice(0, 7)}</span>
                </div>
              );
            })}
            {shown.length === 0 && <div className="review-branch-empty">No branch matches “{filter}”.</div>}
          </div>
          {error && <p className="review-branch-error" role="alert">{error}</p>}
        </div>,
        document.body,
      )}
    </div>
  );
}
