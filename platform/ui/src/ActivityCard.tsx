import { ToneChip } from '@bench/components/SelectDropdown';
import { isOpenFinding, categoryMeta } from '@bench/core/finding-categories';
import { SEVERITY_OPTIONS, FINDING_STATUS_OPTIONS, FEATURE_KIND_OPTIONS, FEATURE_STATUS_OPTIONS, METHOD_COLORS } from '@bench/core/status-options';
import type { Feature } from '@bench/core/types';
import { ageDays, plural } from './projectInsight';
import { excerpt } from './searchModel';
import { KindIcon } from './SearchParts';
import { ago, optionOf, where, FeatureMark, LINKS_MAX, type SearchContext } from './SearchResultCard';
import type { ActivityItem } from './activityModel';

// One item of the activity feed, at a glance: what happened and where, its severity and status,
// a few lines of its description, what it connects to, and the last word on it.

/** Markdown marks dropped: bold, headings, code ticks. */
const plain = (text: string) => text.replace(/\*\*|__|`|^#+\s*/gm, '');
const METHODS = new Set(Object.keys(METHOD_COLORS));
const EVENT: Record<ActivityItem['kind'], string> = { finding: 'New finding', feature: 'New feature', sla: 'Past SLA' };

/** "14:32" today, else "3d ago" (the day heading gives the date). */
function when(iso: string): string {
  const d = new Date(iso);
  return ageDays(iso) < 1 && d.getDate() === new Date().getDate()
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : ago(iso) ?? '';
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function ActivityCard({ item, ctx, onOpen, onOpenFlow }: {
  item: ActivityItem;
  ctx: SearchContext;
  onOpen: (slug: string, hash?: string) => void;
  onOpenFlow: (id: string) => void;
}) {
  const project = ctx.projects.get(item.slug);
  const pname = project?.name ?? item.slug;
  const chips: React.ReactNode[] = [];
  const meta: (React.ReactNode | null | undefined | false)[] = [];
  let links: { label: string; items: React.ReactNode[] } | null = null;
  let text: string | undefined;
  let method: string | undefined;
  let title = '';
  let hash = '';

  const linkChip = (k: string, label: React.ReactNode, onClick: () => void, aria: string) => (
    <button key={k} type="button" className="search-card-link" onClick={onClick} aria-label={aria}>{label}</button>
  );

  if (item.finding) {
    const f = item.finding;
    title = f.title;
    hash = `#/finding/${f.id}`;
    const sev = optionOf(SEVERITY_OPTIONS, f.severity);
    const st = optionOf(FINDING_STATUS_OPTIONS, f.status);
    if (sev) chips.push(<ToneChip key="sev" label={sev.label} tone={sev.tone} />);
    if (st) chips.push(<ToneChip key="st" label={st.label} tone={st.tone} />);
    meta.push(
      f.category && categoryMeta(f.category).label,
      f.cwe && <span className="search-card-mono">{f.cwe}</span>,
      where(f.anchor) && <span className="search-card-mono search-card-file">{where(f.anchor)}</span>,
      f.source && f.source !== 'manual' && `via ${f.source}`,
      !isOpenFinding(f) && f.resolvedAt && `resolved ${ago(f.resolvedAt)}`,
    );
    // A breach is about the deadline; the finding's own item already showed what it is.
    if (item.kind === 'sla' && item.sla) {
      chips.unshift(<span key="sla" className="search-card-flag">{item.sla.over > 0 ? `${plural(item.sla.over, 'day')} over` : 'due today'}</span>);
      meta.unshift(`open ${plural(Math.floor(ageDays(f.createdAt)), 'day')}, fix within ${item.sla.days}`);
    } else if (f.description) {
      text = excerpt(plain(f.description), '', 240);
    }
    const affected = (f.features ?? []).map((id) => ctx.features.get(`${item.slug}:${id}`)).filter((x): x is Feature => !!x);
    if (affected.length) {
      links = {
        label: 'Affects',
        items: affected.slice(0, LINKS_MAX).map((ft) => linkChip(ft.id, <><FeatureMark f={ft} /><span>{ft.title}</span></>, () => onOpen(item.slug, `#/feature/${ft.id}`), `Feature ${ft.title}`)),
      };
      if (affected.length > LINKS_MAX) links.items.push(<span key="more" className="search-card-more">+{affected.length - LINKS_MAX}</span>);
    }
  } else if (item.feature) {
    const f = item.feature;
    title = f.title;
    hash = `#/feature/${f.id}`;
    const m = f.operation?.toUpperCase();
    if (m && METHODS.has(m)) method = m;
    const kind = optionOf(FEATURE_KIND_OPTIONS, f.kind);
    const st = optionOf(FEATURE_STATUS_OPTIONS, f.status);
    if (kind) chips.push(<ToneChip key="kind" label={kind.label} tone={kind.tone} />);
    if (st && f.status !== 'active') chips.push(<ToneChip key="st" label={st.label} tone={st.tone} />);
    const openN = ctx.openByFeature.get(`${item.slug}:${f.id}`) ?? 0;
    if (openN) chips.push(<span key="open" className="search-card-flag">{plural(openN, 'open finding')}</span>);
    meta.push(
      f.protocol && <span className="search-card-mono">{f.protocol}</span>,
      f.direction && (f.direction === 'in' ? 'inbound' : 'outbound'),
      where(f.anchor) && <span className="search-card-mono search-card-file">{where(f.anchor)}</span>,
    );
    if (f.description) text = excerpt(plain(f.description), '', 240);
    const flows = ctx.flowsByFeature.get(`${item.slug}:${f.id}`) ?? [];
    if (flows.length) {
      links = {
        label: flows.length === 1 ? 'On flow' : 'On flows',
        items: flows.slice(0, LINKS_MAX).map((fl) => linkChip(fl.id, <span>{fl.name}</span>, () => onOpenFlow(fl.id), `Flow ${fl.name}`)),
      };
      if (flows.length > LINKS_MAX) links.items.push(<span key="more" className="search-card-more">+{flows.length - LINKS_MAX}</span>);
    }
  }

  const c = item.lastComment;
  const shown = meta.filter((x): x is React.ReactNode => !!x);
  const open = () => onOpen(item.slug, hash);
  return (
    <li
      className={`search-card activity-card activity-card--${item.kind}`}
      // The whole card opens it; its own links (and the title button, for keyboards) win.
      onClick={(e) => { if (!(e.target as Element).closest('button, a')) open(); }}
    >
      <span className="search-card-icon">{item.kind === 'sla' ? <ClockIcon /> : <KindIcon kind={item.kind} />}</span>
      <div className="search-card-body">
        <div className="activity-card-event">
          <span className="activity-card-what">{EVENT[item.kind]}</span>
          <span className="activity-card-project">{pname}</span>
          <time className="activity-card-when" dateTime={item.at} title={new Date(item.at).toLocaleString()}>{when(item.at)}</time>
        </div>
        <div className="search-card-head">
          <button type="button" className="search-page-row search-card-title" onClick={open}>
            {method && <span className="feature-method-badge" style={{ background: METHOD_COLORS[method] }}>{method}</span>}
            <span className="home-search-label">{title}</span>
          </button>
          {chips.length > 0 && <span className="search-card-chips">{chips}</span>}
        </div>
        {shown.length > 0 && (
          <div className="search-card-meta home-search-sub">
            {shown.map((x, i) => <span key={i} className="search-card-meta-item">{x}</span>)}
          </div>
        )}
        {text && <p className="search-card-text activity-card-text">{text}</p>}
        {links && links.items.length > 0 && (
          <div className="search-card-links">
            <span className="search-card-links-label">{links.label}</span>
            {links.items}
          </div>
        )}
        {c && (
          <div className="activity-card-comment">
            <span className="activity-card-comment-who">{c.author || 'unknown author'}</span>
            <span className="activity-card-comment-when">{ago(c.timestamp)}</span>
            <span className="activity-card-comment-text">{excerpt(plain(c.text), '', 200)}</span>
          </div>
        )}
      </div>
    </li>
  );
}
