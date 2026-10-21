import { useMemo } from 'react';
import { ToneChip } from '@bench/components/SelectDropdown';
import { KIND_COLORS } from '@bench/components/FeatureCard';
import { isOpenFinding, categoryMeta } from '@bench/core/finding-categories';
import { SEVERITY_OPTIONS, FINDING_STATUS_OPTIONS, FEATURE_KIND_OPTIONS, FEATURE_STATUS_OPTIONS, METHOD_COLORS } from '@bench/core/status-options';
import type { Comment, Feature } from '@bench/core/types';
import type { Finding, Project } from './api';
import type { FlowSummary } from './flows';
import { SLA_DAYS, ageDays, plural, type Sev } from './projectInsight';
import { remoteToHttp, repoLabel } from './repoLinks';
import type { Hit, SearchData } from './searchModel';
import { Highlight, KindIcon } from './SearchParts';

// A search page result as a card: what it is and where it lives at a glance (severity and status,
// kind, file and line, age), a few lines of its text, and what it connects to: the features a
// finding affects, the flows a feature is on, the finding or feature a comment is about.

/** Lookups across every project, built once per index for the cards to draw on. */
export interface SearchContext {
  projects: Map<string, Project>;
  features: Map<string, Feature>;
  findings: Map<string, Finding>;
  /** Open findings affecting each feature. */
  openByFeature: Map<string, number>;
  flowsByFeature: Map<string, FlowSummary[]>;
  /** Comments in each thread. */
  threadSize: Map<string, number>;
}

const key = (slug: string, id: string) => `${slug}:${id}`;

export function useSearchContext(projects: Project[], data: Record<string, SearchData>, flows: FlowSummary[], comments: Record<string, Comment[]> | null): SearchContext {
  return useMemo(() => {
    const ctx: SearchContext = {
      projects: new Map(projects.map((p) => [p.slug, p])),
      features: new Map(), findings: new Map(), openByFeature: new Map(), flowsByFeature: new Map(), threadSize: new Map(),
    };
    for (const [slug, d] of Object.entries(data)) {
      for (const f of d.features) ctx.features.set(key(slug, f.id), f);
      for (const f of d.findings) {
        ctx.findings.set(key(slug, f.id), f);
        if (isOpenFinding(f)) for (const id of f.features ?? []) ctx.openByFeature.set(key(slug, id), (ctx.openByFeature.get(key(slug, id)) ?? 0) + 1);
      }
    }
    for (const fl of flows) {
      const seen = new Set<string>();
      for (const s of fl.shape ?? []) {
        if (!s.projectSlug || !s.featureId) continue;
        const k = key(s.projectSlug, s.featureId);
        if (seen.has(k)) continue;
        seen.add(k);
        ctx.flowsByFeature.set(k, [...(ctx.flowsByFeature.get(k) ?? []), fl]);
      }
    }
    for (const [slug, cs] of Object.entries(comments ?? {})) {
      for (const c of cs) ctx.threadSize.set(key(slug, c.threadId || c.id), (ctx.threadSize.get(key(slug, c.threadId || c.id)) ?? 0) + 1);
    }
    return ctx;
  }, [projects, data, flows, comments]);
}

/** "today", "3d ago", "5mo ago", "2y ago". */
export function ago(iso?: string): string | null {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  const d = Math.floor(ageDays(iso));
  if (d < 1) return 'today';
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

const tone = <T extends string>(opts: { value: T; label: string; tone: string }[], v: string) => opts.find((o) => o.value === v);
const where = (a?: { fileId: string; lineRange?: { start: number; end: number } }) =>
  a?.fileId ? `${a.fileId}${a.lineRange ? `:${a.lineRange.start}${a.lineRange.end !== a.lineRange.start ? `–${a.lineRange.end}` : ''}` : ''}` : null;
const METHODS = new Set(Object.keys(METHOD_COLORS));
/** A link chip's leading marker: the method badge on an HTTP interface, else the kind's dot. */
function FeatureMark({ f }: { f: Feature }) {
  const m = f.operation?.toUpperCase();
  return m && METHODS.has(m)
    ? <span className="feature-method-badge" style={{ background: METHOD_COLORS[m] }}>{m}</span>
    : <span className="home-dot" style={{ background: KIND_COLORS[f.kind] }} aria-hidden="true" />;
}
const LINKS_MAX = 4;

export function SearchResultCard({ h, q, ctx, onOpen, onOpenFlow }: {
  h: Hit;
  q: string;
  ctx: SearchContext;
  onOpen: (slug: string, hash?: string) => void;
  onOpenFlow: (id: string) => void;
}) {
  const project = ctx.projects.get(h.slug);
  const pname = project?.name ?? h.slug;
  const ref = h.ref;
  const chips: React.ReactNode[] = [];
  const meta: (React.ReactNode | null | undefined | false)[] = [];
  let links: { label: string; items: React.ReactNode[] } | null = null;
  let text = h.detail;
  let title: React.ReactNode = <Highlight text={h.title} q={q} />;
  let lead: React.ReactNode = null;

  const linkChip = (k: string, label: React.ReactNode, onClick: () => void, aria: string) => (
    <button key={k} type="button" className="search-card-link" onClick={onClick} aria-label={aria}>{label}</button>
  );

  if (ref?.type === 'finding') {
    const f = ref.finding;
    const sev = tone(SEVERITY_OPTIONS, f.severity);
    const st = tone(FINDING_STATUS_OPTIONS, f.status);
    if (sev) chips.push(<ToneChip key="sev" label={sev.label} tone={sev.tone} />);
    if (st) chips.push(<ToneChip key="st" label={st.label} tone={st.tone} />);
    const open = isOpenFinding(f);
    if (open && ageDays(f.createdAt) > SLA_DAYS[f.severity as Sev]) chips.push(<span key="sla" className="search-card-flag">past SLA</span>);
    meta.push(
      pname,
      f.category && categoryMeta(f.category).label,
      f.cwe && <span className="search-card-mono">{f.cwe}</span>,
      f.cve && <span className="search-card-mono">{f.cve}</span>,
      f.externalId && <span className="search-card-mono">{f.externalId}</span>,
      where(f.anchor) && <span className="search-card-mono search-card-file">{where(f.anchor)}</span>,
      ago(f.createdAt) && `opened ${ago(f.createdAt)}`,
      !open && f.resolvedAt && `resolved ${ago(f.resolvedAt)}`,
      (f.commentCount ?? 0) > 0 && plural(f.commentCount!, 'comment'),
    );
    const affected = (f.features ?? []).map((id) => ctx.features.get(key(h.slug, id))).filter((x): x is Feature => !!x);
    if (affected.length) {
      links = {
        label: 'Affects',
        items: affected.slice(0, LINKS_MAX).map((ft) => linkChip(ft.id, <><FeatureMark f={ft} /><span>{ft.title}</span></>, () => onOpen(h.slug, `#/feature/${ft.id}`), `Feature ${ft.title}`)),
      };
      if (affected.length > LINKS_MAX) links.items.push(<span key="more" className="search-card-more">+{affected.length - LINKS_MAX}</span>);
    }
  } else if (ref?.type === 'feature') {
    const f = ref.feature;
    const kind = tone(FEATURE_KIND_OPTIONS, f.kind);
    const st = tone(FEATURE_STATUS_OPTIONS, f.status);
    if (kind) chips.push(<ToneChip key="kind" label={kind.label} tone={kind.tone} />);
    if (st && f.status !== 'active') chips.push(<ToneChip key="st" label={st.label} tone={st.tone} />);
    const openN = ctx.openByFeature.get(key(h.slug, f.id)) ?? 0;
    if (openN) chips.push(<span key="open" className="search-card-flag">{plural(openN, 'open finding')}</span>);
    meta.push(
      pname,
      f.protocol && <span className="search-card-mono">{f.protocol}</span>,
      f.direction && (f.direction === 'in' ? 'inbound' : 'outbound'),
      where(f.anchor) && <span className="search-card-mono search-card-file">{where(f.anchor)}</span>,
      ago(f.createdAt) && `mapped ${ago(f.createdAt)}`,
      (f.linkedFeatures?.length ?? 0) > 0 && plural(f.linkedFeatures!.length, 'link'),
    );
    if (f.tags?.length) meta.push(<span className="search-card-tags">{f.tags.map((t) => <span key={t} className="search-card-tag">{t}</span>)}</span>);
    const flows = ctx.flowsByFeature.get(key(h.slug, f.id)) ?? [];
    if (flows.length) {
      links = {
        label: flows.length === 1 ? 'On flow' : 'On flows',
        items: flows.slice(0, LINKS_MAX).map((fl) => linkChip(fl.id, <span>{fl.name}</span>, () => onOpenFlow(fl.id), `Flow ${fl.name}`)),
      };
      if (flows.length > LINKS_MAX) links.items.push(<span key="more" className="search-card-more">+{flows.length - LINKS_MAX}</span>);
    }
  } else if (ref?.type === 'comment') {
    const c = ref.comment;
    // A comment is its text: the longer excerpt stands in for the title.
    if (h.detail) { title = <Highlight text={h.detail} q={q} />; text = undefined; }
    if (c.commentType) chips.push(<ToneChip key="type" label={c.commentType[0].toUpperCase() + c.commentType.slice(1)} />);
    if (c.resolvedCommit) chips.push(<ToneChip key="res" label="Resolved" tone="var(--status-closed)" />);
    const replies = (ctx.threadSize.get(key(h.slug, c.threadId || c.id)) ?? 1) - 1;
    meta.push(pname, c.author || 'unknown author', ago(c.timestamp), c.parentId ? 'reply' : replies > 0 && plural(replies, 'reply').replace('replys', 'replies'));
    const finding = c.findingId ? ctx.findings.get(key(h.slug, c.findingId)) : undefined;
    const feature = c.featureId ? ctx.features.get(key(h.slug, c.featureId)) : undefined;
    if (finding) {
      links = { label: 'On finding', items: [linkChip('f', <><span className="home-dot" style={{ background: `var(--severity-${finding.severity})` }} aria-hidden="true" /><span>{finding.title}</span></>, () => onOpen(h.slug, `#/finding/${finding.id}`), `Finding ${finding.title}`)] };
    } else if (feature) {
      links = { label: 'On feature', items: [linkChip('x', <><FeatureMark f={feature} /><span>{feature.title}</span></>, () => onOpen(h.slug, `#/feature/${feature.id}`), `Feature ${feature.title}`)] };
    } else if (where(c.anchor)) {
      meta.push(<span className="search-card-mono search-card-file">{where(c.anchor)}</span>);
    }
  } else if (ref?.type === 'project') {
    const p = ref.project;
    const remote = remoteToHttp(p.remoteUrl ?? '')?.replace(/^https?:\/\//, '');
    meta.push(
      <span className="search-card-mono search-card-file" title={p.repoPath}>{remote || repoLabel(p.repoPath)}</span>,
      p.owner && `owner ${p.owner}`,
      p.activity?.lastCommitAt && `last commit ${ago(p.activity.lastCommitAt)}`,
      p.riskData?.latestBaselineAt && `baseline ${ago(p.riskData.latestBaselineAt)}`,
    );
    if (p.tags?.length) meta.push(<span className="search-card-tags">{p.tags.map((t) => <span key={t} className="search-card-tag">{t}</span>)}</span>);
    const bySev = p.stats?.bySeverityOpen ?? {};
    const sevs = SEVERITY_OPTIONS.filter((s) => (bySev[s.value] ?? 0) > 0);
    const openTotal = p.stats?.findingsOpen ?? 0;
    text = undefined;
    lead = (
      <div className="search-card-stats">
        <span>{plural(openTotal, 'open finding')}</span>
        {sevs.map((s) => <span key={s.value} className="search-card-sev"><span className="home-dot" style={{ background: s.tone }} aria-hidden="true" />{bySev[s.value]} {s.value}</span>)}
        {p.stats?.featuresTotal != null && <span>{plural(p.stats.featuresTotal, 'feature')}</span>}
      </div>
    );
  } else {
    meta.push(h.sub);
  }

  const shown = meta.filter((m): m is React.ReactNode => !!m);
  return (
    <li
      className="search-card"
      // The whole card opens the hit; its own links (and the title button, for keyboards) win.
      onClick={(e) => { if (!(e.target as Element).closest('button, a')) onOpen(h.slug, h.hash); }}
    >
      <span className="search-card-icon"><KindIcon kind={h.kind} /></span>
      <div className="search-card-body">
        <div className="search-card-head">
          <button type="button" className={`search-page-row search-card-title${h.kind === 'comment' ? ' search-card-title--text' : ''}`} onClick={() => onOpen(h.slug, h.hash)}>
            {/* The method badge leads an HTTP interface; other kinds have their chip on the right. */}
            {h.method && <span className="feature-method-badge" style={{ background: METHOD_COLORS[h.method] }}>{h.method}</span>}
            <span className="home-search-label">{title}</span>
          </button>
          {chips.length > 0 && <span className="search-card-chips">{chips}</span>}
        </div>
        {shown.length > 0 && (
          <div className="search-card-meta home-search-sub">
            {shown.map((m, i) => <span key={i} className="search-card-meta-item">{m}</span>)}
          </div>
        )}
        {lead}
        {text && <p className="search-card-text"><Highlight text={text} q={q} /></p>}
        {links && links.items.length > 0 && (
          <div className="search-card-links">
            <span className="search-card-links-label">{links.label}</span>
            {links.items}
          </div>
        )}
      </div>
    </li>
  );
}
