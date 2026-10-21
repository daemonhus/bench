import { useState, useEffect, useRef, useMemo } from 'react';
import { createProject, updateProject, deleteProject, listProjectFindings, DEFAULT_RISK_WEIGHTS, type Project, type RiskWeights } from './api';
import { TagEditor, SortToggle } from './filters';
import { useModalFocus } from './useModalFocus';
import { computeRiskScore, projectSize } from './risk';
import { Exposure, useProfile, pastSla, ageDays, plural } from './projectInsight';
import { Skeleton } from '@bench/components/Skeleton';
import { FindingMiniCard, useHoverCard } from '@bench/components/mini-cards';
import { isOpenFinding, SEVERITY_RANK } from '@bench/core/finding-categories';
import type { Finding as BenchFinding } from '@bench/core/types';
import { remoteToHttp, repoLabel } from './repoLinks';

export { remoteToHttp, repoLabel };

type SortKey = 'name' | 'findings' | 'severity' | 'risk' | 'size';
const PROJECT_SORTS: { id: SortKey; label: string; defaultDir: 'asc' | 'desc' }[] = [
  { id: 'name', label: 'Name', defaultDir: 'asc' },
  { id: 'findings', label: 'Findings', defaultDir: 'desc' },
  { id: 'severity', label: 'Severity', defaultDir: 'desc' },
  { id: 'risk', label: 'Risk', defaultDir: 'desc' },
  { id: 'size', label: 'Size', defaultDir: 'desc' },
];

interface ProjectListProps {
  projects: Project[];
  loading: boolean;
  weights?: RiskWeights;
  onSelect: (slug: string) => void;
  /** Open a project at a specific workbench location (e.g. a finding from its hover card). */
  onOpen?: (slug: string, hash: string) => void;
  onRefresh: () => void;
  /** The page's search, placed in the title row ahead of Sort, where it expands into the free space. */
  toolbar?: React.ReactNode;
  /** Shown as a count pill beside the title (bench's .overview-section-count). */
  countLabel?: string;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const SEVERITY_WEIGHTS = { critical: 10000, high: 1000, medium: 100, low: 10, info: 1 } as const;

function maxSeverityScore(p: Project): number {
  if (!p.stats) return 0;
  const sev = p.stats.bySeverityOpen ?? p.stats.bySeverity ?? {};
  let score = 0;
  for (const s of SEVERITIES) {
    score += (sev[s] ?? 0) * SEVERITY_WEIGHTS[s];
  }
  return score;
}

function riskBreakdown(p: Project, w: RiskWeights): { label: string; value: number }[] {
  const factors: { label: string; value: number }[] = [];
  if (!p.stats) return factors;
  const sev = p.stats.bySeverityOpen ?? p.stats.bySeverity ?? {};
  const sevScore =
    (sev['critical'] ?? 0) * w.critical +
    (sev['high'] ?? 0) * w.high +
    (sev['medium'] ?? 0) * w.medium +
    (sev['low'] ?? 0) * w.low +
    (sev['info'] ?? 0) * w.info;
  if (sevScore > 0) factors.push({ label: 'Findings', value: Math.round(sevScore * 10) / 10 });
  if (p.riskData?.latestBaselineAt) {
    const days = (Date.now() - new Date(p.riskData.latestBaselineAt).getTime()) / 86_400_000;
    const stale = w.stalenessWeight * days;
    if (stale >= 0.1) factors.push({ label: 'Staleness', value: Math.round(stale * 10) / 10 });
  }
  if (p.riskData && p.riskData.deltaNewFindings > 0) {
    const delta = w.deltaWeight * p.riskData.deltaNewFindings;
    factors.push({ label: 'New findings', value: Math.round(delta * 10) / 10 });
  }
  const size = (w.sizeWeight ?? 0) * projectSize(p);
  if (size >= 0.1) factors.push({ label: 'Size', value: Math.round(size * 10) / 10 });
  return factors;
}

function remoteHost(url: string): 'github' | 'gitlab' | 'other' {
  if (url.includes('github.com') || url.includes('github')) return 'github';
  if (url.includes('gitlab.com') || url.includes('gitlab')) return 'gitlab';
  return 'other';
}

const GitHubIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const GitLabIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 14.87L10.74 6.26H5.26L8 14.87z" />
    <path d="M8 14.87L5.26 6.26H1.03L8 14.87z" opacity=".7" />
    <path d="M1.03 6.26L.14 9.02c-.08.25 0 .52.21.67L8 14.87 1.03 6.26z" opacity=".5" />
    <path d="M1.03 6.26H5.26L3.42.56c-.09-.28-.49-.28-.58 0L1.03 6.26z" />
    <path d="M8 14.87L10.74 6.26h4.23L8 14.87z" opacity=".7" />
    <path d="M14.97 6.26l.89 2.76c.08.25 0 .52-.21.67L8 14.87l6.97-8.61z" opacity=".5" />
    <path d="M14.97 6.26H10.74l1.84-5.7c.09-.28.49-.28.58 0l1.81 5.7z" />
  </svg>
);

const GitIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M15.698 7.287L8.712.302a1.03 1.03 0 00-1.457 0l-1.45 1.45 1.84 1.84a1.223 1.223 0 011.55 1.56l1.773 1.774a1.224 1.224 0 11-.733.691L8.535 5.916v4.158a1.224 1.224 0 11-1.008-.037V5.835a1.224 1.224 0 01-.664-1.606L5.093 2.46l-4.79 4.79a1.03 1.03 0 000 1.457l6.986 6.986a1.03 1.03 0 001.457 0l6.953-6.953a1.03 1.03 0 000-1.457" />
  </svg>
);

const findingCache = new Map<string, { key: string; findings: BenchFinding[] }>();

/** A project's open findings, worst first (one fetch per project, cached until its counts change). */
function useOpenFindings(project: Project): BenchFinding[] | null {
  const stats = project.stats;
  const openCount = stats?.findingsOpen ?? 0;
  const cacheKey = `${stats?.findingsTotal ?? 0}:${openCount}`;
  const [findings, setFindings] = useState<BenchFinding[] | null>(
    openCount === 0 ? [] : findingCache.get(project.slug)?.key === cacheKey ? findingCache.get(project.slug)!.findings : null,
  );
  useEffect(() => {
    if (openCount === 0) { setFindings([]); return; }
    const cached = findingCache.get(project.slug);
    if (cached?.key === cacheKey) { setFindings(cached.findings); return; }
    let live = true;
    listProjectFindings(project.slug)
      .then((list) => {
        const open = (list as unknown as BenchFinding[]).filter(isOpenFinding)
          .sort((x, y) => (SEVERITY_RANK[x.severity] ?? 5) - (SEVERITY_RANK[y.severity] ?? 5));
        findingCache.set(project.slug, { key: cacheKey, findings: open });
        if (live) setFindings(open);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [project.slug, cacheKey, openCount]);
  return findings;
}

const SEVS = ['critical', 'high', 'medium', 'low'] as const;
const STALE_BASELINE_DAYS = 30;

function riskBand(score: number): { label: string; tone: string } {
  if (score >= 75) return { label: 'Critical', tone: 'var(--severity-critical)' };
  if (score >= 50) return { label: 'High', tone: 'var(--severity-high)' };
  if (score >= 25) return { label: 'Medium', tone: 'var(--severity-medium)' };
  if (score > 0) return { label: 'Low', tone: 'var(--severity-low)' };
  return { label: 'None', tone: 'var(--status-closed)' };
}

const MAX_SQUARES = 10;

/** Open findings as squares coloured by severity, worst first, each with bench's finding hover card and
 *  a link to the finding's page; past MAX_SQUARES, "+N" opens the project's Findings. */
function FindingSquares({ project, findings, onOpen }: { project: Project; findings: BenchFinding[] | null; onOpen: (slug: string, hash: string) => void }) {
  const { card, containerRef, showCard, cancelClose, scheduleClose } = useHoverCard<BenchFinding>();
  const all = findings ?? [];
  const shown = all.slice(0, MAX_SQUARES);
  const more = (project.stats?.findingsOpen ?? all.length) - shown.length;
  const summary = SEVS.map((s) => [s, project.stats?.bySeverityOpen?.[s] ?? 0] as const).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(', ');
  return (
    // Links inside are bench hash links: open them in this project's workbench.
    <div
      className="pc-squares"
      ref={containerRef}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        e.preventDefault(); e.stopPropagation();
        onOpen(project.slug, new URL(a.href, window.location.href).hash);
      }}
    >
      <span className="ovp-kind-squares" role="group" aria-label={`Open findings: ${summary}`}>
        {shown.map((f) => (
          <a key={f.id} className="ovp-kind-square" style={{ background: `var(--severity-${f.severity})` }}
            href={`#/finding/${f.id}`} aria-label={`${f.severity}: ${f.title}`}
            onMouseEnter={(e) => showCard(f, e.currentTarget)} onMouseLeave={scheduleClose}
            onFocus={(e) => showCard(f, e.currentTarget)} onBlur={scheduleClose} />
        ))}
        {more > 0 && <a className="pc-squares-more" href="#/findings" title={`All ${project.stats?.findingsOpen} open findings`}>+{more} more</a>}
      </span>
      {card && (
        <FindingMiniCard finding={card.payload} isOpen style={{ left: card.left, top: card.top }}
          onMouseEnter={cancelClose} onMouseLeave={scheduleClose} />
      )}
    </div>
  );
}

/** One labelled number; `tone` colours the number only when it needs attention. */
type TileProps = {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'bad' | 'warn'; title?: string; children?: React.ReactNode;
  /** Drawn behind the tile's text, e.g. a history graph. */
  background?: React.ReactNode;
};

function TileBody({ label, value, sub, tone, children }: TileProps) {
  return (
    <>
      <span className="pc-tile-label">{label}</span>
      {/* The number, with anything that qualifies it (finding squares) beside it. */}
      <span className="pc-tile-main">
        <span className={`pc-tile-value${tone ? ` pc-tone-${tone}` : ''}`}>{value}</span>
        {children}
      </span>
      {sub && <span className="pc-tile-sub">{sub}</span>}
    </>
  );
}

function Tile(props: TileProps) {
  return (
    <div className={`pc-tile${props.background ? ' pc-tile--graph' : ''}`} title={props.title}>
      {props.background}
      <TileBody {...props} />
    </div>
  );
}

/** A smooth path through points that never overshoots them (monotone cubic, as d3's
 *  curveMonotoneX), so a quiet stretch stays flat instead of dipping below zero. */
function monotonePath(pts: [number, number][]): string {
  const n = pts.length;
  const dx = (i: number) => pts[i + 1][0] - pts[i][0];
  const slope = (i: number) => (pts[i + 1][1] - pts[i][1]) / dx(i);
  const m = pts.map((_, i) => {
    if (i === 0) return slope(0);
    if (i === n - 1) return slope(n - 2);
    // d3's rule: no slope at a turning point, else bounded so the curve can't overshoot.
    const s0 = slope(i - 1), s1 = slope(i), h0 = dx(i - 1), h1 = dx(i);
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p));
  });
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx(i) / 3;
    d += `C${(pts[i][0] + h).toFixed(2)},${(pts[i][1] + m[i] * h).toFixed(2)} ${(pts[i + 1][0] - h).toFixed(2)},${(pts[i + 1][1] - m[i + 1] * h).toFixed(2)} ${pts[i + 1][0].toFixed(2)},${pts[i + 1][1].toFixed(2)}`;
  }
  return d;
}

/** A year of weekly commit counts as a faint area graph behind a tile, like GitHub's
 *  participation graph on a repository list. Decorative: the tile's text and tooltip carry
 *  the numbers. */
function ActivityGraph({ weekly }: { weekly: number[] }) {
  // A 3-week rolling mean, so one busy week reads as a rise rather than a spike.
  const smooth = weekly.map((_, i) => {
    const w = weekly.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const max = Math.max(...smooth);
  if (smooth.length < 2 || max === 0) return null;
  const W = 100, H = 32;
  const pts = smooth.map((n, i): [number, number] => [(i / (smooth.length - 1)) * W, H - (n / max) * (H - 2) - 1]);
  const line = monotonePath(pts);
  return (
    <svg className="pc-tile-bg pc-activity-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="pc-activity-graph-area" d={`${line}L${W},${H}L0,${H}Z`} />
      <path className="pc-activity-graph-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** How long ago, in the largest unit that fits: today, 5d, 3w, 4mo, 2y ago. */
function ago(iso: string): string {
  const days = Math.floor(ageDays(iso));
  if (days < 1) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 56) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30.44)}mo ago`;
  return `${Math.floor(days / 365.25)}y ago`;
}

/** Commits per month, rounded to what's readable: 18 commits/mo, 2.5, 1 commit/mo, under 1. */
function perMonth(commits: number, months: number): string {
  const n = commits / Math.max(1, months);
  if (n === 0) return 'no commits this year';
  if (n < 1) return 'under 1 commit/mo';
  const shown = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
  return `${shown} commit${shown === 1 ? '' : 's'}/mo`;
}

/** Two related numbers in one double-width tile, split 50/50, each with its own label. */
function SplitTile({ left, right }: { left: TileProps; right: TileProps }) {
  return (
    <div className="pc-tile pc-tile--wide pc-tile--split">
      <div className="pc-tile-half"><TileBody {...left} /></div>
      <div className="pc-tile-half"><TileBody {...right} /></div>
    </div>
  );
}

/** A project at a glance: name and repository, one risk badge, then equal tiles for open findings
 *  (with hoverable finding squares) beside past SLA, last baseline, unreviewed change and
 *  size. Colour appears only where something needs attention; the risk breakdown is the badge's tooltip. */
function ProjectCard({ project: p, weights, onSelect, onOpen, onEdit }: {
  project: Project; weights: RiskWeights;
  onSelect: (slug: string) => void; onOpen: (slug: string, hash: string) => void; onEdit: () => void;
}) {
  const stats = p.stats;
  const findings = useOpenFindings(p);
  const late = findings ? pastSla(findings).length : null;
  const score = computeRiskScore(p, weights);
  const band = riskBand(score);
  const factors = riskBreakdown(p, weights);
  const why = factors.length ? `Risk ${score}: ${factors.map((f) => `${f.value} from ${f.label.toLowerCase()}`).join(', ')}` : `Risk ${score}`;
  const baselineDays = p.riskData?.latestBaselineAt ? Math.floor(ageDays(p.riskData.latestBaselineAt)) : null;
  const commits = p.riskData?.commitsSince ?? 0;
  const files = p.riskData?.filesChangedSince ?? 0;
  const act = p.activity;
  const size = projectSize(p);
  const httpUrl = remoteToHttp(p.remoteUrl ?? '');
  const host = remoteHost(p.remoteUrl ?? '');
  const Icon = host === 'github' ? GitHubIcon : host === 'gitlab' ? GitLabIcon : GitIcon;
  const profile = useProfile(p.slug);
  return (
    // Not a button (it holds other controls); the name is the keyboard-reachable "open", and a
    // click anywhere else on the card opens it too.
    <div className="project-card" onClick={() => onSelect(p.slug)}>
      <div className="pc-head">
        <div className="pc-title">
          <button type="button" className="project-card-name project-card-open"
            onClick={(e) => { e.stopPropagation(); onSelect(p.slug); }}>{p.name}</button>
          {httpUrl ? (
            <a className="project-card-remote" href={httpUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
              <Icon /><span className="project-card-remote-text">{httpUrl.replace(/^https?:\/\//, '')}</span>
            </a>
          ) : <span className="project-card-path" title={p.repoPath}>{repoLabel(p.repoPath)}</span>}
        </div>
        <div className="pc-head-right">
          <span className="pc-risk" style={{ '--tone': band.tone } as React.CSSProperties} title={why} aria-label={`${why}. Level: ${band.label}`}>
            <span className="pc-risk-label">Risk</span>
            <span className="pc-risk-score">{score}</span>
          </span>
          <button className="project-card-edit-btn" title="Edit project" aria-label={`Edit ${p.name}`}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11.5 1.5l3 3L5 14H2v-3z" />
            </svg>
          </button>
        </div>
      </div>

      <div className="pc-meta">
        <Exposure profile={profile} />
        {p.owner && <span className="project-card-owner">@{p.owner}</span>}
        {(p.tags ?? []).map((t) => <span key={t} className="project-card-tag">#{t}</span>)}
      </div>

      {stats && (
        <div className="pc-tiles">
          {/* Open findings beside how many are past their fix deadline, in one tile. */}
          <SplitTile
            left={{
              label: 'Open findings', value: stats.findingsOpen,
              sub: stats.findingsTotal > stats.findingsOpen ? `of ${stats.findingsTotal}` : undefined,
              // One hoverable square per open finding, worst first (bench's finding hover card), then +N to the list.
              children: stats.findingsOpen > 0 && <FindingSquares project={p} findings={findings} onOpen={onOpen} />,
            }}
            right={{
              label: 'Past SLA', value: late ?? '–', tone: late ? 'bad' : undefined,
              sub: late ? 'need fixing now' : stats.findingsOpen > 0 && late === 0 ? 'all within deadline' : undefined,
            }}
          />
          {/* When it was last reviewed, and what has landed since. */}
          <Tile label="Last baseline" value={p.riskData?.latestBaselineAt ? ago(p.riskData.latestBaselineAt) : 'never'}
            tone={baselineDays == null || baselineDays > STALE_BASELINE_DAYS ? 'warn' : undefined}
            title={commits ? `${plural(commits, 'commit')} touching ${plural(files, 'file')} since the last baseline` : undefined}
            sub={baselineDays == null ? 'not reviewed yet'
              : commits ? <span className="pc-tone-warn">{plural(commits, 'commit')} unreviewed</span>
              : 'nothing unreviewed'} />
          {/* How active the repository is: its last push, and its pace over the last year. */}
          {act && (
            <Tile label="Activity" value={act.lastCommitAt ? ago(act.lastCommitAt) : '–'}
              background={act.weekly && <ActivityGraph weekly={act.weekly} />}
              title={`Last push ${act.lastCommitAt ? ago(act.lastCommitAt) : 'unknown'}. ${plural(act.commits, 'commit')} on ${act.branch} over the last ${plural(act.months, 'month')}${act.lastCommitAt ? `; newest ${new Date(act.lastCommitAt).toLocaleDateString()}` : ''}. The graph is commits per week.`}
              sub={perMonth(act.commits, act.months)} />
          )}
          <Tile label="Size" value={size} sub={`feature${size === 1 ? '' : 's'}`} />
        </div>
      )}
    </div>
  );
}

export function ProjectList({ projects, loading, weights = DEFAULT_RISK_WEIGHTS, onSelect, onOpen, onRefresh, toolbar, countLabel }: ProjectListProps) {
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sorted = useMemo(() => {
    const key = (p: Project): number | string => {
      switch (sortKey) {
        case 'name': return p.name.toLowerCase();
        case 'findings': return p.stats?.findingsOpen ?? 0;
        case 'severity': return maxSeverityScore(p);
        case 'risk': return computeRiskScore(p, weights);
        case 'size': return projectSize(p);
      }
    };
    const sign = sortDir === 'asc' ? 1 : -1;
    return [...projects].sort((a, b) => {
      const ka = key(a), kb = key(b);
      const c = typeof ka === 'string' ? ka.localeCompare(kb as string) : (ka as number) - (kb as number);
      return c !== 0 ? sign * c : a.name.localeCompare(b.name);
    });
  }, [projects, sortKey, sortDir, weights]);

  return (
    <div className="project-list-page">
      <div className="project-list-content">
        <div className="project-list-header">
          <h2 className="overview-section-title project-list-title">
            Projects
            {countLabel && <span className="overview-section-count">{countLabel}</span>}
          </h2>
          <div className="project-list-header-actions">
            {toolbar}
            <SortToggle<SortKey> options={PROJECT_SORTS} value={sortKey} dir={sortDir} onChange={(k, d) => { setSortKey(k); setSortDir(d); }} />
            <button className="baseline-action-btn baseline-action-btn-primary add-project-trigger" onClick={() => setShowModal(true)}>
              + Add project
            </button>
          </div>
        </div>

        {loading ? (
          // Card-shaped placeholders (name, risk, then the tiles) until the list arrives.
          <div className="project-cards" role="status" aria-label="Loading projects">
            {[0, 1, 2].map((i) => (
              <div key={i} className="project-card project-card-skeleton" aria-hidden="true">
                <div className="pc-head">
                  <div className="pc-title"><Skeleton height={16} width={160} /><Skeleton height={12} width={240} /></div>
                  <Skeleton height={24} width={84} />
                </div>
                <div className="pc-tiles">
                  {[0, 1, 2, 3, 4].map((c) => <Skeleton key={c} height={74} />)}
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <p className="project-list-empty">No projects yet.</p>
        ) : (
          <div className="project-cards">
            {sorted.map((p) => (
              <ProjectCard key={p.id} project={p} weights={weights}
                onSelect={onSelect} onOpen={onOpen ?? ((slug) => onSelect(slug))} onEdit={() => setEditingProject(p)} />
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <AddProjectModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false);
            onRefresh();
          }}
        />
      )}

      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onUpdated={() => {
            setEditingProject(null);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

/* ── Add Project Modal ── */

function AddProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useModalFocus(dialogRef);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await createProject(name, repoPath);
      onCreated();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-project-title">
        <div className="modal-header">
          <span className="modal-title" id="add-project-title">Add project</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form className="modal-body" onSubmit={handleSubmit}>
          <label className="modal-field">
            <span className="modal-label">Name</span>
            <input
              ref={nameRef}
              className="finding-edit-input"
              placeholder="my-project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">Repository path</span>
            <input
              className="finding-edit-input modal-input-path"
              placeholder="/path/to/git/repo"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              required
            />
          </label>
          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <button className="baseline-action-btn baseline-action-btn-outline" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="baseline-action-btn baseline-action-btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Adding...' : 'Add project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Edit Project Modal ── */

function EditProjectModal({ project, onClose, onUpdated }: { project: Project; onClose: () => void; onUpdated: () => void }) {
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [tags, setTags] = useState<string[]>(project.tags ?? []);
  const [owner, setOwner] = useState(project.owner ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useModalFocus(dialogRef);

  const handleDelete = async () => {
    setError('');
    setSubmitting(true);
    try {
      await deleteProject(project.slug);
      onUpdated();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const fields: { name?: string; repoPath?: string; tags?: string[]; owner?: string } = {};
    if (name !== project.name) fields.name = name;
    if (repoPath !== project.repoPath) fields.repoPath = repoPath;
    const origTags = (project.tags ?? []).slice().sort();
    const newTags = tags.slice().sort();
    if (origTags.length !== newTags.length || origTags.some((t, i) => t !== newTags[i])) fields.tags = tags;
    if (owner !== (project.owner ?? '')) fields.owner = owner;
    if (Object.keys(fields).length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await updateProject(project.slug, fields);
      onUpdated();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={handleBackdropClick}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="edit-project-title">
        <div className="modal-header">
          <span className="modal-title" id="edit-project-title">Edit project</span>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form className="modal-body" onSubmit={handleSubmit}>
          <label className="modal-field">
            <span className="modal-label">Name</span>
            <input
              ref={nameRef}
              className="finding-edit-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">Repository path</span>
            <input
              className="finding-edit-input modal-input-path"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              required
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">Owner</span>
            <input
              className="finding-edit-input"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="unassigned"
            />
          </label>
          <div className="modal-field">
            <span className="modal-label">Tags</span>
            <div className="finding-edit-input modal-input-tags">
              <TagEditor tags={tags} onChange={setTags} />
            </div>
          </div>
          {error && <div className="modal-error">{error}</div>}
          {confirmingDelete && (
            <div className="modal-danger-confirm" role="alert">
              <span>
                Remove <strong>{project.name}</strong> from Bench? Its repository is not touched.
              </span>
              <span className="modal-danger-confirm-actions">
                <button className="baseline-action-btn baseline-action-btn-outline" type="button" onClick={() => setConfirmingDelete(false)}>
                  Keep project
                </button>
                <button className="baseline-action-btn baseline-action-btn-danger" type="button" onClick={handleDelete} disabled={submitting}>
                  Remove project
                </button>
              </span>
            </div>
          )}
          <div className="modal-actions modal-actions-split">
            {!confirmingDelete && (
              <button className="baseline-action-btn baseline-action-btn-outline is-danger" type="button" onClick={() => setConfirmingDelete(true)}>
                Remove project…
              </button>
            )}
            <span className="modal-actions-end">
              <button className="baseline-action-btn baseline-action-btn-outline" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="baseline-action-btn baseline-action-btn-primary" type="submit" disabled={submitting}>
                {submitting ? 'Saving...' : 'Save'}
              </button>
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
