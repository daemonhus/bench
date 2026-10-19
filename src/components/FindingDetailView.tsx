import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findingsApi, featuresApi, reconcileApi, refsApi } from '../core/api';
import { CATEGORY_META } from '../core/finding-categories';
import { useWorkbenchExtensions } from '../core/extensions';
import { useAnnotationStore } from '../stores/annotation-store';
import { RefProviderIcon } from './RefProviderIcon';
import { PageSkeleton } from './Skeleton';
import { SelectDropdown } from './SelectDropdown';
import { SEVERITY_OPTIONS, FINDING_STATUS_OPTIONS } from '../core/status-options';
import { EditableText, SaveIndicator, useSaveTracker } from './EditableText';
import { LinkManageModal } from './LinkManageModal';
import { CommentThread } from './CommentThread';
import { OriginCard } from './OriginCard';
import { LocationField, type LocationChange } from './LocationField';
import type {
  FindingWithPosition, Finding, AnnotationPosition, Ref, Severity, FindingStatus, Origin,
} from '../core/types';

// The finding's own page, laid out like the feature detail page (FeatureDetailView): a hero card,
// then the reconciliation trail and comments beside provenance, origin and links. Like the flow
// page, everything is editable in place and saves as soon as a field is left.

const CATEGORIES: { value: string; label: string }[] = [
  { value: '', label: 'Uncategorised' },
  ...Object.entries(CATEGORY_META)
    .filter(([k]) => k !== 'uncategorised' && k !== 'uncategorized')
    .map(([value, m]) => ({ value, label: m.label })),
];
const SOURCES: { value: Finding['source']; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'pentest', label: 'Pentest' },
  { value: 'tool', label: 'Tool' },
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

interface Props {
  findingId: string;
  onBack: () => void;
}

export function FindingDetailView({ findingId, onBack }: Props) {
  const extensions = useWorkbenchExtensions();
  const [finding, setFinding] = useState<FindingWithPosition | null>(null);
  // Comments come from the annotation store, shared with the list cards, so a reply here shows there.
  const allComments = useAnnotationStore((s) => s.comments);
  const comments = useMemo(() => allComments.filter((c) => c.findingId === findingId), [allComments, findingId]);
  const [history, setHistory] = useState<AnnotationPosition[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({});
  const [managingLinks, setManagingLinks] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const { saving, savedAt, error: saveError, withSave } = useSaveTracker();
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback((quiet = false) => {
    let cancelled = false;
    if (!quiet) { setLoading(true); setError(null); }
    Promise.all([
      findingsApi.get(findingId, 'HEAD'),
      useAnnotationStore.getState().fetchCommentsForFinding(findingId).catch(() => {}),
      reconcileApi.history('finding', findingId).then((r) => r.positions).catch(() => []),
      refsApi.list('finding', findingId).catch(() => []),
    ])
      .then(([f, , h, r]) => {
        if (cancelled) return;
        setFinding(f);
        setHistory(h as AnnotationPosition[]);
        setRefs(r as Ref[]);
      })
      .catch((e: unknown) => {
        if (!cancelled && !quiet) setError(e instanceof Error ? e.message : 'Failed to load finding');
      })
      .finally(() => { if (!cancelled && !quiet) setLoading(false); });
    return () => { cancelled = true; };
  }, [findingId]);

  useEffect(() => load(), [load]);

  // Arriving here (deep link, card title, a square) leaves focus on <body> because the previous
  // control unmounted. Anchor it here.
  const ready = !loading && !!finding;
  useEffect(() => {
    if (ready) rootRef.current?.focus({ preventScroll: true });
  }, [ready, findingId]);

  // Resolve linked-feature titles so the list reads as names, not raw ids.
  const featureIds = (finding?.features ?? []).join(',');
  useEffect(() => {
    if (!featureIds) { setFeatureLabels({}); return; }
    let cancelled = false;
    Promise.all(featureIds.split(',').map((id) =>
      featuresApi.get(id).then((lf) => [id, [lf.operation, lf.title].filter(Boolean).join(' ')] as const).catch(() => null),
    )).then((pairs) => {
      if (cancelled) return;
      setFeatureLabels(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null)));
    });
    return () => { cancelled = true; };
  }, [featureIds]);

  // Apply a change at once, save it, and put it back if the save fails. The workbench's lists
  // share the annotation store, so it is updated too.
  const patch = useCallback((updates: Partial<Finding>) => {
    if (!finding) return;
    const before = finding;
    setFinding({ ...finding, ...updates });
    useAnnotationStore.setState((s) => ({ findings: s.findings.map((x) => (x.id === finding.id ? { ...x, ...updates } : x)) }));
    withSave(() => findingsApi.update(finding.id, updates)).catch(() => setFinding(before));
  }, [finding, withSave]);

  // Correcting where it points: save, then reload for the new tracked position and history.
  const move = useCallback((change: LocationChange) => {
    if (!finding) return;
    withSave(() => findingsApi.update(finding.id, change as unknown as Partial<Finding>)).then(() => load(true)).catch(() => {});
  }, [finding, withSave, load]);

  const patchOrigin = useCallback((updates: Partial<Origin>) => {
    if (!finding) return;
    const before = finding;
    const origin = { ...(finding.origin ?? {}), ...updates };
    setFinding({ ...finding, origin });
    withSave(() => findingsApi.setOrigin(finding.id, origin)).catch(() => setFinding(before));
  }, [finding, withSave]);

  if (loading) return <PageSkeleton label="Loading finding" cards={3} cardHeight={120} />;
  if (error || !finding) {
    return (
      <div className="feature-detail">
        <div className="fd-inner">
          <button className="fd-back" onClick={onBack}>← Findings</button>
          <div className="empty-state">{error ?? 'Finding not found.'}</div>
        </div>
      </div>
    );
  }

  const f = finding;
  const eff = f.effectiveAnchor ?? f.anchor;
  const firstSeen = history.length > 0 ? history[0] : null;
  const features = f.features ?? [];
  const origin = f.origin ?? {};

  return (
    <div className="feature-detail" ref={rootRef} tabIndex={-1}>
      <div className="fd-inner">
        <div className="fd-topbar">
          <button className="fd-back" onClick={onBack}>← Findings</button>
          {saveError ? <span className="fd-save-error" role="alert">Not saved: {saveError}</span> : <SaveIndicator saving={saving} savedAt={savedAt} />}
        </div>

        {/* ── Hero card ───────────────────────────────────────────── */}
        <div className="fd-card fd-hero">
          <div className="fd-hero-top">
            <SelectDropdown<Severity> appearance="tinted" label="Severity" options={SEVERITY_OPTIONS} value={f.severity} onChange={(severity) => patch({ severity })} />
            <SelectDropdown<FindingStatus> appearance="tinted" label="Status" options={FINDING_STATUS_OPTIONS} value={f.status} onChange={(status) => patch({ status })} />
            <SelectDropdown<string> appearance="tinted" label="Category" options={CATEGORIES} value={f.category ?? ''} onChange={(category) => patch({ category })} />
            <SelectDropdown<Finding['source']> appearance="tinted" label="Source" value={f.source} onChange={(source) => patch({ source })}
              // Keep a source written by another tool (e.g. "mcp") selectable as it is.
              options={SOURCES.some((o) => o.value === f.source) ? SOURCES : [...SOURCES, { value: f.source, label: f.source }]} />
            {f.confidence && (
              <span className="fd-confidence" style={{ color: CONFIDENCE_COLORS[f.confidence] }}>
                ● {f.confidence}
              </span>
            )}
          </div>

          <h1 className="fd-title">
            <EditableText value={f.title} onChange={(title) => { if (title.trim()) patch({ title: title.trim() }); }} placeholder="Finding title" label="Title" plain />
          </h1>
          {/* Scoring: label and value pairs; an empty one shows a quiet dash until filled. */}
          <dl className="fd-facts">
            <div><dt>CVSS</dt><dd><EditableText className="editable-inline" value={f.score > 0 ? String(f.score) : ''} placeholder="—" label="CVSS score" plain
              onChange={(v) => { const n = Number(v); if (v.trim() === '' || (!Number.isNaN(n) && n >= 0 && n <= 10)) patch({ score: v.trim() === '' ? 0 : n }); }} /></dd></div>
            <div><dt>CWE</dt><dd><EditableText className="editable-inline" value={f.cwe} placeholder="—" label="CWE" plain onChange={(cwe) => patch({ cwe: cwe.trim() })} /></dd></div>
            <div><dt>CVE</dt><dd><EditableText className="editable-inline" value={f.cve} placeholder="—" label="CVE" plain onChange={(cve) => patch({ cve: cve.trim() })} /></dd></div>
            <div className="fd-facts-wide"><dt>Vector</dt><dd><EditableText className="editable-inline" value={f.vector} placeholder="—" label="CVSS vector" plain onChange={(vector) => patch({ vector: vector.trim() })} /></dd></div>
          </dl>

          <div className="fd-description">
            <EditableText value={f.description} placeholder="Add a description…" label="Description" multiline onChange={(description) => patch({ description })} />
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
                target={{ anchor: f.anchor, findingId: f.id }}
                placeholder="Add a comment…"
                emptyText="No comments on this finding yet."
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
                {(f.resolvedCommit || f.resolvedAt) && (
                  <div className="fd-prov-row">
                    <span className="fd-prov-label">Resolved</span>
                    <span className="fd-prov-val">
                      {[f.resolvedAt ? fmtDate(f.resolvedAt) : '', f.resolvedCommit ? short(f.resolvedCommit) : ''].filter(Boolean).map((v, i) => (
                        <span key={i} className={i ? 'fd-mono fd-prov-line' : undefined}>{i ? ` · ${v}` : v}</span>
                      ))}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Origin: how the issue came to be */}

            {/* Host-contributed cards */}
            {extensions.findingDetailAside?.(f.id)}

            <OriginCard origin={origin} onChange={patchOrigin} suggest={() => findingsApi.suggestOrigin(f.id)} />

            {/* Linked features and external links, both edited in the cards' "Manage links" dialog */}
            <div className="fd-card">
              <h2 className="fd-card-title">
                Links <span className="fd-count">{features.length + refs.length}</span>
                <button type="button" className="fd-card-action" onClick={() => setManagingLinks(true)}>Edit</button>
              </h2>
              {features.length + refs.length === 0 ? (
                <div className="fd-muted">No linked features or external links.</div>
              ) : (
                <div className="fd-linked">
                  {features.map((id) => (
                    <button
                      key={id}
                      className="fd-linked-item"
                      onClick={() => { window.location.hash = `#/feature/${id}`; }}
                      title="Open linked feature"
                    >
                      <span className="fd-mono">{featureLabels[id] ?? id.slice(0, 8)}</span>
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
          entityType="finding"
          entityId={f.id}
          refs={refs}
          linkedFeatureIds={features}
          onClose={() => { setManagingLinks(false); load(true); }}
          onRefsChange={setRefs}
        />,
        document.body,
      )}
    </div>
  );
}
