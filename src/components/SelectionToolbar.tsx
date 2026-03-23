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

  // Dismiss on click outside (skip if clicking action gutter — drag handler manages state)
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
        </button>
      )}
    </div>
  );
};
