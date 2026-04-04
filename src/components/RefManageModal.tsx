import React, { useState, useCallback } from 'react';
import { useAnnotationStore } from '../stores/annotation-store';
import { RefProviderIcon } from './RefProviderIcon';
import type { Ref } from '../core/types';

interface RefManageModalProps {
  entityType: 'finding' | 'feature' | 'comment';
  entityId: string;
  refs: Ref[];
  onClose: () => void;
  onRefsChange?: (refs: Ref[]) => void;
}

const PROVIDERS = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'jira', label: 'Jira' },
  { value: 'confluence', label: 'Confluence' },
  { value: 'linear', label: 'Linear' },
  { value: 'notion', label: 'Notion' },
  { value: 'slack', label: 'Slack' },
  { value: 'url', label: 'URL' },
];

const DOMAIN_PROVIDER_MAP: [RegExp, string][] = [
  [/github\.com/, 'github'],
  [/gitlab\.com/, 'gitlab'],
  [/atlassian\.net|jira\./, 'jira'],
  [/confluence\./, 'confluence'],
  [/linear\.app/, 'linear'],
  [/notion\.so|notion\.site/, 'notion'],
  [/slack\.com/, 'slack'],
];

function inferProvider(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    for (const [pattern, provider] of DOMAIN_PROVIDER_MAP) {
      if (pattern.test(hostname)) return provider;
    }
  } catch {
    // not a valid URL yet
  }
  return 'url';
}

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (s && !/^https?:\/\//i.test(s)) return `https://${s}`;
  return s;
}

function truncateUrl(url: string, maxLen = 48): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 1) + '…';
}

export const RefManageModal: React.FC<RefManageModalProps> = ({
  entityType,
  entityId,
  refs: initialRefs,
  onClose,
  onRefsChange,
}) => {
  const addRef = useAnnotationStore((s) => s.addRef);
  const removeRef = useAnnotationStore((s) => s.removeRef);
  const updateRef = useAnnotationStore((s) => s.updateRef);

  // Local copy so the modal stays reactive without depending on prop re-renders
  // (parent views often hold their own fetched state, not the annotation store)
  const [localRefs, setLocalRefs] = useState<Ref[]>(initialRefs);

  const [editingRefId, setEditingRefId] = useState<string | null>(null);
  const [editProvider, setEditProvider] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editTitle, setEditTitle] = useState('');

  const [addUrl, setAddUrl] = useState('');
  const [addTitle, setAddTitle] = useState('');

  const handleStartEdit = (ref: Ref) => {
    setEditingRefId(ref.id);
    setEditProvider(ref.provider);
    setEditUrl(ref.url);
    setEditTitle(ref.title ?? '');
  };

  const handleSaveEdit = useCallback(() => {
    if (!editUrl.trim() || !editingRefId) return;
    const updates = { provider: editProvider, url: normalizeUrl(editUrl), title: editTitle.trim() || undefined };
    setLocalRefs((prev) => {
      const next = prev.map((r) => r.id === editingRefId ? { ...r, ...updates } : r);
      onRefsChange?.(next);
      return next;
    });
    updateRef(editingRefId, updates, entityType, entityId);
    setEditingRefId(null);
  }, [editingRefId, editProvider, editUrl, editTitle, entityType, entityId, updateRef, onRefsChange]);

  const handleCancelEdit = () => setEditingRefId(null);

  const handleDelete = (refId: string) => {
    setLocalRefs((prev) => {
      const next = prev.filter((r) => r.id !== refId);
      onRefsChange?.(next);
      return next;
    });
    removeRef(refId, entityType, entityId);
  };

  const handleAdd = () => {
    if (!addUrl.trim()) return;
    const url = normalizeUrl(addUrl);
    const tempId = `REF-${Date.now()}`;
    const tempRef: Ref = {
      id: tempId,
      entityType,
      entityId,
      provider: inferProvider(url),
      url,
      title: addTitle.trim() || undefined,
    };
    setLocalRefs((prev) => {
      const next = [...prev, tempRef];
      onRefsChange?.(next);
      return next;
    });
    addRef(tempRef, (created) => {
      setLocalRefs((prev) => {
        const next = prev.map((r) => r.id === tempId ? created : r);
        onRefsChange?.(next);
        return next;
      });
    });
    setAddUrl('');
    setAddTitle('');
  };

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="ref-manage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ref-manage-modal-header">
          <span>Web Links</span>
          <button className="shortcuts-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        <div className="ref-manage-modal-body">
          {localRefs.length === 0 && (
            <div className="feature-link-empty" style={{ marginBottom: 8 }}>No web links yet</div>
          )}

          {localRefs.map((ref) =>
            editingRefId === ref.id ? (
              <div key={ref.id} className="ref-manage-edit-form">
                <select
                  className="ref-manage-provider-select"
                  value={editProvider}
                  onChange={(e) => setEditProvider(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <input
                  className="ref-manage-input"
                  type="url"
                  placeholder="URL"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  autoFocus
                />
                <input
                  className="ref-manage-input"
                  type="text"
                  placeholder="Display label (optional)"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                />
                <div className="ref-manage-edit-actions">
                  <button className="comment-btn comment-btn-submit" onClick={handleSaveEdit} disabled={!editUrl.trim()}>Save</button>
                  <button className="comment-btn comment-btn-cancel" onClick={handleCancelEdit}>Cancel</button>
                </div>
              </div>
            ) : (
              <div key={ref.id} className="ref-manage-row">
                <span className="ref-manage-icon">
                  <RefProviderIcon provider={ref.provider} size={16} />
                </span>
                <span className="ref-manage-label" title={ref.url}>
                  {ref.title || truncateUrl(ref.url)}
                </span>
                <div className="ref-manage-row-actions">
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ref-manage-open"
                    title="Open in new tab"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/>
                    </svg>
                  </a>
                  <button
                    className="comment-icon-btn"
                    title="Edit"
                    onClick={() => handleStartEdit(ref)}
                  >&#x270E;</button>
                  <button
                    className="comment-icon-btn comment-icon-btn-danger"
                    title="Delete"
                    onClick={() => handleDelete(ref.id)}
                  >&#x2715;</button>
                </div>
              </div>
            )
          )}

          <div className="ref-manage-add-section">
            <div className="feature-link-section-label">Add link</div>
            <div className="ref-manage-add-form">
              <input
                className="ref-manage-input"
                type="url"
                placeholder="URL"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addUrl.trim()) handleAdd();
                }}
              />
              <input
                className="ref-manage-input"
                type="text"
                placeholder="Display label (optional)"
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && addUrl.trim()) handleAdd();
                }}
              />
              <button
                className="comment-btn comment-btn-submit"
                onClick={handleAdd}
                disabled={!addUrl.trim()}
              >Add</button>
            </div>
          </div>
        </div>

        <div className="ref-manage-modal-footer">
          <button className="comment-btn comment-btn-cancel" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
};
