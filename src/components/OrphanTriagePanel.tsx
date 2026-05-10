import React, { useEffect, useMemo, useState } from 'react';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import type { Finding, Comment, Feature } from '../core/types';
import { isOrphaned } from '../core/orphan';
import { AnchorField } from './AnchorField';

interface Props {
  onClose: () => void;
}

type EntityKind = 'finding' | 'feature' | 'comment';

interface AnchorDraft {
  fileId: string;
  lineStart: string;
  lineEnd: string;
}

function shortPath(p: string | undefined): string {
  if (!p) return '—';
  const parts = p.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

export const OrphanTriagePanel: React.FC<Props> = ({ onClose }) => {
  const findings = useAnnotationStore((s) => s.findings);
  const comments = useAnnotationStore((s) => s.comments);
  const features = useAnnotationStore((s) => s.features);
  const updateFinding = useAnnotationStore((s) => s.updateFinding);
  const updateFeature = useAnnotationStore((s) => s.updateFeature);
  const updateComment = useAnnotationStore((s) => s.updateComment);
  const deleteComment = useAnnotationStore((s) => s.deleteComment);
  const currentCommit = useRepoStore((s) => s.currentCommit);

  const orphanedFindings = useMemo(() => findings.filter(isOrphaned), [findings]);
  const orphanedFeatures = useMemo(() => features.filter(isOrphaned), [features]);
  const orphanedComments = useMemo(() => comments.filter(isOrphaned), [comments]);

  const total = orphanedFindings.length + orphanedFeatures.length + orphanedComments.length;

  const [editing, setEditing] = useState<{ kind: EntityKind; id: string } | null>(null);
  const [draft, setDraft] = useState<AnchorDraft>({ fileId: '', lineStart: '', lineEnd: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const keyOf = (kind: EntityKind, id: string) => `${kind}:${id}`;
  const toggleSelected = (kind: EntityKind, id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = keyOf(kind, id);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    orphanedFindings.forEach((f) => keys.push(keyOf('finding', f.id)));
    orphanedFeatures.forEach((f) => keys.push(keyOf('feature', f.id)));
    orphanedComments.forEach((c) => keys.push(keyOf('comment', c.id)));
    return keys;
  }, [orphanedFindings, orphanedFeatures, orphanedComments]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allKeys));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startEdit = (kind: EntityKind, item: Finding | Feature | Comment) => {
    setEditing({ kind, id: item.id });
    setDraft({
      fileId: item.anchor.fileId ?? '',
      lineStart: item.anchor.lineRange?.start?.toString() ?? '',
      lineEnd: item.anchor.lineRange?.end?.toString() ?? '',
    });
  };

  const cancelEdit = () => setEditing(null);

  const saveAnchor = () => {
    if (!editing) return;
    const start = parseInt(draft.lineStart, 10);
    const end = parseInt(draft.lineEnd, 10) || start;
    const fileId = draft.fileId.trim();
    if (!fileId || !start || end < start) return;
    const anchorUpdatedAt = new Date().toISOString();
    if (editing.kind === 'finding') {
      updateFinding(editing.id, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ file_id: fileId, line_start: start, line_end: end, anchor_updated_at: anchorUpdatedAt } as any),
      });
    } else if (editing.kind === 'feature') {
      updateFeature(editing.id, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ file_id: fileId, line_start: start, line_end: end, anchor_updated_at: anchorUpdatedAt } as any),
      });
    } else {
      const c = comments.find((c) => c.id === editing.id);
      if (c) updateComment(c.id, c.text, c.commentType, { fileId, lineStart: start, lineEnd: end });
    }
    setEditing(null);
  };

  const dismiss = (kind: EntityKind, id: string) => {
    if (kind === 'finding') updateFinding(id, { status: 'closed' });
    else if (kind === 'feature') updateFeature(id, { status: 'removed' });
    else deleteComment(id);
  };

  const dismissSelected = () => {
    if (selected.size === 0) return;
    const msg = `Dismiss ${selected.size} orphaned annotation${selected.size === 1 ? '' : 's'}? Findings will be closed, features removed, and comments deleted.`;
    if (!window.confirm(msg)) return;
    for (const key of selected) {
      const sep = key.indexOf(':');
      const kind = key.slice(0, sep) as EntityKind;
      const id = key.slice(sep + 1);
      dismiss(kind, id);
    }
    setSelected(new Set());
  };

  const view = (item: Finding | Feature | Comment) => {
    if (item.anchor.fileId) {
      window.location.hash = `#/browse/${item.anchor.fileId}`;
      onClose();
    }
  };

  const renderRow = (
    kind: EntityKind,
    item: Finding | Feature | Comment,
    title: string,
  ) => {
    const isEditing = editing?.kind === kind && editing.id === item.id;
    const key = keyOf(kind, item.id);
    return (
      <li key={`${kind}-${item.id}`} className="orphan-row">
        <input
          type="checkbox"
          className="orphan-row-check"
          checked={selected.has(key)}
          onChange={() => toggleSelected(kind, item.id)}
        />
        <div className="orphan-row-main">
          <div className="orphan-row-title">{title || '(untitled)'}</div>
          <div className="orphan-row-meta">
            <span className="orphan-row-file">{shortPath(item.anchor.fileId)}</span>
            {item.anchor.lineRange && (
              <span className="orphan-row-lines">
                :{item.anchor.lineRange.start}
                {item.anchor.lineRange.end !== item.anchor.lineRange.start && `–${item.anchor.lineRange.end}`}
              </span>
            )}
          </div>
        </div>
        <div className="orphan-row-actions">
          {!isEditing && (
            <>
              <button className="orphan-action" onClick={() => view(item)}>View</button>
              <button className="orphan-action" onClick={() => startEdit(kind, item)}>Re-anchor</button>
              <button className="orphan-action orphan-action-danger" onClick={() => dismiss(kind, item.id)}>
                Dismiss
              </button>
            </>
          )}
        </div>
        {isEditing && (
          <div className="orphan-row-editor">
            <AnchorField
              fileId={draft.fileId}
              lineStart={draft.lineStart}
              lineEnd={draft.lineEnd}
              onFileIdChange={(v) => setDraft((d) => ({ ...d, fileId: v }))}
              onLineStartChange={(v) => setDraft((d) => ({ ...d, lineStart: v }))}
              onLineEndChange={(v) => setDraft((d) => ({ ...d, lineEnd: v }))}
              commit={currentCommit ?? undefined}
            />
            <div className="orphan-row-editor-actions">
              <button className="orphan-action" onClick={cancelEdit}>Cancel</button>
              <button className="orphan-action orphan-action-primary" onClick={saveAnchor}>Save</button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="orphan-overlay" onClick={onClose}>
      <div className="orphan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="orphan-header">
          <span className="orphan-title">Orphaned annotations</span>
          <span className="orphan-subtitle">{total} item{total === 1 ? '' : 's'}</span>
          <button className="orphan-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>
        {total === 0 ? (
          <div className="orphan-empty">Nothing orphaned. Reconciliation is clean.</div>
        ) : (
          <>
            <div className="orphan-toolbar">
              <label className="orphan-toolbar-check">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                Select all
              </label>
              <button
                className="orphan-action orphan-action-danger"
                disabled={selected.size === 0}
                onClick={dismissSelected}
              >
                Dismiss selected{selected.size > 0 ? ` (${selected.size})` : ''}
              </button>
            </div>
          <div className="orphan-body">
            {orphanedFindings.length > 0 && (
              <section className="orphan-section">
                <h3 className="orphan-section-title">Findings <span className="orphan-section-count">{orphanedFindings.length}</span></h3>
                <ul className="orphan-list">
                  {orphanedFindings.map((f) => renderRow('finding', f, f.title))}
                </ul>
              </section>
            )}
            {orphanedFeatures.length > 0 && (
              <section className="orphan-section">
                <h3 className="orphan-section-title">Features <span className="orphan-section-count">{orphanedFeatures.length}</span></h3>
                <ul className="orphan-list">
                  {orphanedFeatures.map((f) => renderRow('feature', f, f.title))}
                </ul>
              </section>
            )}
            {orphanedComments.length > 0 && (
              <section className="orphan-section">
                <h3 className="orphan-section-title">Comments <span className="orphan-section-count">{orphanedComments.length}</span></h3>
                <ul className="orphan-list">
                  {orphanedComments.map((c) => renderRow('comment', c, c.text.split('\n')[0].slice(0, 80)))}
                </ul>
              </section>
            )}
          </div>
          </>
        )}
      </div>
    </div>
  );
};
