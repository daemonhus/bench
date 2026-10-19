import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { featuresApi, reconcileApi, refsApi } from '../core/api';
import { useWorkbenchExtensions } from '../core/extensions';
import { useAnnotationStore } from '../stores/annotation-store';
import { PageSkeleton } from './Skeleton';
import { SelectDropdown } from './SelectDropdown';
import { FEATURE_KIND_OPTIONS, FEATURE_STATUS_OPTIONS, METHOD_COLORS } from '../core/status-options';
import { EditableText, SaveIndicator, useSaveTracker } from './EditableText';
import { TagInput } from './TagInput';
import { LinkManageModal } from './LinkManageModal';
import { CommentThread } from './CommentThread';
import { RefProviderIcon } from './RefProviderIcon';
import { OriginCard } from './OriginCard';
import { LocationField, type LocationChange } from './LocationField';
import type {
  Feature, FeatureWithPosition, FeatureKind, FeatureStatus, FeatureParameter, AnnotationPosition, Origin, Ref,
} from '../core/types';

// The feature's own page. Like the flow page, everything is editable in place and saves as soon
// as a field is left; positions and history come from the reconciler and are read-only.

// ── Visual maps (mirror FeatureCard) ───────────────────────────────────────

const DIRECTIONS: { value: '' | 'in' | 'out'; label: string }[] = [
  { value: '', label: 'No direction' },
  { value: 'in', label: '← In' },
  { value: 'out', label: '→ Out' },
];
const PARAM_TYPES: { value: string; label: string }[] = [
  { value: '', label: 'type' },
  ...['string', 'integer', 'number', 'boolean', 'object', 'array', 'file'].map((t) => ({ value: t, label: t })),
];
/** Reconciliation rows shown before "Show all": the newest positions matter most. */
const RECON_SHOWN = 5;
const CONFIDENCE_COLORS: Record<string, string> = {
  exact: '#16a34a', moved: '#d97706', orphaned: '#dc2626',
};

function short(commit: string | undefined): string {
  return commit ? commit.slice(0, 7) : '';
}
function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

type ParamDraft = { key: string; id?: string; name: string; type: string; required: boolean; description: string; pattern: string };
let draftSeq = 0;
const toDrafts = (ps: FeatureParameter[] | undefined): ParamDraft[] =>
  (ps ?? []).map((p) => ({ key: p.id || `d${draftSeq++}`, id: p.id, name: p.name, type: p.type ?? '', required: p.required, description: p.description ?? '', pattern: p.pattern ?? '' }));

// ── Component ───────────────────────────────────────────────────────────────

interface Props {
  featureId: string;
  onBack: () => void;
}

export function FeatureDetailView({ featureId, onBack }: Props) {
  const extensions = useWorkbenchExtensions();
  const [feature, setFeature] = useState<FeatureWithPosition | null>(null);
  // Comments come from the annotation store, shared with the list cards, so a reply here shows there.
  const allComments = useAnnotationStore((s) => s.comments);
  const comments = useMemo(() => allComments.filter((c) => c.featureId === featureId), [allComments, featureId]);
  const [history, setHistory] = useState<AnnotationPosition[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [params, setParams] = useState<ParamDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkedLabels, setLinkedLabels] = useState<Record<string, string>>({});
  const [managingLinks, setManagingLinks] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const { saving, savedAt, error: saveError, withSave } = useSaveTracker();
  const allTags = useAnnotationStore((s) => s.features);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback((quiet = false) => {
    let cancelled = false;
    if (!quiet) { setLoading(true); setError(null); }
    Promise.all([
      featuresApi.get(featureId, 'HEAD'),
      useAnnotationStore.getState().fetchCommentsForFeature(featureId).catch(() => {}),
      reconcileApi.history('feature', featureId).then((r) => r.positions).catch(() => []),
      refsApi.list('feature', featureId).catch(() => []),
    ])
      .then(([f, , h, r]) => {
        if (cancelled) return;
        setFeature(f as FeatureWithPosition);
        setParams(toDrafts((f as FeatureWithPosition).parameters));
        setHistory(h as AnnotationPosition[]);
        setRefs(r as Ref[]);
      })
      .catch((e: unknown) => {
        if (!cancelled && !quiet) setError(e instanceof Error ? e.message : 'Failed to load feature');
      })
      .finally(() => { if (!cancelled && !quiet) setLoading(false); });
    return () => { cancelled = true; };
  }, [featureId]);

  useEffect(() => load(), [load]);

  // Arriving on a feature (deep link, card title, linked-feature click) leaves
  // focus on <body> because the previous control unmounted. Anchor it here.
  const ready = !loading && !!feature;
  useEffect(() => {
    if (ready) rootRef.current?.focus({ preventScroll: true });
  }, [ready, featureId]);

  // Resolve linked-feature titles so the list reads as names, not raw ids.
  const linkedIds = (feature?.linkedFeatures ?? []).map((l) => l.id).join(',');
  useEffect(() => {
    if (!linkedIds) { setLinkedLabels({}); return; }
    let cancelled = false;
    Promise.all(linkedIds.split(',').map((id) =>
      featuresApi.get(id).then((lf) => [id, [lf.operation, lf.title].filter(Boolean).join(' ')] as const).catch(() => null),
    )).then((pairs) => {
      if (cancelled) return;
      setLinkedLabels(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null)));
    });
    return () => { cancelled = true; };
  }, [linkedIds]);

  // Apply a change at once, save it, and put it back if the save fails. A cleared field is sent
  // as '' (undefined would drop out of the JSON and leave the old value). The workbench's lists
  // share the annotation store, so it is updated too.
  const patch = useCallback((updates: Partial<Feature>) => {
    if (!feature) return;
    const before = feature;
    setFeature({ ...feature, ...updates });
    useAnnotationStore.setState((s) => ({ features: s.features.map((x) => (x.id === feature.id ? { ...x, ...updates } : x)) }));
    withSave(() => featuresApi.update(feature.id, updates)).catch(() => setFeature(before));
  }, [feature, withSave]);

  // Correcting where it points: save, then reload for the new tracked position and history.
  const move = useCallback((change: LocationChange) => {
    if (!feature) return;
    withSave(() => featuresApi.update(feature.id, change as unknown as Partial<Feature>)).then(() => load(true)).catch(() => {});
  }, [feature, withSave, load]);

  const patchOrigin = useCallback((updates: Partial<Origin>) => {
    if (!feature) return;
    const before = feature;
    const origin = { ...(feature.origin ?? {}), ...updates };
    setFeature({ ...feature, origin });
    withSave(() => featuresApi.setOrigin(feature.id, origin)).catch(() => setFeature(before));
  }, [feature, withSave]);

  // Parameters save as a whole list; a row without a name stays a draft on the page until named.
  const saveParams = useCallback((next: ParamDraft[]) => {
    if (!feature) return;
    setParams(next);
    const parameters = next
      .filter((p) => p.name.trim())
      .map((p) => ({
        id: p.id ?? '', featureId: feature.id, name: p.name.trim(), type: p.type || undefined, required: p.required,
        description: p.description.trim() || undefined, pattern: p.pattern.trim() || undefined,
      } as FeatureParameter));
    withSave(() => featuresApi.update(feature.id, { parameters })).catch(() => setParams(toDrafts(feature.parameters)));
  }, [feature, withSave]);
  const setParam = (key: string, change: Partial<ParamDraft>) =>
    saveParams(params.map((p) => (p.key === key ? { ...p, ...change } : p)));

  if (loading) return <PageSkeleton label="Loading feature" cards={3} cardHeight={120} />;
  if (error || !feature) {
    return (
      <div className="feature-detail">
        <div className="fd-inner">
          <button className="fd-back" onClick={onBack}>← Features</button>
          <div className="empty-state">{error ?? 'Feature not found.'}</div>
        </div>
      </div>
    );
  }

  const f = feature;
  const linked = f.linkedFeatures ?? [];
  const eff = f.effectiveAnchor ?? f.anchor;
  const firstSeen = history.length > 0 ? history[0] : null;
  const tagSuggestions = [...new Set(allTags.flatMap((x) => x.tags ?? []))].sort();
  const showParams = f.kind === 'interface' || params.length > 0;

  return (
    <div className="feature-detail" ref={rootRef} tabIndex={-1}>
      <div className="fd-inner">
        <div className="fd-topbar">
          <button className="fd-back" onClick={onBack}>← Features</button>
          {saveError ? <span className="fd-save-error" role="alert">Not saved: {saveError}</span> : <SaveIndicator saving={saving} savedAt={savedAt} />}
        </div>

        {/* ── Hero card ───────────────────────────────────────────── */}
        <div className="fd-card fd-hero">
          <div className="fd-hero-top">
            <SelectDropdown<FeatureKind> appearance="tinted" label="Kind" options={FEATURE_KIND_OPTIONS} value={f.kind} onChange={(kind) => patch({ kind })} />
            <SelectDropdown<FeatureStatus> appearance="tinted" label="Status" options={FEATURE_STATUS_OPTIONS} value={f.status} onChange={(status) => patch({ status })} />
            <SelectDropdown<'' | 'in' | 'out'> appearance="tinted" label="Direction" options={DIRECTIONS} value={f.direction ?? ''}
              onChange={(d) => patch({ direction: d as Feature['direction'] })} />
            {f.confidence && (
              <span className="fd-confidence" style={{ color: CONFIDENCE_COLORS[f.confidence] }}>
                ● {f.confidence}
              </span>
            )}
          </div>

          {/* As on the list card: [METHOD] title (protocol), each editable in place. */}
          <div className="fd-title-row">
            {f.kind === 'interface' && (
              <EditableText
                className={`fd-method${f.operation ? ' feature-method-badge' : ''}`}
                style={f.operation ? { background: METHOD_COLORS[f.operation.toUpperCase()] ?? 'var(--kind-interface)' } : undefined}
                value={(f.operation ?? '').toUpperCase()} placeholder="method" label="Method" plain
                onChange={(operation) => patch({ operation: operation.trim().toUpperCase() })} />
            )}
            <h1 className="fd-title">
              <EditableText value={f.title} onChange={(title) => { if (title.trim()) patch({ title: title.trim() }); }} placeholder="Feature title" label="Title" plain />
            </h1>
            <EditableText className={`fd-protocol${f.protocol ? ' feature-chip' : ''}`} value={f.protocol ?? ''} placeholder="protocol" label="Protocol" plain
              onChange={(protocol) => patch({ protocol: protocol.trim() })} />
          </div>

          <div className="fd-description">
            <EditableText value={f.description ?? ''} placeholder="Add a description…" label="Description" multiline
              onChange={(description) => patch({ description })} />
          </div>

          <div className="fd-tags">
            <TagInput value={f.tags} onChange={(tags) => patch({ tags })} suggestions={tagSuggestions} />
          </div>

          <div className="overview-card-meta fd-footer">
            <LocationField anchor={f.anchor} effective={f.effectiveAnchor} onChange={move} />
            <span className="overview-card-meta-right">
              <span className="overview-commit-ref">{short(eff.commitId)}</span>
            </span>
          </div>
        </div>

        {/* ── Two-column: main content + metadata sidebar ─────────── */}
        <div className="fd-grid">
          <div className="fd-main">
            {/* Parameters */}
            {showParams && (
              <div className="fd-card">
                <h2 className="fd-card-title">
                  Parameters <span className="fd-count">{params.filter((p) => p.name.trim()).length}</span>
                  <button type="button" className="fd-card-action"
                    onClick={() => setParams((ps) => [...ps, { key: `d${draftSeq++}`, name: '', type: '', required: false, description: '', pattern: '' }])}>
                    + Add
                  </button>
                </h2>
                {params.length === 0 ? (
                  <div className="fd-muted">No parameters.</div>
                ) : (
                  <div className="fd-params">
                    {params.map((p) => (
                      <div key={p.key} className="fd-param">
                        <div className="fd-param-head">
                          <span className="fd-param-name">
                            <EditableText className="editable-inline" value={p.name} placeholder="name" label="Parameter name" plain
                              onChange={(name) => setParam(p.key, { name })} />
                          </span>
                          <SelectDropdown<string> appearance="tinted" size="sm" label="Parameter type" options={PARAM_TYPES} value={p.type} onChange={(type) => setParam(p.key, { type })} />
                          <label className="fd-param-req">
                            <input type="checkbox" checked={p.required} onChange={(e) => setParam(p.key, { required: e.target.checked })} />
                            required
                          </label>
                          <code className="fd-param-pattern">
                            <EditableText className="editable-inline" value={p.pattern} placeholder="pattern" label="Parameter pattern" plain
                              onChange={(pattern) => setParam(p.key, { pattern })} />
                          </code>
                          <button type="button" className="fd-card-action" aria-label={`Remove parameter ${p.name || ''}`}
                            onClick={() => saveParams(params.filter((x) => x.key !== p.key))}>Remove</button>
                        </div>
                        <div className="fd-param-desc">
                          <EditableText value={p.description} placeholder="Describe this parameter…" label="Parameter description"
                            onChange={(description) => setParam(p.key, { description })} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Reconciliation trail */}
            <div className="fd-card">
              <h2 className="fd-card-title">Reconciliation <span className="fd-count">{history.length}</span></h2>
              {history.length === 0 ? (
                <div className="fd-muted">No reconciliation history recorded.</div>
              ) : (
                <ol className="fd-recon">
                  {[...history].reverse().slice(0, allHistory ? undefined : RECON_SHOWN).map((p, i) => (
                    <li key={`${p.commitId}-${i}`} className="fd-recon-row">
                      <span className="fd-recon-dot" style={{ background: CONFIDENCE_COLORS[p.confidence] ?? 'var(--text-muted)' }} />
                      <span className="fd-recon-commit fd-mono">{short(p.commitId)}</span>
                      <span className="fd-recon-conf" style={{ color: CONFIDENCE_COLORS[p.confidence] }}>{p.confidence}</span>
                      <span className="fd-recon-line">
                        {p.lineStart != null ? `L${p.lineStart}${p.lineEnd && p.lineEnd !== p.lineStart ? `–${p.lineEnd}` : ''}` : '—'}
                      </span>
                      <span className="fd-recon-date">{fmtDate(p.createdAt)}</span>
                    </li>
                  ))}
                </ol>
              )}
              {history.length > RECON_SHOWN && (
                <button type="button" className="fd-card-action fd-recon-more" onClick={() => setAllHistory(!allHistory)}>
                  {allHistory ? 'Show fewer' : `Show all ${history.length}`}
                </button>
              )}
            </div>

            {/* Comments */}
            <div className="fd-card">
              <h2 className="fd-card-title">Comments <span className="fd-count">{comments.length}</span></h2>
              <CommentThread
                comments={comments}
                target={{ anchor: f.anchor, featureId: f.id }}
                placeholder="Add a comment…"
                emptyText="No comments on this feature yet."
              />
            </div>
          </div>

          <aside className="fd-side">
            {/* Provenance */}
            <div className="fd-card">
              <h2 className="fd-card-title">Provenance</h2>
              <div className="fd-provenance">
                <div className="fd-prov-row">
                  <span className="fd-prov-label">First recorded</span>
                  <span className="fd-prov-val">{fmtDate(f.createdAt)}</span>
                </div>
                <div className="fd-prov-row">
                  <span className="fd-prov-label">Pinned at commit</span>
                  <span className="fd-prov-val fd-mono">{short(f.anchor.commitId)}</span>
                </div>
                {firstSeen && (
                  <div className="fd-prov-row">
                    <span className="fd-prov-label">First tracked at</span>
                    <span className="fd-prov-val fd-mono">
                      {short(firstSeen.commitId)}
                      {firstSeen.lineStart != null && <span className="fd-prov-line"> · L{firstSeen.lineStart}</span>}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Host-contributed cards (the platform adds "Used in flows") */}
            {extensions.featureDetailAside?.(f.id)}


            <OriginCard origin={f.origin ?? {}} onChange={patchOrigin} suggest={() => featuresApi.suggestOrigin(f.id)} />

            {/* Linked features and external links, both edited in the cards' "Manage links" dialog */}
            <div className="fd-card">
              <h2 className="fd-card-title">
                Links <span className="fd-count">{linked.length + refs.length}</span>
                <button type="button" className="fd-card-action" onClick={() => setManagingLinks(true)}>Edit</button>
              </h2>
              {linked.length + refs.length === 0 ? (
                <div className="fd-muted">No linked features or external links.</div>
              ) : (
                <div className="fd-linked">
                  {linked.map((l) => (
                    <button
                      key={l.id}
                      className="fd-linked-item"
                      onClick={() => { window.location.hash = `#/feature/${l.id}`; }}
                      title="Open linked feature"
                    >
                      <span className="fd-mono">{linkedLabels[l.id] ?? l.id.slice(0, 8)}</span>
                      {l.description && <span className="fd-linked-desc"> — {l.description}</span>}
                    </button>
                  ))}
                  {refs.map((r) => (
                    <a key={r.id} className="fd-linked-item fd-ref" href={r.url} target="_blank" rel="noopener noreferrer">
                      <RefProviderIcon provider={r.provider} size={12} />
                      <span>{r.title || r.url}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      {managingLinks && createPortal(
        <LinkManageModal
          entityType="feature"
          entityId={f.id}
          refs={refs}
          linkedFeatures={linked}
          onClose={() => { setManagingLinks(false); load(true); }}
          onRefsChange={setRefs}
        />,
        document.body,
      )}
    </div>
  );
}
