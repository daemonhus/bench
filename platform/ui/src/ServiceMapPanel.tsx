import { useEffect, useState } from 'react';
import { ToneChip } from '@bench/components/SelectDropdown';
import { KIND_COLORS } from '@bench/components/FeatureCard';
import { isOpenFinding } from '@bench/core/finding-categories';
import { SEVERITY_OPTIONS, FINDING_STATUS_OPTIONS, FEATURE_KIND_OPTIONS, FEATURE_STATUS_OPTIONS, METHOD_COLORS } from '@bench/core/status-options';
import type { Feature } from '@bench/core/types';
import { listProjectFindings, type Finding } from './api';
import { EDGE_KINDS } from './flows';
import { EDGE_DASH, edgeColor, usePalette } from './graphKit';
import { plural } from './projectInsight';
import { excerpt, methodOf } from './searchModel';
import { optionOf, where } from './SearchResultCard';
import { connectionKey, crossesBoundary, type MapConnection, type MapFeature, type ServiceMapData } from './serviceMapModel';

// The service map's side panel: the selected feature, service or connection at a glance, in the
// same badges and chips as the rest of bench, with a preview of what its page holds (description,
// place in the code, open findings) and links onward.

export type Selection =
  | { kind: 'connection'; key: string }
  | { kind: 'feature'; slug: string; id: string }
  | { kind: 'service'; slug: string };

const plain = (text: string) => text.replace(/\*\*|__|`|^#+\s*/gm, '');
/** The method badge and the title after it ("POST /login" → POST, "/login"). */
const badged = (f?: MapFeature) => {
  const m = f ? methodOf(f) : undefined;
  const title = f?.title ?? 'unknown feature';
  return { m, title: m && title.toUpperCase().startsWith(`${m} `) ? title.slice(m.length + 1) : title };
};

/** Each project's findings, fetched once per panel session and shared between selections. */
const findingsCache = new Map<string, Promise<Finding[]>>();
const projectFindings = (slug: string) => {
  if (!findingsCache.has(slug)) findingsCache.set(slug, listProjectFindings(slug).catch(() => { findingsCache.delete(slug); return []; }));
  return findingsCache.get(slug)!;
};

/** The full feature (description, anchor, tags) and its open findings, for the preview. */
function useFeatureDetail(slug: string, id: string, enabled: boolean) {
  const [detail, setDetail] = useState<{ feature: Feature | null; findings: Finding[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setDetail(null);
    Promise.all([
      fetch(`/api/projects/${slug}/features/${id}`).then((r) => (r.ok ? r.json() as Promise<Feature> : null)).catch(() => null),
      projectFindings(slug),
    ]).then(([feature, all]) => {
      if (live) setDetail({ feature, findings: all.filter((f) => isOpenFinding(f) && (f.features ?? []).includes(id)) });
    });
    return () => { live = false; };
  }, [slug, id, enabled]);
  return detail;
}

function EdgeSwatch({ kind }: { kind: MapConnection['kind'] }) {
  const { pal } = usePalette();
  return (
    <svg width="18" height="6" aria-hidden="true" className="smap-swatch">
      <line x1="1" y1="3" x2="17" y2="3" stroke={edgeColor(kind, pal)} strokeWidth="2" strokeDasharray={EDGE_DASH[kind]} />
    </svg>
  );
}

/** A feature as a chip: its method badge (or kind dot) and title. */
function FeatureLabel({ f }: { f?: MapFeature }) {
  const { m, title } = badged(f);
  return (
    <>
      {m ? <span className="feature-method-badge" style={{ background: METHOD_COLORS[m] }}>{m}</span>
        : <span className="home-dot" style={{ background: KIND_COLORS[f?.kind ?? 'externality'] }} aria-hidden="true" />}
      <span className="smap-p-label">{title}</span>
    </>
  );
}

export function SelectionPanel({ data, selection, connection, visibleConnections, onClose, onSelect, onOpenFlow, onOpenProject }: {
  data: ServiceMapData;
  selection: Selection;
  connection?: MapConnection;
  visibleConnections: MapConnection[];
  onClose: () => void;
  onSelect: (s: Selection) => void;
  onOpenFlow: (id: string) => void;
  onOpenProject: (slug: string, hash?: string) => void;
}) {
  const service = (slug: string) => data.services.find((s) => s.slug === slug);
  const feature = (slug: string, id: string) => service(slug)?.features.find((f) => f.id === id);
  const zoneOf = (slug: string, id: string) => feature(slug, id)?.zone || service(slug)?.zone || '?';
  const isFeature = selection.kind === 'feature';
  const detail = useFeatureDetail(isFeature ? selection.slug : '', isFeature ? selection.id : '', isFeature && !feature(selection.slug, selection.id)?.missing);

  const flowChips = (flows: { id: string; name: string }[]) => (
    flows.length === 0 ? <div className="smap-muted">Not on any flow.</div> : (
      <div className="smap-p-chips">
        {flows.map((f) => <button key={f.id} type="button" className="search-card-link" onClick={() => onOpenFlow(f.id)} aria-label={`Flow ${f.name}`}><span>{f.name}</span></button>)}
      </div>
    )
  );
  /** Connections as rows: the line style and kind, then the feature at the other end. */
  const connRows = (list: MapConnection[], from: { slug: string; id?: string }) => (
    list.length === 0 ? <div className="smap-muted">No connections shown.</div> : (
      <ul className="smap-p-list">
        {list.map((c) => {
          const outgoing = c.fromProject === from.slug && (!from.id || c.fromFeature === from.id);
          const [os, of] = outgoing ? [c.toProject, c.toFeature] : [c.fromProject, c.fromFeature];
          return (
            <li key={connectionKey(c)}>
              <button type="button" className="smap-p-row" onClick={() => onSelect({ kind: 'connection', key: connectionKey(c) })}
                aria-label={`${c.kind} ${outgoing ? 'to' : 'from'} ${service(os)?.name ?? os} ${feature(os, of)?.title ?? of}`}>
                <span className="smap-p-kind"><EdgeSwatch kind={c.kind} />{outgoing ? '→' : '←'} {c.kind}</span>
                <span className="smap-p-target">
                  <span className="smap-p-service">{service(os)?.name ?? os}</span>
                  <span className="smap-p-feature"><FeatureLabel f={feature(os, of)} /></span>
                </span>
                {(crossesBoundary(c) || c.tainted) && (
                  <span className="smap-p-flags">
                    {crossesBoundary(c) && <span className="smap-p-flag smap-p-flag--warn" title={c.zoneBoundary ? 'Its ends sit in different trust zones' : 'Crosses a trust boundary'}>boundary</span>}
                    {c.tainted && <span className="smap-p-flag smap-p-flag--danger" title="Carries attacker-controlled data">tainted</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    )
  );
  const openLink = (label: string, onClick: () => void) => (
    <button type="button" className="smap-p-open" onClick={onClick}>{label} <span aria-hidden="true">↗</span></button>
  );

  let title = '';
  let head: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (selection.kind === 'feature') {
    const f = feature(selection.slug, selection.id);
    const s = service(selection.slug);
    title = f?.title ?? selection.id;
    const full = detail?.feature;
    const kind = f && optionOf(FEATURE_KIND_OPTIONS, f.kind);
    const st = full && full.status !== 'active' ? optionOf(FEATURE_STATUS_OPTIONS, full.status) : undefined;
    const { m, title: shortTitle } = badged(f);
    const mine = visibleConnections.filter((c) => (c.fromProject === selection.slug && c.fromFeature === selection.id) || (c.toProject === selection.slug && c.toFeature === selection.id));
    const myLinks = data.links.filter((l) => (l.fromProject === selection.slug && l.fromFeature === selection.id) || (l.toProject === selection.slug && l.toFeature === selection.id));
    head = f && (
      <>
        <div className="smap-p-title">
          {m && <span className="feature-method-badge" style={{ background: METHOD_COLORS[m] }}>{m}</span>}
          <span>{shortTitle}</span>
        </div>
        <div className="smap-p-chips">
          {kind && <ToneChip label={kind.label} tone={kind.tone} />}
          {st && <ToneChip label={st.label} tone={st.tone} />}
          {(f.zone || s?.zone) && <span className="smap-p-flag" title="Trust zone">zone: {f.zone || s?.zone}</span>}
          {f.openFindings > 0 && (
            <a className="search-card-flag smap-p-flag-link" href="#smap-p-findings" onClick={(e) => { e.preventDefault(); document.getElementById('smap-p-findings')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}>
              {plural(f.openFindings, 'open finding')}
            </a>
          )}
        </div>
        <div className="search-card-meta home-search-sub">
          <span className="search-card-meta-item"><button type="button" className="smap-p-inline" onClick={() => onSelect({ kind: 'service', slug: selection.slug })}>{s?.name ?? selection.slug}</button></span>
          {f.protocol && <span className="search-card-meta-item search-card-mono">{f.protocol}</span>}
          {f.direction && <span className="search-card-meta-item">{f.direction === 'in' ? 'inbound' : 'outbound'}</span>}
          {f.operation && !m && <span className="search-card-meta-item search-card-mono">{f.operation}</span>}
        </div>
      </>
    );
    body = f && (
      <>
        {f.missing ? <div className="smap-muted">A flow names this feature, but the project no longer has it.</div> : (
          <section className="smap-p-section" aria-label="Preview">
            {!detail ? <div className="smap-muted">Loading…</div> : (
              <>
                {full?.description && <p className="smap-p-text">{excerpt(plain(full.description), '', 320)}</p>}
                {where(full?.anchor) && <div className="search-card-mono smap-p-file" title={where(full?.anchor)!}>{where(full?.anchor)}</div>}
                {full?.tags && full.tags.length > 0 && <div className="search-card-tags">{full.tags.map((t) => <span key={t} className="search-card-tag">{t}</span>)}</div>}
              </>
            )}
            {openLink('Open feature', () => onOpenProject(selection.slug, `#/feature/${f.id}`))}
          </section>
        )}
        {f.openFindings > 0 && (
          <section className="smap-p-section" id="smap-p-findings" aria-label="Open findings">
            <h3 className="smap-panel-sub">Open findings <span className="smap-p-count">{f.openFindings}</span></h3>
            {!detail ? <div className="smap-muted">Loading…</div> : (
              <ul className="smap-p-list">
                {detail.findings.map((x) => {
                  const sev = optionOf(SEVERITY_OPTIONS, x.severity);
                  const xs = optionOf(FINDING_STATUS_OPTIONS, x.status);
                  return (
                    <li key={x.id}>
                      <button type="button" className="smap-p-row" onClick={() => onOpenProject(selection.slug, `#/finding/${x.id}`)} aria-label={`Finding ${x.title}`}>
                        <span className="smap-p-target">
                          <span className="smap-p-feature"><span className="home-dot" style={{ background: sev?.tone }} aria-hidden="true" /><span className="smap-p-label">{x.title}</span></span>
                        </span>
                        <span className="smap-p-flags">
                          {sev && <ToneChip label={sev.label} tone={sev.tone} size="sm" />}
                          {xs && x.status !== 'open' && <ToneChip label={xs.label} tone={xs.tone} size="sm" />}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        <section className="smap-p-section" aria-label="Connections">
          <h3 className="smap-panel-sub">Connections <span className="smap-p-count">{mine.length}</span></h3>
          {connRows(mine, { slug: selection.slug, id: selection.id })}
        </section>
        {myLinks.length > 0 && (
          <section className="smap-p-section" aria-label="Linked features">
            <h3 className="smap-panel-sub">Linked features <span className="smap-p-count">{myLinks.length}</span></h3>
            <ul className="smap-p-list">
              {myLinks.map((l) => {
                const [os, of] = l.fromProject === selection.slug && l.fromFeature === selection.id ? [l.toProject, l.toFeature] : [l.fromProject, l.fromFeature];
                return (
                  <li key={`${os}:${of}`}>
                    <button type="button" className="smap-p-row" onClick={() => onSelect({ kind: 'feature', slug: os, id: of })}
                      aria-label={`Linked to ${service(os)?.name ?? os} ${feature(os, of)?.title ?? of}`}>
                      <span className="smap-p-target">
                        <span className="smap-p-service">{service(os)?.name ?? os}</span>
                        <span className="smap-p-feature"><FeatureLabel f={feature(os, of)} /></span>
                      </span>
                      {!l.inFlows && <span className="smap-p-flags"><span className="smap-p-flag" title="No flow connects these two features yet">not on a flow</span></span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section className="smap-p-section" aria-label="Flows">
          <h3 className="smap-panel-sub">Flows <span className="smap-p-count">{f.flows.length}</span></h3>
          {flowChips(f.flows)}
        </section>
      </>
    );
  } else if (selection.kind === 'service') {
    const s = service(selection.slug);
    title = s?.name ?? selection.slug;
    const out = visibleConnections.filter((c) => c.fromProject === selection.slug && c.toProject !== selection.slug);
    const inc = visibleConnections.filter((c) => c.toProject === selection.slug && c.fromProject !== selection.slug);
    const open = s?.features.reduce((n, f) => n + f.openFindings, 0) ?? 0;
    const byKind = FEATURE_KIND_OPTIONS.map((k) => ({ k, n: s?.features.filter((f) => f.kind === k.value).length ?? 0 })).filter((x) => x.n > 0);
    head = s && (
      <>
        <div className="smap-p-title"><span>{s.name}</span></div>
        <div className="smap-p-chips">
          {s.zone && <span className="smap-p-flag" title="Trust zone, from the project's service profile">zone: {s.zone}</span>}
          {byKind.map(({ k, n }) => <ToneChip key={k.value} label={`${n} ${k.label.toLowerCase()}`} tone={k.tone} />)}
          {open > 0 && <span className="search-card-flag">{plural(open, 'open finding')}</span>}
        </div>
        {openLink('Open project', () => onOpenProject(s.slug))}
      </>
    );
    body = s && (
      <>
        <section className="smap-p-section" aria-label="Calls out">
          <h3 className="smap-panel-sub">Calls out <span className="smap-p-count">{out.length}</span></h3>
          {connRows(out, { slug: s.slug })}
        </section>
        <section className="smap-p-section" aria-label="Called by">
          <h3 className="smap-panel-sub">Called by <span className="smap-p-count">{inc.length}</span></h3>
          {connRows(inc, { slug: s.slug })}
        </section>
      </>
    );
  } else if (connection) {
    title = 'Connection';
    const kindLabel = EDGE_KINDS.find((k) => k.value === connection.kind)?.label ?? connection.kind;
    const end = (slug: string, id: string) => (
      <button type="button" className="smap-p-row" onClick={() => onSelect({ kind: 'feature', slug, id })} aria-label={`${service(slug)?.name ?? slug} ${feature(slug, id)?.title ?? id}`}>
        <span className="smap-p-target">
          <span className="smap-p-service">{service(slug)?.name ?? slug}</span>
          <span className="smap-p-feature"><FeatureLabel f={feature(slug, id)} /></span>
        </span>
      </button>
    );
    head = (
      <>
        <div className="smap-p-title"><EdgeSwatch kind={connection.kind} /><span>{kindLabel}</span>{connection.protocol && <span className="search-card-mono smap-p-proto">{connection.protocol}</span>}</div>
        <div className="smap-p-chips">
          {connection.zoneBoundary
            ? <span className="smap-p-flag smap-p-flag--warn">crosses trust zones: {zoneOf(connection.fromProject, connection.fromFeature)} → {zoneOf(connection.toProject, connection.toFeature)}</span>
            : connection.trustBoundary && <span className="smap-p-flag smap-p-flag--warn">crosses a trust boundary</span>}
          {connection.linked === false && <span className="smap-p-flag" title="The two features aren't linked: no dependency backs this hop">no feature link</span>}
          {connection.tainted && <span className="smap-p-flag smap-p-flag--danger">tainted data</span>}
          <span className="smap-p-flag">seen {plural(connection.count, 'time')}</span>
        </div>
      </>
    );
    body = (
      <>
        <section className="smap-p-section smap-p-route" aria-label="Route">
          {end(connection.fromProject, connection.fromFeature)}
          <span className="smap-p-arrow" aria-hidden="true">↓</span>
          {end(connection.toProject, connection.toFeature)}
        </section>
        <section className="smap-p-section" aria-label="Identity">
          <h3 className="smap-panel-sub">Identity</h3>
          {connection.auth.length ? <div className="smap-p-chips">{connection.auth.map((a) => <span key={a} className="search-card-tag">{a}</span>)}</div> : <div className="smap-muted">None recorded.</div>}
        </section>
        <section className="smap-p-section" aria-label="Flows">
          <h3 className="smap-panel-sub">Flows <span className="smap-p-count">{connection.flows.length}</span></h3>
          {flowChips(connection.flows)}
        </section>
      </>
    );
  }

  return (
    <aside className="map-step-panel smap-panel" aria-label={title || 'Details'}>
      <div className="map-step-panel-header smap-p-header">
        <div className="smap-p-head">{head}</div>
        <button className="icon-btn map-step-panel-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="map-step-panel-body">{body}</div>
    </aside>
  );
}
