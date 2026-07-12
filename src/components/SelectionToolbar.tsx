import React, { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../stores/ui-store';
import { useRepoStore } from '../stores/repo-store';
import { useBreakpoint } from '../hooks/useBreakpoint';


/** Convert a git remote URL to a web browse URL, or null if unrecognised. */
function remoteToWebUrl(remote: string): { base: string; type: 'github' | 'gitlab' } | null {
  // SSH: git@github.com:org/repo.git
  const sshMatch = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2];
    const type = host.includes('gitlab') ? 'gitlab' : 'github';
    return { base: `https://${host}/${path}`, type };
  }
  // HTTPS: https://github.com/org/repo.git
  const httpsMatch = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const path = httpsMatch[2];
    const type = host.includes('gitlab') ? 'gitlab' : 'github';
    return { base: `https://${host}/${path}`, type };
  }
  return null;
}

function buildPermalink(
  remote: string,
  commit: string,
  filePath: string,
  startLine: number,
  endLine: number,
): string | null {
  const info = remoteToWebUrl(remote);
  if (!info) return null;

  const { base, type } = info;
  if (type === 'gitlab') {
    const anchor = endLine !== startLine ? `#L${startLine}-${endLine}` : `#L${startLine}`;
    return `${base}/-/blob/${commit}/${filePath}${anchor}`;
  }
  const anchor = endLine !== startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return `${base}/blob/${commit}/${filePath}${anchor}`;
}

interface SelectionToolbarProps {
  startLine: number;
  endLine: number;
  top: number;
}

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({ startLine, endLine, top }) => {
  const setAnnotationAction = useUIStore((s) => s.setAnnotationAction);
  const setCommentDrag = useUIStore((s) => s.setCommentDrag);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const isMobile = useBreakpoint() === 'mobile';

  const remoteUrl = useRepoStore((s) => s.remoteUrl);
  const currentCommit = useRepoStore((s) => s.currentCommit);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);

  // Dismiss on click outside (skip if clicking action gutter - drag handler manages state)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (target.closest('.action-gutter')) return;
        setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
        setAnnotationAction(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [setCommentDrag, setAnnotationAction]);

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCommentDrag({ isActive: false, startLine: null, endLine: null, side: null });
        setAnnotationAction(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setCommentDrag, setAnnotationAction]);

  const handleAction = (action: 'comment' | 'finding' | 'feature') => {
    setAnnotationAction(action);
    if (!isMobile && !sidebarOpen) toggleSidebar();
  };

  // Auto-focus the first button only for keyboard-initiated opens. On mouse
  // open the click event keeps processing after mount and would shift focus
  // off the button, dismissing the toolbar.
  const dragSource = useUIStore((s) => s.commentDrag.source);
  useEffect(() => {
    if (dragSource !== 'keyboard') return;
    const first = toolbarRef.current?.querySelector<HTMLButtonElement>('button');
    first?.focus({ preventScroll: true });
  }, [dragSource]);

  // Intra-toolbar arrow nav. Without stopPropagation, Tab would be captured by
  // App's global nav-area Tab handler and yank focus out of the toolbar.
  const onToolbarKeyDown = (e: React.KeyboardEvent) => {
    const isArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    if (e.key !== 'Tab' && !isArrow) return;
    const root = toolbarRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement as HTMLButtonElement);
    const forward = e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey);
    const next = idx === -1
      ? 0
      : forward
        ? (idx + 1) % focusables.length
        : (idx - 1 + focusables.length) % focusables.length;
    e.preventDefault();
    e.stopPropagation();
    focusables[next].focus();
  };

  const canCopyLink = !!(remoteUrl && currentCommit && selectedFilePath);

  const handleCopyLink = async () => {
    if (!remoteUrl || !currentCommit || !selectedFilePath) return;
    const link = buildPermalink(remoteUrl, currentCommit, selectedFilePath, startLine, endLine);
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      style={{ top }}
      onKeyDown={onToolbarKeyDown}
    >
      <button
        className="selection-toolbar-btn"
        onClick={() => handleAction('comment')}
        title="Add comment"
      >
        {/* Speech bubble */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 2h12v8H9l-3 3v-3H2V2z" />
        </svg>
        <span className="selection-toolbar-label">Comment</span>
      </button>
      <button
        className="selection-toolbar-btn selection-toolbar-btn-finding"
        onClick={() => handleAction('finding')}
        title="Add finding"
      >
        {/* Shield with exclamation */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V4L8 1z" />
          <path d="M8 5v3" />
          <circle cx="8" cy="10.5" r="0.5" fill="currentColor" stroke="none" />
        </svg>
        <span className="selection-toolbar-label">Finding</span>
      </button>
      <button
        className="selection-toolbar-btn selection-toolbar-btn-feature"
        onClick={() => handleAction('feature')}
        title="Add feature"
      >
        {/* Circuit node / feature icon */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
          <circle cx="8" cy="1" r="1" fill="currentColor" stroke="none" />
          <circle cx="8" cy="15" r="1" fill="currentColor" stroke="none" />
          <circle cx="1" cy="8" r="1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="8" r="1" fill="currentColor" stroke="none" />
        </svg>
        <span className="selection-toolbar-label">Feature</span>
      </button>
      {canCopyLink && (
        <button
          className="selection-toolbar-btn"
          onClick={handleCopyLink}
          title={copied ? 'Copied!' : 'Copy link to source'}
        >
          {copied ? (
            /* Checkmark */
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8.5l3.5 3.5 6.5-8" />
            </svg>
          ) : (
            /* Link icon */
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 9.5a3.5 3.5 0 005 0l2-2a3.5 3.5 0 00-5-5l-1 1" />
              <path d="M9.5 6.5a3.5 3.5 0 00-5 0l-2 2a3.5 3.5 0 005 5l1-1" />
            </svg>
          )}
          <span className="selection-toolbar-label">{copied ? 'Copied' : 'Link'}</span>
        </button>
      )}
    </div>
  );
};
