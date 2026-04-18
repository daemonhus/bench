import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useAnnotationStore } from '../stores/annotation-store';
import { RefProviderIcon } from './RefProviderIcon';
import { featuresApi } from '../core/api';
import type { Ref, Feature, FeatureKind } from '../core/types';

interface LinkManageModalProps {
  entityType: 'finding' | 'feature' | 'comment';
  entityId: string;
  refs: Ref[];
  linkedFeatureIds?: string[];
  linkedFeatures?: { id: string; description?: string }[];
  allFeatures?: Feature[];
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

const KIND_COLORS: Record<string, string> = {
  interface:   '#2563eb',
  source:      '#16a34a',
  sink:        '#ea580c',
  dependency:  '#7c3aed',
  externality: '#6b7280',
};

const KIND_LABELS: Record<FeatureKind, string> = {
  interface:   'Interface',
  source:      'Source',
  sink:        'Sink',
  dependency:  'Dependency',
  externality: 'Externality',
};

const METHOD_COLORS: Record<string, string> = {
  GET: '#16a34a', POST: '#2563eb', PUT: '#d97706',
  PATCH: '#7c3aed', DELETE: '#dc2626', HEAD: '#6b7280', OPTIONS: '#6b7280',
};

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function extractMethod(title: string): { method: string; path: string } | null {
  const upper = title.toUpperCase();
  for (const m of HTTP_METHODS) {
    if (upper.startsWith(m + ' ')) return { method: m, path: title.slice(m.length + 1) };
  }
  return null;
}

function featureBadgeAndTitle(f: Feature) {
  const kindColor = KIND_COLORS[f.kind] ?? '#6b7280';
  if (f.kind === 'interface') {
    const op = f.operation?.toUpperCase();
    const parsed = op ? null : extractMethod(f.title);
    const method = op ?? parsed?.method;
    const displayTitle = method ? (op ? f.title : parsed?.path ?? f.title) : f.title;
    const badge = method
      ? <span className="feature-method-badge" style={{ background: METHOD_COLORS[method] ?? kindColor, fontSize: 10 }}>{method}</span>
      : <span className="feature-kind-badge" style={{ background: kindColor, fontSize: 10 }}>{KIND_LABELS[f.kind]}</span>;
    return { badge, title: <code className="feature-endpoint-path" style={{ fontSize: 12 }}>{displayTitle}</code> };
  }
  return {
    badge: <span className="feature-kind-badge" style={{ background: kindColor, fontSize: 10 }}>{KIND_LABELS[f.kind as FeatureKind] ?? f.kind}</span>,
    title: <span style={{ fontSize: 13 }}>{f.title}</span>,
  };
}

function inferProvider(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    for (const [pattern, provider] of DOMAIN_PROVIDER_MAP) {
      if (pattern.test(hostname)) return provider;
    }
  } catch { /* not a valid URL yet */ }
  return 'url';
}

function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (s && !/^https?:\/\//i.test(s)) return `https://${s}`;
  return s;
}

function truncateUrl(url: string, maxLen = 52): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 1) + '…';
}

export const LinkManageModal: React.FC<LinkManageModalProps> = ({
  entityType,
  entityId,
  refs: initialRefs,
  linkedFeatureIds: initialFeatureIds,
  linkedFeatures: initialLinkedFeatures,
  allFeatures: allFeaturesProp,
  onClose,
  onRefsChange,
}) => {
  const addRef = useAnnotationStore((s) => s.addRef);
  const removeRef = useAnnotationStore((s) => s.removeRef);
  const updateRef = useAnnotationStore((s) => s.updateRef);
  const updateFinding = useAnnotationStore((s) => s.updateFinding);
  const updateFeature = useAnnotationStore((s) => s.updateFeature);

  // ---- Refs state ----
  const [localRefs, setLocalRefs] = useState<Ref[]>(initialRefs);
  const [editingRefId, setEditingRefId] = useState<string | null>(null);
  const [editProvider, setEditProvider] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addTitle, setAddTitle] = useState('');

  // ---- Feature links state ----
  const [localFeatureIds, setLocalFeatureIds] = useState<string[]>(initialFeatureIds ?? []);
  const [localLinkedFeatures, setLocalLinkedFeatures] = useState<{ id: string; description: string }[]>(
    (initialLinkedFeatures ?? []).map((lf) => ({ id: lf.id, description: lf.description ?? '' })),
  );
  const [linkSearch, setLinkSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [modalFeatures, setModalFeatures] = useState<Feature[]>(allFeaturesProp ?? []);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [expandedDescIds, setExpandedDescIds] = useState<Set<string>>(
    () => new Set((initialLinkedFeatures ?? []).filter((lf) => lf.description).map((lf) => lf.id)),
  );

  useEffect(() => {
    featuresApi.list().then((f) => setModalFeatures(f as Feature[])).catch(() => {});
  }, []);

  // ---- Ref handlers ----
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

  const handleDeleteRef = (refId: string) => {
    setLocalRefs((prev) => {
      const next = prev.filter((r) => r.id !== refId);
      onRefsChange?.(next);
      return next;
    });
    removeRef(refId, entityType, entityId);
  };

  const handleAddRef = () => {
    if (!addUrl.trim()) return;
    const url = normalizeUrl(addUrl);
    const tempId = `REF-${Date.now()}`;
    const tempRef: Ref = { id: tempId, entityType, entityId, provider: inferProvider(url), url, title: addTitle.trim() || undefined };
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

  // ---- Feature link handlers (immediate-save) ----
  const handleAddFeatureLink = (featId: string) => {
    if (entityType === 'finding') {
      const next = [...localFeatureIds, featId];
      setLocalFeatureIds(next);
      updateFinding(entityId, { features: next } as any);
    } else if (entityType === 'feature') {
      const next = [...localLinkedFeatures, { id: featId, description: '' }];
      setLocalLinkedFeatures(next);
      updateFeature(entityId, { linkedFeatures: next } as any);
    }
    setSelectedIndex(-1);
    searchInputRef.current?.focus();
  };

  const handleRemoveFeatureLink = (featId: string) => {
    if (entityType === 'finding') {
      const next = localFeatureIds.filter((id) => id !== featId);
      setLocalFeatureIds(next);
      updateFinding(entityId, { features: next } as any);
    } else if (entityType === 'feature') {
      const next = localLinkedFeatures.filter((x) => x.id !== featId);
      setLocalLinkedFeatures(next);
      updateFeature(entityId, { linkedFeatures: next } as any);
      setExpandedDescIds((prev) => { const s = new Set(prev); s.delete(featId); return s; });
    }
  };

  const handleDescriptionChange = (featId: string, desc: string) => {
    setLocalLinkedFeatures((prev) => prev.map((x) => x.id === featId ? { ...x, description: desc } : x));
  };

  const handleDescriptionSave = (featId: string) => {
    if (entityType !== 'feature') return;
    // Read current value directly from state at call time
    setLocalLinkedFeatures((prev) => {
      updateFeature(entityId, { linkedFeatures: prev } as any);
      return prev;
    });
  };

  const toggleDesc = (featId: string) => {
    setExpandedDescIds((prev) => {
      const s = new Set(prev);
      if (s.has(featId)) { s.delete(featId); } else { s.add(featId); }
      return s;
    });
  };

  const showFeatureLinks = entityType !== 'comment';

  const linkedIds = entityType === 'finding'
    ? localFeatureIds
    : localLinkedFeatures.map((x) => x.id);

  const searchLower = linkSearch.toLowerCase().trim();

  // Unified picker: linked items always visible, search filters and adds unlinked candidates
  const pickerItems = useMemo((): Array<{ feat: Feature; isLinked: boolean }> => {
    if (!searchLower) {
      return linkedIds
        .map((id) => modalFeatures.find((f) => f.id === id))
        .filter((f): f is Feature => f != null)
        .map((feat) => ({ feat, isLinked: true }));
    }
    const matches = modalFeatures.filter(
      (f) => f.id !== entityId && (
        f.title.toLowerCase().includes(searchLower) ||
        f.kind.toLowerCase().includes(searchLower) ||
        (f.anchor.fileId?.toLowerCase().includes(searchLower)) ||
        (f.description?.toLowerCase().includes(searchLower))
      ),
    );
    const linked = matches.filter((f) => linkedIds.includes(f.id));
    const unlinked = matches.filter((f) => !linkedIds.includes(f.id)).slice(0, 6);
    return [
      ...linked.map((feat) => ({ feat, isLinked: true })),
      ...unlinked.map((feat) => ({ feat, isLinked: false })),
    ];
  }, [searchLower, modalFeatures, linkedIds, entityId]);

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="link-manage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ref-manage-modal-header">
          <span>Links</span>
          <button className="shortcuts-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        <div className="ref-manage-modal-body">
          {showFeatureLinks && (
            <div className="link-manage-section">
              <div className="link-manage-section-title">FEATURE LINKS</div>

              <div className="link-manage-search-wrap">
                <input
                  ref={searchInputRef}
                  className="link-manage-search-input"
                  type="text"
                  placeholder="Search to link a feature…"
                  value={linkSearch}
                  onChange={(e) => { setLinkSearch(e.target.value); setSelectedIndex(-1); }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  onKeyDown={(e) => {
                    if (pickerItems.length === 0) return;
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSelectedIndex((i) => Math.min(i + 1, pickerItems.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSelectedIndex((i) => Math.max(i - 1, 0));
                    } else if (e.key === 'Enter' && selectedIndex >= 0) {
                      e.preventDefault();
                      const item = pickerItems[selectedIndex];
                      if (item.isLinked) handleRemoveFeatureLink(item.feat.id);
                      else handleAddFeatureLink(item.feat.id);
                      setSelectedIndex(-1);
                    }
                  }}
                />
                <div className="link-manage-search-results">
                  {!searchLower && linkedIds.length === 0 && (
                    <div className="link-manage-search-hint">Search to link a feature…</div>
                  )}
                  {searchLower && pickerItems.length === 0 && (
                    <div className="link-manage-search-empty">No features match</div>
                  )}
                  {pickerItems.map((item, idx) => {
                    const { feat, isLinked } = item;
                    const { badge } = featureBadgeAndTitle(feat);
                    const kindColor = KIND_COLORS[feat.kind] ?? '#6b7280';
                    const isSelected = idx === selectedIndex;
                    const desc = isLinked && entityType === 'feature'
                      ? (localLinkedFeatures.find((x) => x.id === feat.id)?.description ?? '')
                      : undefined;
                    const descExpanded = isLinked && expandedDescIds.has(feat.id);
                    const displayDesc = desc || feat.description;
                    const showDivider = idx > 0 && !isLinked && pickerItems[idx - 1].isLinked;
                    return (
                      <React.Fragment key={feat.id}>
                        {showDivider && <div className="link-manage-picker-divider" />}
                        <div
                          className={[
                            'link-manage-result-card',
                            isLinked ? 'link-manage-result-card--linked' : '',
                            isSelected ? 'link-manage-result-card--selected' : '',
                          ].filter(Boolean).join(' ')}
                          style={{ '--result-kind-color': isLinked ? '#16a34a' : kindColor } as React.CSSProperties}
                          onClick={() => isLinked ? handleRemoveFeatureLink(feat.id) : handleAddFeatureLink(feat.id)}
                        >
                          <div className="link-manage-result-header">
                            <span className={`link-manage-state-indicator${isLinked ? ' link-manage-state-indicator--linked' : ''}`}>
                              {isLinked
                                ? <svg width="9" height="9" viewBox="0 0 16 16" fill="white"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
                                : <span style={{ fontSize: 13, lineHeight: 1, color: 'var(--text-muted)' }}>+</span>}
                            </span>
                            {badge}
                            <span className="link-manage-result-title">
                              {feat.kind === 'interface'
                                ? <code className="feature-endpoint-path" style={{ fontSize: 12 }}>{feat.title}</code>
                                : feat.title}
                            </span>
                            {feat.anchor.fileId && (
                              <span className="link-manage-result-file">{feat.anchor.fileId.split('/').pop()}</span>
                            )}
                            {isLinked && entityType === 'feature' && (
                              <button
                                className={`link-manage-desc-toggle${desc ? ' link-manage-desc-toggle--has' : ''}${descExpanded ? ' link-manage-desc-toggle--open' : ''}`}
                                title={descExpanded ? 'Hide note' : 'Add note'}
                                onClick={(e) => { e.stopPropagation(); toggleDesc(feat.id); }}
                              >&#x270E;</button>
                            )}
                            {isLinked && (
                              <button
                                className="link-manage-linked-remove"
                                title="Remove"
                                onClick={(e) => { e.stopPropagation(); handleRemoveFeatureLink(feat.id); }}
                              >&#x2715;</button>
                            )}
                          </div>
                          {displayDesc && !descExpanded && (
                            <p className="link-manage-result-desc">{displayDesc}</p>
                          )}
                          {isLinked && entityType === 'feature' && descExpanded && (
                            <input
                              className="link-manage-desc-input"
                              type="text"
                              placeholder="Add a note about this link…"
                              value={desc ?? ''}
                              onChange={(e) => handleDescriptionChange(feat.id, e.target.value)}
                              onBlur={() => handleDescriptionSave(feat.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { handleDescriptionSave(feat.id); toggleDesc(feat.id); }
                                if (e.key === 'Escape') { toggleDesc(feat.id); }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              autoFocus
                            />
                          )}
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {!searchLower && linkedIds.length > 0 && (
                    <div className="link-manage-search-hint link-manage-search-hint--bottom">Search to add more features…</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {showFeatureLinks && <div className="link-manage-section-divider link-manage-section-sep" />}

          <div className="link-manage-section">
            <div className="link-manage-section-title">EXTERNAL LINKS</div>

            {localRefs.length === 0 && (
              <div className="feature-link-empty">No external links yet</div>
            )}

            {localRefs.map((ref) =>
              editingRefId === ref.id ? (
                <div key={ref.id} className="ref-manage-edit-form">
                  <select className="ref-manage-provider-select" value={editProvider} onChange={(e) => setEditProvider(e.target.value)}>
                    {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                  <input className="ref-manage-input" type="url" placeholder="URL" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} autoFocus />
                  <input
                    className="ref-manage-input"
                    type="text"
                    placeholder="Display label (optional)"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') handleCancelEdit(); }}
                  />
                  <div className="ref-manage-edit-actions">
                    <button className="comment-btn comment-btn-submit" onClick={handleSaveEdit} disabled={!editUrl.trim()}>Save</button>
                    <button className="comment-btn comment-btn-cancel" onClick={handleCancelEdit}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div key={ref.id} className="ref-manage-row">
                  <span className="ref-manage-icon"><RefProviderIcon provider={ref.provider} size={16} /></span>
                  <span className="ref-manage-label" title={ref.url}>{ref.title || truncateUrl(ref.url)}</span>
                  <div className="ref-manage-row-actions">
                    <a href={ref.url} target="_blank" rel="noopener noreferrer" className="ref-manage-open" title="Open in new tab" onClick={(e) => e.stopPropagation()}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/>
                      </svg>
                    </a>
                    <button className="comment-icon-btn" title="Edit" onClick={() => handleStartEdit(ref)}>&#x270E;</button>
                    <button className="comment-icon-btn comment-icon-btn-danger" title="Delete" onClick={() => handleDeleteRef(ref.id)}>&#x2715;</button>
                  </div>
                </div>
              )
            )}

            <div className="link-manage-add-form">
              <input
                className="ref-manage-input"
                type="url"
                placeholder="URL"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && addUrl.trim()) handleAddRef(); }}
              />
              <div className="link-manage-add-row">
                <input
                  className="ref-manage-input"
                  type="text"
                  placeholder="Display label (optional)"
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && addUrl.trim()) handleAddRef(); }}
                />
                <button className="comment-btn comment-btn-submit link-manage-add-btn" onClick={handleAddRef} disabled={!addUrl.trim()}>→</button>
              </div>
            </div>
          </div>
        </div>

        <div className="ref-manage-modal-footer">
          <button className="comment-btn comment-btn-submit" onClick={() => {
            if (entityType === 'feature' && expandedDescIds.size > 0) {
              updateFeature(entityId, { linkedFeatures: localLinkedFeatures } as any);
            }
            onClose();
          }}>Done</button>
        </div>
      </div>
    </div>
  );
};
