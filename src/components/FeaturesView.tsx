import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { PageSkeleton } from './Skeleton';
import { featuresApi, findingsApi } from '../core/api';
import { useNavList } from '../core/use-nav-list';
import { useEvents } from '../core/use-events';
import { useAnnotationStore } from '../stores/annotation-store';
import { useRepoStore } from '../stores/repo-store';
import { useUIStore } from '../stores/ui-store';
import { FeatureCard } from './FeatureCard';

// The subset of Finding this view needs for count links.
interface FindingLite {
  status: string;
  resolvedCommit?: string;
  features?: string[];
}
import { SearchBox } from './SearchBox';
import { useModal } from '../hooks/useModal';
import { useRegexMatcher } from '../hooks/useRegexSearch';
import { qp, useQueryState, hashQuery, type QuerySchema } from '../core/query-state';
import type { Feature, FeatureKind, FeatureStatus, LineRange } from '../core/types';

const ALL_STATUSES: FeatureStatus[] = ['draft', 'active', 'deprecated', 'removed', 'orphaned'];

type FeaturesTab = 'interfaces' | 'dataflows' | 'dependencies' | 'externalities';
type FeatureSort = 'file' | 'title' | 'created';

const SORT_OPTIONS: { id: FeatureSort; label: string }[] = [
  { id: 'file',    label: 'File' },
  { id: 'title',   label: 'Title' },
  { id: 'created', label: 'Added' },
];

const TABS: { id: FeaturesTab; label: string; kinds: FeatureKind[] }[] = [
  { id: 'interfaces',    label: 'Interfaces',   kinds: ['interface'] },
  { id: 'dataflows',     label: 'Data Flows',   kinds: ['source', 'sink'] },
  { id: 'dependencies',  label: 'Dependencies', kinds: ['dependency'] },
  { id: 'externalities', label: 'Externalities', kinds: ['externality'] },
];

// The tab, sort and search live in the address (#/features?tab=dataflows&sort=file&q=login; see
// query-state.ts). The sort is remembered; the search for this session.
const FEATURES_QUERY: QuerySchema<{ tab: FeaturesTab; sort: FeatureSort; dir: 'asc' | 'desc'; q: string }> = {
  tab: qp.oneOf<FeaturesTab>('tab', TABS.map((t) => t.id), 'interfaces'),
  sort: qp.oneOf<FeatureSort>('sort', SORT_OPTIONS.map((o) => o.id), 'title').remembered(),
  dir: qp.oneOf<'asc' | 'desc'>('order', ['asc', 'desc'], 'asc').remembered(),
  q: qp.string('q').remembered('session'),
};
const FEATURES_URL = hashQuery('/features');
const FEATURES_REMEMBER = { key: 'bench-features-query' };
// The sort was kept in two entries of its own before.
try {
  const sort = localStorage.getItem('bench-features-sort-order');
  const dir = localStorage.getItem('bench-features-sort-dir');
  if ((sort || dir) && localStorage.getItem(FEATURES_REMEMBER.key) == null) {
    localStorage.setItem(FEATURES_REMEMBER.key, [sort && `sort=${sort}`, dir && `order=${dir}`].filter(Boolean).join('&'));
  }
} catch { /* storage unavailable */ }

// Create modal component
interface CreateFeatureModalProps {
  onClose: () => void;
  onCreated: () => void;
  defaultKind?: FeatureKind;
}

const CreateFeatureModal: React.FC<CreateFeatureModalProps> = ({ onClose, onCreated, defaultKind = 'interface' }) => {
  const [kind, setKind] = useState<FeatureKind>(defaultKind);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [operation, setOperation] = useState('');
  const [protocol, setProtocol] = useState('');
  const [direction, setDirection] = useState<'in' | 'out' | ''>('');
  const [tagsInput, setTagsInput] = useState('');
  const [status, setStatus] = useState<FeatureStatus>('draft');
  const [fileId, setFileId] = useState('');
  const [lineStart, setLineStart] = useState('');
  const [lineEnd, setLineEnd] = useState('');
  const [saving, setSaving] = useState(false);

  const currentCommit = useRepoStore((s) => s.currentCommit);
  const selectedFilePath = useRepoStore((s) => s.selectedFilePath);

  // Closing with typed work asks first (same as the workbench quick-add), whether the
  // user pressed Escape or clicked outside: it used to vanish silently on Escape.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = !!(title.trim() || description.trim() || operation.trim() || protocol.trim() || tagsInput.trim());
  const requestClose = () => {
    if (dirty && !confirmDiscard) { setConfirmDiscard(true); return; }
    onClose();
  };
  const modal = useModal<HTMLDivElement>({ label: 'New feature', onClose: requestClose });

  // Pre-fill file from currently open file
  useEffect(() => {
    if (selectedFilePath) setFileId(selectedFilePath);
  }, [selectedFilePath]);

  const handleSave = async () => {
    if (!title.trim() || !currentCommit) return;
    setSaving(true);
    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
    const start = parseInt(lineStart, 10);
    const end = parseInt(lineEnd, 10);
    const lineRange = start > 0 && end > 0 ? { start, end } : undefined;
    try {
      await featuresApi.create({
        kind,
        title: title.trim(),
        description: description.trim() || undefined,
        operation: operation.trim() || undefined,
        protocol: protocol.trim() || undefined,
        direction: (direction || undefined) as 'in' | 'out' | undefined,
        tags,
        status,
        anchor: { fileId: fileId.trim(), commitId: currentCommit, lineRange },
      });
      onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const showProtocol = kind === 'interface' || kind === 'source' || kind === 'sink';
  const showDirection = kind === 'source' || kind === 'sink';

  return (
    <div className="quick-add-overlay" onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div className="quick-add-popover" {...modal.props} onClick={(e) => e.stopPropagation()}>
        <div className="quick-add-popover-header">
          New Feature
          <span className="quick-add-scope">Project</span>
        </div>
        {confirmDiscard && (
          <div className="quick-add-confirm-discard" role="alert">
            <span>You have unsaved input. Discard?</span>
            <div className="quick-add-confirm-actions">
              <button className="finding-delete-yes" autoFocus onClick={onClose}>Discard</button>
              <button className="finding-delete-no" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
            </div>
          </div>
        )}

        <div className="finding-edit-row">
          <label className="finding-edit-label">Kind</label>
          <select aria-label="Kind" className="finding-edit-select" value={kind} onChange={e => setKind(e.target.value as FeatureKind)}>
            <option value="interface">Interface</option>
            <option value="source">Source</option>
            <option value="sink">Sink</option>
            <option value="dependency">Dependency</option>
            <option value="externality">Externality</option>
          </select>
        </div>

        <input
          className="finding-edit-input"
          placeholder={kind === 'interface' ? 'e.g. GET /api/users' : kind === 'dependency' ? 'e.g. stripe-go' : kind === 'externality' ? 'e.g. Invoice sync worker' : 'e.g. User database'}
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave(); }}
          autoFocus
        />

        <textarea
          className="finding-edit-textarea"
          placeholder={kind === 'interface' ? 'Auth requirements, rate limits, request shape…' : kind === 'source' || kind === 'sink' ? 'What data flows, sensitivity (PII, encrypted)…' : kind === 'dependency' ? "What it's used for, why chosen…" : 'What it does, failure behavior, idempotency…'}
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
        />

        {kind === 'interface' && (
          <div className="finding-edit-row">
            <label className="finding-edit-label">Operation</label>
            <input
              className="finding-edit-input-sm"
              placeholder="GET, POST, query, rpc GetUser…"
              value={operation}
              onChange={e => setOperation(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
        )}

        {showProtocol && (
          <div className="finding-edit-row">
            <label className="finding-edit-label">Protocol</label>
            <input
              className="finding-edit-input-sm"
              placeholder="rest, grpc, graphql, kafka…"
              value={protocol}
              onChange={e => setProtocol(e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
        )}

        {showDirection && (
          <div className="finding-edit-row">
            <label className="finding-edit-label">Direction</label>
            <select aria-label="Direction" className="finding-edit-select" value={direction} onChange={e => setDirection(e.target.value as 'in' | 'out' | '')}>
              <option value="">-</option>
              <option value="in">← In (source)</option>
              <option value="out">→ Out (sink)</option>
            </select>
          </div>
        )}

        <div className="finding-edit-row">
          <label className="finding-edit-label">Tags</label>
          <input
            className="finding-edit-input-sm"
            placeholder={kind === 'interface' ? 'auth:jwt, rate-limited, public' : kind === 'source' || kind === 'sink' ? 'pii, encrypted, external' : kind === 'dependency' ? 'vendor, license:mit' : 'writes:db, calls:stripe'}
            value={tagsInput}
            onChange={e => setTagsInput(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        <div className="finding-edit-row">
          <label className="finding-edit-label">Status</label>
          <select aria-label="Status" className="finding-edit-select" value={status} onChange={e => setStatus(e.target.value as FeatureStatus)}>
            {ALL_STATUSES.filter(s => s !== 'orphaned').map(s => (
              <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </div>

        <div className="finding-edit-row">
          <label className="finding-edit-label">File</label>
          <input
            className="finding-edit-input-sm"
            placeholder="src/api/auth.go (optional)"
            value={fileId}
            onChange={e => setFileId(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        <div className="finding-edit-row">
          <label className="finding-edit-label">Lines</label>
          <input
            className="finding-edit-input-sm"
            placeholder="start"
            type="number"
            min="1"
            value={lineStart}
            onChange={e => setLineStart(e.target.value)}
            style={{ width: 64 }}
          />
          <span style={{ padding: '0 4px', color: 'var(--text-muted)' }}>–</span>
          <input
            className="finding-edit-input-sm"
            placeholder="end"
            type="number"
            min="1"
            value={lineEnd}
            onChange={e => setLineEnd(e.target.value)}
            style={{ width: 64 }}
          />
        </div>

        <div className="finding-edit-actions">
          <button className="finding-edit-save" onClick={handleSave} disabled={!title.trim() || saving}>
            {saving ? 'Saving…' : 'Add Feature'}
          </button>
          <button className="finding-edit-cancel" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
};

export const FeaturesView: React.FC = () => {
  const features = useAnnotationStore((s) => s.features);
  const loadFeatures = useAnnotationStore((s) => s.loadFeatures);
  const [allFindings, setAllFindings] = useState<FindingLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [fq, setFq] = useQueryState(FEATURES_QUERY, FEATURES_URL, FEATURES_REMEMBER);
  const { tab: activeTab, sort: sortOrder, dir: sortDir, q: searchQuery } = fq;
  const setActiveTab = (tab: FeaturesTab) => setFq({ tab });
  const setSearchQuery = (q: string) => setFq({ q });
  const { matcher: searchMatcher, isRegexValid } = useRegexMatcher(searchQuery);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('bench-collapsed-features');
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [expandSnippetsTick, setExpandSnippetsTick] = useState(0);
  const [collapseSnippetsTick, setCollapseSnippetsTick] = useState(0);
  const [collapsedSnippetIds, setCollapsedSnippetIds] = useState<Set<string>>(new Set());
  const showCreate = useUIStore((s) => s.showFeatureCreate);
  const setShowCreate = useUIStore((s) => s.setShowFeatureCreate);

  const setScrollTargetLine = useUIStore((s) => s.setScrollTargetLine);
  const setHighlightRange = useUIStore((s) => s.setHighlightRange);

  const refreshFeatures = useCallback(() => {
    findingsApi.list()
      .then((f) => setAllFindings(f as FindingLite[]))
      .catch(() => setAllFindings([]));
    return featuresApi.list().then((f) => loadFeatures(f as Feature[])).catch(() => {});
  }, [loadFeatures]);

  useEffect(() => {
    setLoading(true);
    refreshFeatures().finally(() => setLoading(false));
  }, [refreshFeatures]);

  useEvents('annotations', refreshFeatures);

  useEffect(() => {
    localStorage.setItem('bench-collapsed-features', JSON.stringify([...collapsedIds]));
  }, [collapsedIds]);


  const scrollToRange = useCallback((range?: LineRange) => {
    if (!range) return;
    setScrollTargetLine(range.start);
    setHighlightRange({ start: range.start, end: range.end });
    setTimeout(() => setHighlightRange(null), 3000);
  }, [setScrollTargetLine, setHighlightRange]);

  const navigateToFile = (fileId: string, range?: LineRange, commitId?: string) => {
    if (!fileId) return;
    if (commitId) useRepoStore.getState().selectCommit(commitId);
    scrollToRange(range);
    if (range) useUIStore.getState().setPendingCodeviewLine(range.start);
    useUIStore.getState().setViewMode('browse');
    useUIStore.getState().setPendingNavFocus('codeview');
    useRepoStore.getState().selectFile(fileId);
  };

  const currentTab = TABS.find(t => t.id === activeTab)!;
  const tabFeatures = useMemo(() => {
    let filtered = features.filter(f => currentTab.kinds.includes(f.kind as FeatureKind));
    if (searchMatcher) {
      filtered = filtered.filter(f => searchMatcher(f.title) || searchMatcher(f.description ?? ''));
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortOrder === 'file') {
      return [...filtered].sort((a, b) => {
        const fileA = a.anchor.fileId ?? '';
        const fileB = b.anchor.fileId ?? '';
        if (fileA !== fileB) return fileA.localeCompare(fileB) * dir;
        return ((a.anchor.lineRange?.start ?? 0) - (b.anchor.lineRange?.start ?? 0)) * dir;
      });
    }
    if (sortOrder === 'title') {
      return [...filtered].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) * dir);
    }
    // 'created' - original API order; reverse for desc
    return sortDir === 'desc' ? [...filtered].reverse() : filtered;
  }, [features, currentTab, sortOrder, sortDir, searchMatcher]);

  // Tab counts (all features, for badges)
  const tabCounts = useMemo(() => {
    const counts: Record<FeaturesTab, number> = { interfaces: 0, dataflows: 0, dependencies: 0, externalities: 0 };
    for (const f of features) {
      for (const tab of TABS) {
        if (tab.kinds.includes(f.kind as FeatureKind)) {
          counts[tab.id]++;
          break;
        }
      }
    }
    return counts;
  }, [features]);

  const orphaned = useMemo(() => tabFeatures.filter(f => f.status === 'orphaned'), [tabFeatures]);
  const active = useMemo(() => tabFeatures.filter(f => f.status === 'draft' || f.status === 'active'), [tabFeatures]);
  const other = useMemo(() => tabFeatures.filter(f => f.status !== 'draft' && f.status !== 'active' && f.status !== 'orphaned'), [tabFeatures]);

  const defaultKind = currentTab.kinds[0];

  // Keyboard nav for the features list
  const pendingReplyFocusId = useRef<string | null>(null);
  const { focusedId: navFocusedId, containerRef: navContainerRef, handleKeyDown: navHandleKeyDown, handleFocus: navHandleFocus, handleBlur: navHandleBlur, handlePointerDown: navHandlePointerDown } = useNavList({
    items: tabFeatures,
    getId: f => f.id,
    onSelect: (f) => setCollapsedIds((prev) => {
      const next = new Set(prev);
      const expanding = next.has(f.id);
      if (expanding) {
        next.delete(f.id);
        // Also uncollapse the snippet so it's visible on expand
        try {
          const key = `bench:snippet:${f.id}`;
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.collapsed) {
              parsed.collapsed = false;
              localStorage.setItem(key, JSON.stringify(parsed));
              setExpandSnippetsTick(t => t + 1);
            }
          }
        } catch { /* ignore */ }
      } else {
        next.add(f.id);
      }
      return next;
    }),
    // Enter: expand the card in place; if already expanded, focus the reply textarea.
    // Shift+Enter: jump to the file in Browse.
    onActivate: (f) => {
      const isExpanded = !collapsedIds.has(f.id);
      if (isExpanded) {
        const card = navContainerRef.current?.querySelector(`[data-nav-id="${CSS.escape(f.id)}"]`);
        card?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
        return;
      }
      pendingReplyFocusId.current = f.id;
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.delete(f.id);
        return next;
      });
    },
    onShiftActivate: (f) => navigateToFile(f.anchor.fileId, f.anchor.lineRange ?? undefined, f.anchor.commitId),
  });

  // After expand commits, focus the reply textarea of the newly expanded card.
  useEffect(() => {
    const id = pendingReplyFocusId.current;
    if (!id || collapsedIds.has(id)) return;
    const card = navContainerRef.current?.querySelector(`[data-nav-id="${CSS.escape(id)}"]`);
    card?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    pendingReplyFocusId.current = null;
  }, [collapsedIds, navContainerRef]);

  // Open findings per feature, for the header count links.
  const openFindingsByFeature = useMemo(() => {
    const m = new Map<string, number>();
    for (const fd of allFindings) {
      if (fd.status === 'closed' || fd.resolvedCommit) continue;
      for (const fid of fd.features ?? []) {
        m.set(fid, (m.get(fid) ?? 0) + 1);
      }
    }
    return m;
  }, [allFindings]);

  const renderCard = (f: Feature) => (
    <div key={f.id} data-feature-id={f.id} data-nav-id={f.id} data-nav-focused={navFocusedId === f.id ? 'true' : undefined}>
      <FeatureCard
        feature={f}
        openFindingsCount={openFindingsByFeature.get(f.id) ?? 0}
        isExpanded={!collapsedIds.has(f.id)}
        isNavFocused={navFocusedId === f.id}
        expandSnippetsTick={expandSnippetsTick}
        collapseSnippetsTick={collapseSnippetsTick}
        onSnippetCollapsedChange={(collapsed) => setCollapsedSnippetIds(prev => {
          const next = new Set(prev);
          if (collapsed) next.add(f.id); else next.delete(f.id);
          return next;
        })}
        onToggle={() => setCollapsedIds(prev => {
          const next = new Set(prev);
          if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
          return next;
        })}
        onScrollTo={() => navigateToFile(f.anchor.fileId, f.anchor.lineRange ?? undefined, f.anchor.commitId)}
        allFeatures={features}
      />
    </div>
  );

  if (loading) return <PageSkeleton />;

  const allCardsOpen = tabFeatures.every(f => !collapsedIds.has(f.id));
  const anyCardsOpen = tabFeatures.some(f => !collapsedIds.has(f.id));
  const anySnippetsVisible = tabFeatures.some(f => !collapsedIds.has(f.id) && !collapsedSnippetIds.has(f.id));

  return (
    <div className="features-view">
      <section className="overview-section">
        <div className="findings-title-row">
          <h2 className="overview-section-title">Features</h2>
          <div
            className="activity-kind-toggles"
            tabIndex={0}
            data-nav-area="features-tabs"
            onKeyDown={(e) => {
              const idx = TABS.findIndex(t => t.id === activeTab);
              if (e.key === 'ArrowRight') { e.preventDefault(); setActiveTab(TABS[Math.min(idx + 1, TABS.length - 1)].id); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); setActiveTab(TABS[Math.max(idx - 1, 0)].id); }
            }}
          >
            {TABS.map(tab => (
              <button
                key={tab.id}
                className={`activity-kind-toggle${activeTab === tab.id ? ' activity-kind-toggle-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tabCounts[tab.id] > 0 && (
                  <span className="features-tab-count">{tabCounts[tab.id]}</span>
                )}
                {tab.label}
              </button>
            ))}
          </div>
          <div
            className="features-title-row-right"
            tabIndex={0}
            data-nav-area="features-filter"
            onKeyDown={(e) => {
              const tag = (e.target as HTMLElement).tagName;
              if (tag === 'INPUT' || tag === 'TEXTAREA') return;
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              const container = e.currentTarget;
              const items = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled])'));
              if (items.length === 0) return;
              const idx = items.indexOf(document.activeElement as HTMLElement);
              if (e.key === 'ArrowRight') {
                items[Math.min(idx + 1, items.length - 1)].focus();
              } else if (e.key === 'ArrowLeft') {
                items[Math.max(idx < 0 ? 0 : idx - 1, 0)].focus();
              } else if (e.key === 'Enter' || e.key === ' ') {
                if (idx >= 0) items[idx].click();
                else items[0].focus();
              }
            }}
          >
            <span className="features-sort-label">Sort</span>
            <div className="features-sort-toggle">
              {SORT_OPTIONS.map(opt => {
                const isActive = sortOrder === opt.id;
                return (
                  <button
                    key={opt.id}
                    className={`features-sort-btn${isActive ? ' features-sort-btn-active' : ''}`}
                    onClick={() => {
                      if (isActive) setFq({ dir: sortDir === 'asc' ? 'desc' : 'asc' });
                      else setFq({ sort: opt.id, dir: 'asc' });
                    }}
                  >
                    {opt.label}
                    {isActive ? (
                      sortDir === 'asc' ? (
                        <svg className="features-sort-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 6.5L5 3.5L8 6.5" />
                        </svg>
                      ) : (
                        <svg className="features-sort-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 3.5L5 6.5L8 3.5" />
                        </svg>
                      )
                    ) : (
                      <svg className="features-sort-chevron features-sort-chevron-idle" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 4L5 2L8 4" />
                        <path d="M2 6L5 8L8 6" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Last in the row: expands into the free space (see control-rhythm.css). */}
            <SearchBox value={searchQuery} onChange={setSearchQuery} invalid={!isRegexValid} shortcut={['/']} expand />
          </div>
        </div>
        <div
          ref={navContainerRef}
          tabIndex={0}
          data-nav-area="features-list"
          onKeyDown={navHandleKeyDown}
          onFocus={navHandleFocus}
          onBlur={navHandleBlur}
          onMouseDown={navHandlePointerDown}
        >
        {orphaned.length > 0 && (
          <div className="overview-subsection">
            <h3 className="overview-subsection-title" style={{ color: '#b45309' }}>
              Orphaned ⚠ <span className="overview-subsection-count">{orphaned.length}</span>
            </h3>
            {orphaned.map(renderCard)}
          </div>
        )}

        {active.length > 0 && (
          <div className="overview-subsection">
            {active.map(renderCard)}
          </div>
        )}

        {other.length > 0 && (
          <div className="overview-subsection">
            <h3 className="overview-subsection-title overview-subsection-toggle" style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Inactive <span className="overview-subsection-count">{other.length}</span>
            </h3>
            {other.map(renderCard)}
          </div>
        )}

        {tabFeatures.length === 0 && (
          <div className="overview-empty">
            No {currentTab.label.toLowerCase()} annotated yet
          </div>
        )}
        <div className="feed-new-pill-wrap" data-chrome>
          <button className="feed-new-pill" onClick={() => setShowCreate(true)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            New
          </button>
        </div>
        </div>{/* /features-list nav area */}
      </section>

      {showCreate && (
        <CreateFeatureModal
          defaultKind={defaultKind}
          onClose={() => setShowCreate(false)}
          onCreated={refreshFeatures}
        />
      )}

      {tabFeatures.length > 0 && (
        <div className="view-expand-fabs" role="toolbar" aria-label="Expand or collapse cards" data-chrome>
          <button
            className={`view-expand-fab-btn${allCardsOpen && collapsedSnippetIds.size > 0 ? ' view-expand-fab-btn--active' : allCardsOpen ? ' view-expand-fab-btn--disabled' : ''}`}
            title={allCardsOpen && collapsedSnippetIds.size > 0 ? 'Expand sections' : 'Expand all'}
            onClick={() => {
              if (!allCardsOpen) { setCollapsedIds(new Set()); }
              else { setExpandSnippetsTick(t => t + 1); }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 1L1 1L1 5" />
              <path d="M11 1L15 1L15 5" />
              <path d="M5 15L1 15L1 11" />
              <path d="M11 15L15 15L15 11" />
            </svg>
          </button>
          <button
            className={`view-expand-fab-btn${anyCardsOpen && anySnippetsVisible ? ' view-expand-fab-btn--active' : !anyCardsOpen ? ' view-expand-fab-btn--disabled' : ''}`}
            title={anySnippetsVisible ? 'Collapse sections' : 'Collapse all'}
            onClick={() => {
              if (anyCardsOpen && anySnippetsVisible) { setCollapseSnippetsTick(t => t + 1); }
              else if (anyCardsOpen) { setCollapsedIds(new Set(tabFeatures.map(f => f.id))); }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6L6 6L6 2" />
              <path d="M14 6L10 6L10 2" />
              <path d="M2 10L6 10L6 14" />
              <path d="M14 10L10 10L10 14" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};
