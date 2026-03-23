import React, { useState, useRef, useMemo } from 'react';
import { useAnnotationStore } from '../stores/annotation-store';
import type { Finding } from '../core/types';
import { InlineMarkdown } from '../core/markdown';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#2563eb',
  info: '#6b7280',
};

interface InlineFindingCardProps {
  finding: Finding;
}

export const InlineFindingCard: React.FC<InlineFindingCardProps> = ({ finding }) => {
  const [expanded, setExpanded] = useState(false);
  const [showAllComments, setShowAllComments] = useState(false);
  const [replyText, setReplyText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchCommentsForFinding = useAnnotationStore((s) => s.fetchCommentsForFinding);
  const findingComments = useAnnotationStore((s) => s.getCommentsForFinding(finding.id));
  const addComment = useAnnotationStore((s) => s.addComment);

  const color = SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.info;

  const visibleComments = useMemo(() => {
    if (showAllComments || findingComments.length <= 1) return findingComments;
    return findingComments.slice(-1);
  }, [findingComments, showAllComments]);
  const hiddenCount = findingComments.length - visibleComments.length;

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      fetchCommentsForFinding(finding.id);
    }
  };

  const handleSubmit = () => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    addComment({
      id: `CMT-${Date.now()}`,
      anchor: { ...finding.anchor },
      author: 'you',
      text: trimmed,
      timestamp: new Date().toISOString(),
      threadId: `T-${finding.id}`,
      findingId: finding.id,
    });
    setReplyText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className={`inline-finding-card${expanded ? ' inline-finding-card-expanded' : ''}`}
      style={{ borderLeftColor: color, background: `color-mix(in srgb, ${color} 5%, var(--bg-secondary))` }}
    >
      <div className="inline-finding-header" onClick={handleToggle}>
        <span className="inline-finding-bar" style={{ background: color }} />
        <span className="inline-finding-sev" style={{ color }}>
          {finding.severity}
        </span>
        <span className="inline-finding-title">{finding.title}</span>
        <span className={`inline-finding-status inline-finding-status-${finding.status}`}>
          {finding.status}
        </span>
        <span className="inline-finding-chevron">{expanded ? '▴' : '▾'}</span>
      </div>

      {expanded && (
        <div className="inline-finding-body">
          {finding.description && (
            <div className="inline-finding-description">
              <InlineMarkdown text={finding.description} />
            </div>
          )}
          {(finding.cwe || finding.cve || finding.score != null) && (
            <div className="inline-finding-meta-row">
              {finding.cwe && <span className="inline-finding-tag">{finding.cwe}</span>}
              {finding.cve && <span className="inline-finding-tag">{finding.cve}</span>}
              {finding.score != null && (
                <span className="inline-finding-tag">CVSS {finding.score}</span>
              )}
            </div>
          )}
          {findingComments.length > 0 && (
            <div className="inline-finding-comments">
              {hiddenCount > 0 && (
                <button className="inline-finding-show-more" onClick={() => setShowAllComments(true)}>
                  View {hiddenCount} previous {hiddenCount === 1 ? 'comment' : 'comments'}
                </button>
              )}
              {visibleComments.map((c) => (
                <div key={c.id} className="inline-finding-comment">
                  <span className="inline-finding-comment-author">{c.author}</span>
                  <span className="inline-finding-comment-text">{c.text}</span>
                </div>
              ))}
            </div>
          )}
          <div className="inline-finding-reply">
            <textarea
              ref={textareaRef}
              className="comment-textarea inline-finding-textarea"
              placeholder="Add a comment… (⌘↵ to submit)"
              value={replyText}
              rows={2}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="comment-btn comment-btn-submit inline-finding-submit"
              onClick={handleSubmit}
              disabled={!replyText.trim()}
            >
              Comment
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
