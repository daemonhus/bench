import React, { useState } from 'react';
import type { CommentType } from '../core/types';
import { COMMENT_TYPE_ICON } from '../core/types';
import { AnchorField } from './AnchorField';

export interface CommentEditorAnchor {
  fileId: string;
  lineStart: number;
  lineEnd: number;
}

interface CommentEditorProps {
  initialText: string;
  initialType?: CommentType;
  showTypeToggle?: boolean;
  /** Show the anchor (file + lines) editor inline. Off by default. */
  showAnchor?: boolean;
  initialAnchor?: CommentEditorAnchor;
  onSave: (
    text: string,
    commentType: CommentType | undefined,
    anchor?: CommentEditorAnchor,
  ) => void;
  onCancel: () => void;
}

export const CommentEditor: React.FC<CommentEditorProps> = ({
  initialText,
  initialType,
  showTypeToggle = true,
  showAnchor = false,
  initialAnchor,
  onSave,
  onCancel,
}) => {
  const [text, setText] = useState(initialText);
  const [type, setType] = useState<CommentType>(initialType ?? '');
  const [anchorFileId, setAnchorFileId] = useState(initialAnchor?.fileId ?? '');
  const [anchorLineStart, setAnchorLineStart] = useState(initialAnchor?.lineStart?.toString() ?? '');
  const [anchorLineEnd, setAnchorLineEnd] = useState(initialAnchor?.lineEnd?.toString() ?? '');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let anchor: CommentEditorAnchor | undefined;
    if (showAnchor) {
      const start = parseInt(anchorLineStart, 10);
      const end = parseInt(anchorLineEnd, 10) || start;
      const fileId = anchorFileId.trim();
      const changed =
        fileId !== (initialAnchor?.fileId ?? '') ||
        start !== (initialAnchor?.lineStart ?? 0) ||
        end !== (initialAnchor?.lineEnd ?? 0);
      if (changed && fileId && start > 0 && end >= start) {
        anchor = { fileId, lineStart: start, lineEnd: end };
      }
    }
    onSave(trimmed, type || undefined, anchor);
  };

  const textarea = (
    <textarea
      className="comment-textarea"
      style={showTypeToggle ? { flex: 1 } : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        if (e.key === 'Escape') onCancel();
      }}
      rows={2}
      autoFocus
    />
  );

  return (
    <div className="comment-card-edit">
      {showTypeToggle ? (
        <div className="comment-type-toggle-row">
          <div className="comment-type-toggle">
            {(['feature', 'improvement', 'question', 'concern'] as const).map((t) => (
              <button
                key={t}
                className={`comment-type-toggle-btn${type === t ? ' active' : ''}`}
                onClick={() => setType(type === t ? '' : t)}
                title={t.charAt(0).toUpperCase() + t.slice(1)}
              >
                {COMMENT_TYPE_ICON[t]}
              </button>
            ))}
          </div>
          {textarea}
        </div>
      ) : (
        textarea
      )}
      {showAnchor && (
        <div className="comment-edit-anchor">
          <div className="comment-edit-anchor-label">Anchor</div>
          <AnchorField
            fileId={anchorFileId}
            lineStart={anchorLineStart}
            lineEnd={anchorLineEnd}
            onFileIdChange={setAnchorFileId}
            onLineStartChange={setAnchorLineStart}
            onLineEndChange={setAnchorLineEnd}
            hidePreview
          />
        </div>
      )}
      <div className="comment-form-actions">
        <button className="comment-btn comment-btn-cancel" onClick={onCancel}>Cancel</button>
        <button
          className="comment-btn comment-btn-submit"
          onClick={submit}
          disabled={!text.trim()}
        >Save</button>
      </div>
    </div>
  );
};
