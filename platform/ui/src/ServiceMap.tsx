import { useEffect, useMemo, useRef, useState } from 'react';
import { SelectDropdown } from '@bench/components/SelectDropdown';
import { MultiSelectDropdown } from '@bench/components/MultiSelectDropdown';
import { SearchBox } from '@bench/components/SearchBox';
import { Skeleton } from '@bench/components/Skeleton';
import { qp, useQueryState, pathQuery, writeQuery, formatQuery, type QuerySchema } from '@bench/core/query-state';
import { EDGE_KINDS, type EdgeKind, type FeatureKind } from './flows';
import {
  usePalette, usePanZoom, GraphControls, ArrowMarkers, horizontalPath, parseMethod, badgeW, truncate,
  EDGE_DASH, edgeColor,
} from './graphKit';
import {
  applyFilters, layoutMap, neighbourhood, connectionKey, featureKey,
  DEFAULT_FILTERS, ALL_EDGE_KINDS, ALL_FEATURE_KINDS, CARD_W, HEADER_H, ROW_H,
  type ServiceMapData, type MapFilters, type MapFields, type MapConnection, type MapFeature, type MapService, type FeatureScope,
} from './serviceMapModel';
import './serviceMap.css';

// The service map: every project as a service card listing its features, and the connections
// that flows record between them (each cross-project edge of a flow), drawn feature to
// feature. Filters pick services, connection kinds and feature kinds; the cards re-lay out
// as they change. Hover a feature or service to follow its connections; click one for detail.

// The filters, the search and the display options live in the address (/map?hide=beta&show=all;
// see bench's query-state.ts); the filters and fields are remembered for a bare /map.
const FIELD_KEYS = ['operation', 'protocol', 'flows', 'findings'] as const;
type MapQuery = Omit<MapFilters, 'fields'> & { q: string; archived: boolean; fields: (keyof MapFields)[] };
const MAP_QUERY: QuerySchema<MapQuery> = {
  q: qp.string('q'),
  hiddenServices: qp.list('hide').remembered(),
  connectionKinds: qp.set('connections', ALL_EDGE_KINDS).remembered(),
  featureKinds: qp.set('kinds', ALL_FEATURE_KINDS).remembered(),
  scope: qp.oneOf<FeatureScope>('show', ['connected', 'flows', 'all'], DEFAULT_FILTERS.scope).remembered(),
  internal: qp.bool('internal').remembered(),
  archived: qp.bool('archived'),
  fields: qp.set('fields', FIELD_KEYS, FIELD_KEYS.filter((k) => DEFAULT_FILTERS.fields[k])).remembered(),
};
const MAP_URL = pathQuery('/map');
const MAP_REMEMBER = { key: 'service-map-query' };
// The filters were kept as JSON before.
try {
  const old = localStorage.getItem('service-map-filters');
  if (old && localStorage.getItem(MAP_REMEMBER.key) == null) {
    const f = { ...DEFAULT_FILTERS, ...JSON.parse(old) } as MapFilters;
    const fields = { ...DEFAULT_FILTERS.fields, ...f.fields };
    localStorage.setItem(MAP_REMEMBER.key, formatQuery(writeQuery(MAP_QUERY, { ...f, q: '', archived: false, fields: FIELD_KEYS.filter((k) => fields[k]) })));
  }
} catch { /* storage unavailable or unreadable: defaults */ }

type Selection =
  | { kind: 'connection'; key: string }
  | { kind: 'feature'; slug: string; id: string }
  | { kind: 'service'; slug: string };

const SCOPES: { value: FeatureScope; label: string }[] = [
  { value: 'connected', label: 'Connected features' },
  { value: 'flows', label: 'Features on flows' },
  { value: 'all', label: 'All features' },
];

export function ServiceMapPage({ onOpenFlow, onOpenProject }: {
  onOpenFlow: (id: string) => void;
  onOpenProject: (slug: string, hash?: string) => void;
}) {
  const [data, setData] = useState<ServiceMapData | null>(null);
  const [error, setError] = useState('');
  const [mq, setMq] = useQueryState(MAP_QUERY, MAP_URL, MAP_REMEMBER);
  const { q: query, archived } = mq;
  const setQuery = (q: string) => setMq({ q });
  const setArchived = (on: boolean) => setMq({ archived: on });
  const filters = useMemo<MapFilters>(() => ({
    hiddenServices: mq.hiddenServices, connectionKinds: mq.connectionKinds, featureKinds: mq.featureKinds,
    scope: mq.scope, internal: mq.internal,
    fields: Object.fromEntries(FIELD_KEYS.map((k) => [k, mq.fields.includes(k)])) as unknown as MapFields,
  }), [mq]);
  const [hover, setHover] = useState<{ slug: string; feature?: string } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const { pal, KIND } = usePalette();
  const { pz, dragging, canvasRef, handlers, fitTo, zoomIn, zoomOut } = usePanZoom();

  const setFilters = ({ fields, ...rest }: MapFilters) => setMq({ ...rest, fields: FIELD_KEYS.filter((k) => fields[k]) });

  useEffect(() => {
    let live = true;
    setError('');
    fetch(`/api/service-map${archived ? '?archived=1' : ''}`)
      .then(async (r) => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then((d: ServiceMapData) => {
        if (!live) return;
        setData({
          services: (d.services ?? []).map((s) => ({ ...s, features: (s.features ?? []).map((f) => ({ ...f, tags: f.tags ?? [], flows: f.flows ?? [] })) })),
          connections: d.connections ?? [],
          internal: d.internal ?? [],
        });
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load the service map'); });
    return () => { live = false; };
  }, [archived]);

  const visible = useMemo(() => (data ? applyFilters(data, filters) : null), [data, filters]);
  const layout = useMemo(() => (visible ? layoutMap(visible) : null), [visible]);

  // Fit when the set of visible services changes (first load, a service toggled).
  const serviceSig = visible?.services.map((s) => s.slug).join(',') ?? '';
  const fitted = useRef('');
  useEffect(() => {
    if (!layout || fitted.current === serviceSig) return;
    fitted.current = serviceSig;
    const id = requestAnimationFrame(() => fitTo(layout.cards.length ? layout.bounds : null, 48));
    return () => cancelAnimationFrame(id);
  }, [layout, serviceSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const matches = (s: MapService, f: MapFeature) => !q || f.title.toLowerCase().includes(q) || (f.operation ?? '').toLowerCase().includes(q) || s.name.toLowerCase().includes(q);
  const focus = visible && hover ? neighbourhood(visible, hover) : null;
  const selectedConn = selection?.kind === 'connection' && visible ? visible.connections.find((c) => connectionKey(c) === selection.key) : undefined;

  const counts = useMemo(() => {
    const kinds = new Map<EdgeKind, number>();
    for (const c of [...(data?.connections ?? []), ...(filters.internal ? data?.internal ?? [] : [])]) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
    const fkinds = new Map<FeatureKind, number>();
    for (const s of data?.services ?? []) for (const f of s.features) fkinds.set(f.kind, (fkinds.get(f.kind) ?? 0) + 1);
    return { kinds, fkinds };
  }, [data, filters.internal]);

  const filtered = filters.hiddenServices.length > 0 || filters.connectionKinds.length < ALL_EDGE_KINDS.length
    || filters.featureKinds.length < ALL_FEATURE_KINDS.length || filters.scope !== DEFAULT_FILTERS.scope;

  const colors = [...new Set([pal.treeEdge, pal.accent, pal.danger])];
  const marker = (c: string) => `url(#arr-${colors.indexOf(c)})`;

  return (
    <div className="smap-page">
      <div className="smap-toolbar">
        <div className="smap-head">
          <h2 className="overview-section-title smap-title">Service map</h2>
          {visible && (
            <span className="smap-summary">
              {visible.services.length} service{visible.services.length === 1 ? '' : 's'} · {visible.connections.length} connection{visible.connections.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {/* The Flows page's filter bar: search, then the labelled filter dropdowns and reset,
            then how the map is drawn. */}
        <div className="flows-filter-bar smap-filter-bar">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search the map…"
            ariaLabel="Find a feature or service"
            shortcut={['/']}
            expand
            className="filter-search smap-search"
          />
          <div className="activity-filters" role="group" aria-label="Service map filters">
            <span className="activity-filters-label">Filter</span>
            <MultiSelectDropdown<string>
              label="Services"
              options={(data?.services ?? []).map((s) => ({ value: s.slug, label: s.name }))}
              selected={new Set((data?.services ?? []).map((s) => s.slug).filter((slug) => !filters.hiddenServices.includes(slug)))}
              onChange={(next) => setFilters({ ...filters, hiddenServices: (data?.services ?? []).map((s) => s.slug).filter((slug) => !next.has(slug)) })}
            />
            <MultiSelectDropdown<EdgeKind>
              label="Connections"
              options={EDGE_KINDS.map((k) => ({ value: k.value, label: `${k.label} (${counts.kinds.get(k.value) ?? 0})`, icon: <EdgeSwatch kind={k.value} color={edgeColor(k.value, pal)} /> }))}
              selected={new Set(filters.connectionKinds)}
              onChange={(next) => setFilters({ ...filters, connectionKinds: ALL_EDGE_KINDS.filter((k) => next.has(k)) })}
            />
            <MultiSelectDropdown<FeatureKind>
              label="Feature kinds"
              options={ALL_FEATURE_KINDS.map((k) => ({ value: k, label: `${capitalise(k)} (${counts.fkinds.get(k) ?? 0})`, icon: <span className="select-dropdown-dot" style={{ background: KIND[k].stripe }} aria-hidden="true" /> }))}
              selected={new Set(filters.featureKinds)}
              onChange={(next) => setFilters({ ...filters, featureKinds: ALL_FEATURE_KINDS.filter((k) => next.has(k)) })}
            />
            <SelectDropdown<FeatureScope>
              label="Features shown"
              options={SCOPES}
              value={filters.scope}
              onChange={(scope) => setFilters({ ...filters, scope })}
            />
            <button
              type="button"
              className={`activity-filter-clear${filtered ? ' activity-filter-clear-visible' : ''}`}
              onClick={() => setFilters({ ...filters, hiddenServices: [], connectionKinds: ALL_EDGE_KINDS, featureKinds: ALL_FEATURE_KINDS, scope: DEFAULT_FILTERS.scope })}
              title="Reset filters"
              aria-label="Reset filters"
            >&#x2715;</button>
          </div>
          <div className="flows-filter-bar-end">
            <DisplayMenu filters={filters} onChange={setFilters} archived={archived} onArchived={setArchived} />
          </div>
        </div>
      </div>

      <div className="smap-body">
        {error ? (
          <div className="smap-empty" role="alert">{error}</div>
        ) : !data || !layout || !visible ? (
          <div className="smap-empty" role="status" aria-label="Loading the service map"><Skeleton height={240} width="60%" /></div>
        ) : data.services.length === 0 ? (
          <div className="smap-empty">No projects yet. Register a repository on the Projects page; each one is a service here.</div>
        ) : (
          <div
            ref={canvasRef}
            className="flow-graph-canvas smap-canvas"
            style={{ cursor: dragging ? 'grabbing' : 'grab' }}
            data-testid="service-map-canvas"
            {...handlers}
          >
            <svg width="100%" height="100%" role="group" aria-label={`${visible.services.length} services, ${visible.connections.length} connections`}>
              <defs><ArrowMarkers colors={colors} /></defs>
              <g transform={`translate(${pz.x},${pz.y}) scale(${pz.scale})`}>
                {layout.links.map(({ connection: c, x1, y1, x2, y2, internal, back }, i) => {
                  const key = connectionKey(c);
                  const selected = selectedConn && connectionKey(selectedConn) === key;
                  const lit = focus?.connections.has(key);
                  const dim = (focus && !lit) || (q && !selected);
                  const stroke = selected ? pal.accent : edgeColor(c.kind, pal, { tainted: c.tainted });
                  // A connection running right to left goes round under the map, in its own lane.
                  const lane = layout.bounds.maxY + 28 + (i % 6) * 10;
                  const d = internal
                    ? `M ${x1} ${y1} C ${x1 + 70} ${y1} ${x2 + 70} ${y2} ${x2} ${y2}`
                    : back
                      ? `M ${x1} ${y1} C ${x1 + 60} ${y1} ${x1 + 60} ${lane} ${x1} ${lane} L ${x2} ${lane} C ${x2 - 60} ${lane} ${x2 - 60} ${y2} ${x2} ${y2}`
                      : horizontalPath(x1, y1, x2, y2);
                  return (
                    <g key={key} className="smap-link" data-connection={key} style={{ opacity: dim ? 0.18 : 1 }}>
                      <path d={d} fill="none" stroke={stroke} strokeWidth={(selected || lit ? 2.5 : 1.6) + Math.min(3, (c.count - 1) * 0.5)}
                        strokeDasharray={EDGE_DASH[c.kind]} markerEnd={marker(stroke)} />
                      {c.trustBoundary && (() => {
                        const mx = (x1 + x2) / 2 + (internal ? 52 : 0);
                        const my = back ? lane : (y1 + y2) / 2;
                        return <rect x={mx - 2} y={my - 9} width={4} height={18} rx={1} fill={pal.warn} style={{ pointerEvents: 'none' }} />;
                      })()}
                      <path d={d} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: 'pointer' }}
                        role="button" aria-label={`${c.kind} connection from ${c.fromProject} to ${c.toProject}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setSelection(selected ? null : { kind: 'connection', key })} />
                    </g>
                  );
                })}

                {layout.cards.map((card) => {
                  const s = card.service;
                  const cardLit = !focus || [...focus.features].some((k) => k.startsWith(s.slug + ':')) || hover?.slug === s.slug;
                  const selectedService = selection?.kind === 'service' && selection.slug === s.slug;
                  return (
                    <g key={s.slug} className="smap-card" data-service={s.slug}
                      style={{ transform: `translate(${card.x}px, ${card.y}px)`, opacity: cardLit ? 1 : 0.4 }}>
                      <rect width={CARD_W} height={card.h} rx={6} fill={pal.bgCard} stroke={selectedService ? pal.accent : pal.cardBorder} strokeWidth={selectedService ? 1.5 : 1} />
                      <g
                        className="smap-card-header"
                        role="button"
                        tabIndex={0}
                        aria-label={`Service ${s.name}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerEnter={() => setHover({ slug: s.slug })}
                        onPointerLeave={() => setHover(null)}
                        onClick={() => setSelection({ kind: 'service', slug: s.slug })}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelection({ kind: 'service', slug: s.slug }); } }}
                        style={{ cursor: 'pointer' }}
                      >
                        <rect width={CARD_W} height={HEADER_H - 6} rx={6} fill="transparent" />
                        <text x={14} y={22} fontSize={13} fontWeight={600} fontFamily="var(--font-sans, system-ui)" fill={pal.textMain}>{truncate(s.name, 30)}</text>
                        <text x={14} y={37} fontSize={10} fontFamily="var(--font-mono, monospace)" fill={pal.textSub} fillOpacity={0.7}>
                          {s.features.length} feature{s.features.length === 1 ? '' : 's'}
                        </text>
                      </g>
                      <line x1={0} x2={CARD_W} y1={HEADER_H - 6} y2={HEADER_H - 6} stroke={pal.cardBorder} />
                      {s.features.length === 0 && (
                        <text x={14} y={HEADER_H + ROW_H / 2 + 4} fontSize={11} fontStyle="italic" fill={pal.textSub}>No features match the filters</text>
                      )}
                      {s.features.map((f) => {
                        const y = card.rowY.get(f.id)! - ROW_H / 2;
                        const k = KIND[f.kind] ?? KIND.externality;
                        const fk = featureKey(s.slug, f.id);
                        const lit = focus?.features.has(fk);
                        const hit = q && matches(s, f);
                        const selected = selection?.kind === 'feature' && selection.slug === s.slug && selection.id === f.id;
                        const { method, path } = filters.fields.operation ? parseMethod(f.operation ?? '') : { method: null, path: '' };
                        const title = filters.fields.operation && path && method ? path : f.title;
                        const right = [
                          filters.fields.protocol && f.protocol ? f.protocol : '',
                          filters.fields.flows && f.flowCount ? `${f.flowCount}⇢` : '',
                        ].filter(Boolean).join('  ');
                        return (
                          <g
                            key={f.id}
                            className="smap-feature"
                            data-feature={fk}
                            transform={`translate(0, ${y})`}
                            role="button"
                            tabIndex={0}
                            aria-label={`${f.kind} ${f.title} on ${s.name}`}
                            aria-pressed={selected}
                            style={{ cursor: 'pointer', opacity: (focus && !lit && hover?.feature) || (q && !hit) ? 0.35 : 1 }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onPointerEnter={() => setHover({ slug: s.slug, feature: f.id })}
                            onPointerLeave={() => setHover(null)}
                            onClick={() => setSelection(selected ? null : { kind: 'feature', slug: s.slug, id: f.id })}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelection({ kind: 'feature', slug: s.slug, id: f.id }); } }}
                          >
                            <rect x={4} y={1} width={CARD_W - 8} height={ROW_H - 2} rx={4}
                              fill={selected || lit || hit ? pal.bgRow : 'transparent'} stroke={selected ? k.stripe : 'none'} />
                            <circle cx={16} cy={ROW_H / 2} r={4} fill={k.stripe} opacity={f.missing ? 0.4 : 1} />
                            {method && (
                              <g transform={`translate(28, ${ROW_H / 2 - 8})`}>
                                <rect width={badgeW(method)} height={16} rx={3} fill={k.stripe} fillOpacity={0.12} stroke={k.stripe} strokeOpacity={0.5} strokeWidth={0.75} />
                                <text x={badgeW(method) / 2} y={11.5} textAnchor="middle" fontSize={9} fontWeight={700} fontFamily="var(--font-mono, monospace)" fill={k.stripe}>{method}</text>
                              </g>
                            )}
                            <text x={method ? 34 + badgeW(method) : 28} y={ROW_H / 2 + 4} fontSize={12} fontFamily="var(--font-sans, system-ui)"
                              fill={f.missing ? pal.textSub : pal.textMain} textDecoration={f.missing ? 'line-through' : undefined}>
                              {truncate(title, method ? 24 : 30)}
                            </text>
                            {right && (
                              <text x={CARD_W - (filters.fields.findings && f.openFindings ? 40 : 14)} y={ROW_H / 2 + 4} textAnchor="end" fontSize={10}
                                fontFamily="var(--font-mono, monospace)" fill={pal.textSub}>{right}</text>
                            )}
                            {filters.fields.findings && f.openFindings > 0 && (
                              <g transform={`translate(${CARD_W - 34}, ${ROW_H / 2 - 8})`}>
                                <rect width={24} height={16} rx={8} fill={pal.danger} fillOpacity={0.15} />
                                <text x={12} y={11.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill={pal.danger}>{f.openFindings}</text>
                              </g>
                            )}
                            <title>{`${f.kind} · ${f.title}${f.operation ? ` · ${f.operation}` : ''}${f.openFindings ? ` · ${f.openFindings} open finding${f.openFindings === 1 ? '' : 's'}` : ''}`}</title>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            </svg>
            {visible.connections.length === 0 && (
              <div className="smap-hint">No connections to draw. Connections come from flows whose steps are on different projects.</div>
            )}
          </div>
        )}
        {visible && visible.connections.length > 0 && <MapLegend connections={visible.connections} />}
        <GraphControls onFit={() => layout && fitTo(layout.cards.length ? layout.bounds : null, 48)} onZoomIn={zoomIn} onZoomOut={zoomOut} />
        {selection && data && visible && (
          <SelectionPanel
            data={data}
            selection={selection}
            connection={selectedConn}
            visibleConnections={visible.connections}
            onClose={() => setSelection(null)}
            onSelect={setSelection}
            onOpenFlow={onOpenFlow}
            onOpenProject={onOpenProject}
          />
        )}
      </div>
    </div>
  );
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function EdgeSwatch({ kind, color }: { kind: EdgeKind; color: string }) {
  return (
    <svg width="18" height="6" aria-hidden="true" className="smap-swatch">
      <line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeWidth="2" strokeDasharray={EDGE_DASH[kind]} />
    </svg>
  );
}

/** The key to the lines on the map: the connection kinds drawn, and the marks some carry. */
function MapLegend({ connections }: { connections: MapConnection[] }) {
  const { pal } = usePalette();
  const kinds = EDGE_KINDS.filter((k) => connections.some((c) => c.kind === k.value));
  return (
    <div className="smap-legend" aria-label="Key">
      {kinds.map((k) => (
        <span key={k.value} className="smap-legend-item"><EdgeSwatch kind={k.value} color={edgeColor(k.value, pal)} />{k.label}</span>
      ))}
      {connections.some((c) => c.tainted) && (
        <span className="smap-legend-item"><EdgeSwatch kind="call" color={pal.danger} />Tainted</span>
      )}
      {connections.some((c) => c.trustBoundary) && (
        <span className="smap-legend-item"><span className="smap-legend-boundary" style={{ background: pal.warn }} aria-hidden="true" />Trust boundary</span>
      )}
    </div>
  );
}

/** How the map is drawn: which connections and flows count, and what each feature row shows.
 *  Bench's dropdown look, holding checkboxes. */
function DisplayMenu({ filters, onChange, archived, onArchived }: {
  filters: MapFilters;
  onChange: (f: MapFilters) => void;
  archived: boolean;
  onArchived: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const field = (key: keyof MapFilters['fields']) => ({
    on: filters.fields[key],
    set: (on: boolean) => onChange({ ...filters, fields: { ...filters.fields, [key]: on } }),
  });
  const sections: { title: string; items: { label: string; on: boolean; set: (on: boolean) => void }[] }[] = [
    { title: 'Include', items: [
      { label: 'Connections within a service', on: filters.internal, set: (on) => onChange({ ...filters, internal: on }) },
      { label: 'Archived flows', on: archived, set: onArchived },
    ] },
    { title: 'On each feature', items: [
      { label: 'Operation (method and path)', ...field('operation') },
      { label: 'Protocol', ...field('protocol') },
      { label: 'Flow count', ...field('flows') },
      { label: 'Open findings', ...field('findings') },
    ] },
  ];
  return (
    <div className="multi-select smap-display" ref={ref}>
      <div className="multi-select-pill">
        <button ref={trigger} type="button" className="multi-select-trigger" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Display
          <span className="multi-select-chevron">{open ? '\u25B4' : '\u25BE'}</span>
        </button>
      </div>
      {open && (
        <div className="multi-select-dropdown smap-display-menu">
          {sections.map((sec) => (
            <div key={sec.title} role="group" aria-label={sec.title}>
              <div className="smap-display-title">{sec.title}</div>
              {sec.items.map((it) => (
                <label key={it.label} className={`multi-select-option smap-display-item${it.on ? ' multi-select-option-active' : ''}`}>
                  <input type="checkbox" className="smap-display-input" checked={it.on} onChange={(e) => it.set(e.target.checked)} />
                  <span className="multi-select-check" aria-hidden="true" />
                  {it.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectionPanel({ data, selection, connection, visibleConnections, onClose, onSelect, onOpenFlow, onOpenProject }: {
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
  const featureLabel = (slug: string, id: string) => `${service(slug)?.name ?? slug} · ${feature(slug, id)?.title ?? id}`;
  const flowList = (flows: { id: string; name: string }[]) => (
    flows.length === 0 ? <div className="smap-muted">Not on any flow.</div> : (
      <ul className="smap-list">
        {flows.map((f) => <li key={f.id}><button type="button" className="smap-link-btn" onClick={() => onOpenFlow(f.id)}>{f.name}</button></li>)}
      </ul>
    )
  );
  const connList = (list: MapConnection[]) => (
    list.length === 0 ? <div className="smap-muted">No connections shown.</div> : (
      <ul className="smap-list">
        {list.map((c) => (
          <li key={connectionKey(c)}>
            <button type="button" className="smap-link-btn" onClick={() => onSelect({ kind: 'connection', key: connectionKey(c) })}>
              {featureLabel(c.fromProject, c.fromFeature)} → {featureLabel(c.toProject, c.toFeature)}
            </button>
            <span className="smap-muted"> {c.kind}{c.protocol ? ` · ${c.protocol}` : ''}</span>
          </li>
        ))}
      </ul>
    )
  );

  let title = '';
  let body: React.ReactNode = null;
  if (selection.kind === 'connection' && connection) {
    title = 'Connection';
    body = (
      <>
        <div className="smap-route">{featureLabel(connection.fromProject, connection.fromFeature)} <span aria-hidden>→</span> {featureLabel(connection.toProject, connection.toFeature)}</div>
        <dl className="smap-facts">
          <dt>Kind</dt><dd>{connection.kind}</dd>
          {connection.protocol && <><dt>Protocol</dt><dd>{connection.protocol}</dd></>}
          <dt>Identity</dt><dd>{connection.auth.length ? connection.auth.join(', ') : '—'}</dd>
          <dt>Trust boundary</dt><dd>{connection.trustBoundary ? 'crossed' : 'no'}</dd>
          <dt>Tainted data</dt><dd>{connection.tainted ? 'yes' : 'no'}</dd>
          <dt>Seen</dt><dd>{connection.count} time{connection.count === 1 ? '' : 's'}</dd>
        </dl>
        <h3 className="smap-panel-sub">Flows</h3>
        {flowList(connection.flows)}
      </>
    );
  } else if (selection.kind === 'feature') {
    const f = feature(selection.slug, selection.id);
    title = f?.title ?? selection.id;
    const mine = visibleConnections.filter((c) => (c.fromProject === selection.slug && c.fromFeature === selection.id) || (c.toProject === selection.slug && c.toFeature === selection.id));
    body = f && (
      <>
        <div className="smap-route">{f.kind} on {service(selection.slug)?.name}{f.operation ? ` · ${f.operation}` : ''}</div>
        {f.missing ? <div className="smap-muted">A flow names this feature, but the project no longer has it.</div> : (
          <button type="button" className="baseline-action-btn baseline-action-btn-outline" onClick={() => onOpenProject(selection.slug, `#/feature/${f.id}`)}>Open feature</button>
        )}
        {f.openFindings > 0 && <div className="smap-findings">{f.openFindings} open finding{f.openFindings === 1 ? '' : 's'}</div>}
        <h3 className="smap-panel-sub">Connections</h3>
        {connList(mine)}
        <h3 className="smap-panel-sub">Flows</h3>
        {flowList(f.flows)}
      </>
    );
  } else if (selection.kind === 'service') {
    const s = service(selection.slug);
    title = s?.name ?? selection.slug;
    const out = visibleConnections.filter((c) => c.fromProject === selection.slug && c.toProject !== selection.slug);
    const inc = visibleConnections.filter((c) => c.toProject === selection.slug && c.fromProject !== selection.slug);
    body = s && (
      <>
        <button type="button" className="baseline-action-btn baseline-action-btn-outline" onClick={() => onOpenProject(s.slug)}>Open project</button>
        <h3 className="smap-panel-sub">Calls out ({out.length})</h3>
        {connList(out)}
        <h3 className="smap-panel-sub">Called by ({inc.length})</h3>
        {connList(inc)}
      </>
    );
  }
  return (
    <aside className="map-step-panel smap-panel" aria-label={title || 'Details'}>
      <div className="map-step-panel-header">
        <span className="map-step-panel-link-label">{title}</span>
        <button className="icon-btn map-step-panel-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="map-step-panel-body">{body}</div>
    </aside>
  );
}
