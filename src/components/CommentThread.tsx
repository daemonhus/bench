import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnnotationStore } from '../stores/annotation-store';
import { InlineMarkdown } from '../core/markdown';
import { avatarInitials, avatarColor } from '../core/avatar';
import { isOrphaned } from '../core/orphan';
import { RefProviderIcon } from './RefProviderIcon';
import { RefManageModal } from './RefManageModal';
import { CommentEditor } from './CommentEditor';
import type { Anchor, Comment } from '../core/types';

// A finding's or feature's comments: the thread (edit, delete, web links on each comment) and a
// reply box. Shared by the list cards (collapsed to the latest comment) and the detail pages.

interface CommentThreadProps {
  comments: Comment[];
  /** What a new comment attaches to. */
  target: { anchor: Anchor; findingId?: string; featureId?: string };
  /** Cards: show only the latest comment until expanded. */
  collapse?: boolean;
  /** Cards: a "Comments N" heading above the thread (detail pages title their own card). */
  heading?: boolean;
  placeholder?: string;
  /** Start the reply box with this text (a draft carried from another view). */
  initialReply?: string;
  /** Told about every change to the reply box ('' once sent), e.g. to keep a draft. */
  onReplyChange?: (text: string) => void;
  /** Shown when there are no comments yet (detail pages). */
  emptyText?: string;
}

export function CommentThread({
  comments, target, collapse = false, heading = false, placeholder = 'Reply...', initialReply = '', onReplyChange, emptyText,
}: CommentThreadProps) {
  const addComment = useAnnotationStore((s) => s.addComment);
  const updateComment = useAnnotationStore((s) => s.updateComment);
  const deleteComment = useAnnotationStore((s) => s.deleteComment);
  const [reply, setReply] = useState(initialReply);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [managingRefsId, setManagingRefsId] = useState<string | null>(null);

  const sorted = useMemo(() => [...comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp)), [comments]);
  const hiddenCount = collapse && sorted.length > 1 && !showAll ? sorted.length - 1 : 0;
  const visible = hiddenCount > 0 ? sorted.slice(-1) : sorted;

  const changeReply = (text: string) => { setReply(text); onReplyChange?.(text); };
  const submit = () => {
    const text = reply.trim();
    if (!text) return;
    const owner = target.findingId ?? target.featureId ?? '';
    addComment({
      id: `CMT-${Date.now()}`,
      anchor: { ...target.anchor },
      author: 'you',
      text,
      timestamp: new Date().toISOString(),
      threadId: `T-${owner}`,
      ...(target.findingId ? { findingId: target.findingId } : { featureId: target.featureId }),
    });
    changeReply('');
  };

  const renderComment = (c: Comment) => (
    <div key={c.id} className={`finding-comment${editingId === c.id ? ' finding-comment-editing' : ''}`}>
      <div className="finding-comment-header">
        <span className="comment-avatar" style={{ backgroundColor: avatarColor(c.author) }} aria-hidden="true">{avatarInitials(c.author)}</span>
        <span className="finding-comment-author">{c.author}</span>
        {isOrphaned(c) && (
          <span className="comment-orphan-badge" title="This comment's anchor no longer points to live code">Orphaned</span>
        )}
        <span className="finding-comment-time">
          {new Date(c.timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}{' '}
          {new Date(c.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
        {editingId !== c.id && (
          <div className="comment-card-header-right" style={{ marginLeft: 'auto' }}>
            <button className="comment-icon-btn" onClick={() => setManagingRefsId(c.id)} title="Manage web links">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 10L10 2M10 2H5M10 2v5" />
              </svg>
            </button>
            <button className="comment-icon-btn" onClick={() => setEditingId(c.id)} title="Edit">&#x270E;</button>
            <button className="comment-icon-btn comment-icon-btn-danger" onClick={() => deleteComment(c.id)} title="Delete">&#x2715;</button>
          </div>
        )}
      </div>
      {c.refs && c.refs.length > 0 && editingId !== c.id && (
        <div className="comment-ref-icons">
          {c.refs.map((ref) => (
            <a key={ref.id} href={ref.url} target="_blank" rel="noopener noreferrer" className="ref-icon-link" title={ref.title || ref.url}>
              <RefProviderIcon provider={ref.provider} size={11} />
            </a>
          ))}
        </div>
      )}
      {editingId === c.id ? (
        <CommentEditor
          initialText={c.text}
          showTypeToggle={false}
          showAnchor={isOrphaned(c)}
          initialAnchor={c.anchor.fileId ? {
            fileId: c.anchor.fileId,
            lineStart: c.anchor.lineRange?.start ?? 0,
            lineEnd: c.anchor.lineRange?.end ?? 0,
          } : undefined}
          onSave={(text, _type, anchor) => { updateComment(c.id, text, undefined, anchor); setEditingId(null); }}
          onCancel={() => setEditingId(null)}
        />
      ) : (
        <div className="finding-comment-text"><InlineMarkdown text={c.text} /></div>
      )}
    </div>
  );

  return (
    <div className="finding-comments" onClick={(e) => e.stopPropagation()}>
      {heading && sorted.length > 0 && (
        <div className="feature-params-heading">Comments<span className="section-count-badge">{sorted.length}</span></div>
      )}
      {sorted.length === 0 && emptyText && <div className="fd-muted">{emptyText}</div>}
      {hiddenCount > 0 && (
        <button className="finding-comments-toggle" onClick={() => setShowAll(true)}>
          {hiddenCount} previous {hiddenCount === 1 ? 'comment' : 'comments'}
        </button>
      )}
      {collapse && showAll && sorted.length > 1 && (
        <button className="finding-comments-toggle" onClick={() => setShowAll(false)}>Hide previous comments</button>
      )}
      {visible.map(renderComment)}

      <div className="finding-comment-compose">
        <textarea
          placeholder={placeholder}
          aria-label="Reply"
          value={reply}
          onChange={(e) => changeReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim()) submit();
          }}
          rows={1}
        />
        <button disabled={!reply.trim()} onClick={submit} aria-label="Send reply">&rarr;</button>
      </div>

      {managingRefsId && createPortal(
        <RefManageModal
          entityType="comment"
          entityId={managingRefsId}
          refs={comments.find((c) => c.id === managingRefsId)?.refs ?? []}
          onClose={() => setManagingRefsId(null)}
        />,
        document.body,
      )}
    </div>
  );
}
