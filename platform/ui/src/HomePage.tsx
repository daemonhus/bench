import { useEffect, useMemo, useState } from 'react';
import { isOpenFinding, categoryMeta } from '@bench/core/finding-categories';
import { Skeleton, SkeletonRows } from '@bench/components/Skeleton';
import { FeatureMiniCard, useHoverCard } from '@bench/components/mini-cards';
import { KIND_COLORS } from '@bench/components/FeatureCard';
import type { Feature as BenchFeature } from '@bench/core/types';
import {
  listProjects, listProjectFindings, listAllBaselines, getSettings, DEFAULT_RISK_WEIGHTS,
  type Project, type Finding, type PlatformBaseline, type RiskWeights,
} from './api';
import { listAllFlows, type FlowSummary } from './flows';
import { computeRiskScore } from './risk';
import { SLA_DAYS, ageDays, plural, type Profile } from './projectInsight';
import { FindingsTrendChart, SurfaceChart, type FindingsWeek } from './charts';
import { HomeSearch } from './HomeSearch';
import { primeSearchIndex } from './SearchPage';
import type { Kind } from './searchModel';

// ─── Security overview ──────────────────────────────────────────────────
// Written for whoever owns security across these projects. It answers, in order:
//   1. What should I do next?                       → Next actions
//   2. How exposed are we, and which way is it going? → Posture (risk, trend, SLA, MTTR, change)
//   3. Where is the risk concentrated?              → Risk matrix (exposure × severity × change)
//   4. Are we fixing things in time?                → SLA & ageing
//   5. What keeps going wrong?                      → Top weaknesses
//   6. How much of the attack surface is mapped?    → Attack surface
// Everything is derived from data the platform already serves.

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Sev = typeof SEVERITIES[number];
/** Days to fix, by severity (a common default policy). */
const AGE_BUCKETS = [
  { id: 'lt7', label: '< 7d', max: 7 },
  { id: 'lt30', label: '7–30d', max: 30 },
  { id: 'lt90', label: '30–90d', max: 90 },
  { id: 'old', label: '> 90d', max: Infinity },
] as const;
const STALE_DAYS = 30;
/** Lists that grow with the portfolio (actions, projects) show this many until expanded. */
const TOP_N = 5;
/** Feature squares drawn per project on the attack-surface panel (about three rows). */
const SQUARES_MAX = 75;
const WEEKS = 12;
const DAY = 86_400_000;
const KINDS = ['interface', 'source', 'sink', 'dependency', 'externality'] as const;
const KIND_LABEL: Record<string, string> = { interface: 'Interfaces', source: 'Sources', sink: 'Sinks', dependency: 'Dependencies', externality: 'Background' };

type Feature = BenchFeature;
interface ProjectData { findings: Finding[]; profile: Profile | null; features: Feature[]; coverage: number | null }

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const riskColor = (score: number) => `var(--severity-${score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low'})`;
/** The first few names, then a count, so a line stays one line with fifty projects. */
const nameList = (names: string[], max = 3) =>
  names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;

async function getJSON<T>(url: string, fallback: T): Promise<T> {
  try { const r = await fetch(url); return r.ok ? await r.json() : fallback; } catch { return fallback; }
}

export function HomePage({ onOpenProject, onOpenFlow, onOpenProjects, onOpenPath, onSearch }: {
  onOpenProject: (slug: string, hash?: string) => void;
  /** Open a platform page by its address, e.g. /activity?kinds=sla. */
  onOpenPath: (path: string) => void;
  /** Open the search page with q, on one kind's results or all of them. */
  onSearch: (q: string, kind?: Kind) => void;
  onOpenFlow: (id: string) => void;
  onOpenProjects: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [data, setData] = useState<Record<string, ProjectData>>({});
  const [baselines, setBaselines] = useState<PlatformBaseline[]>([]);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [weights, setWeights] = useState<RiskWeights>(DEFAULT_RISK_WEIGHTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.all([
      listProjects(),
      listAllBaselines().catch(() => [] as PlatformBaseline[]),
      listAllFlows({ withFindings: true }).catch(() => [] as FlowSummary[]),
      getSettings().catch(() => ({} as Record<string, string>)),
    ]).then(async ([ps, bs, fs, settings]) => {
      if (!live) return;
      setProjects(ps); setBaselines(bs); setFlows(fs);
      if (settings.riskWeights) try { setWeights({ ...DEFAULT_RISK_WEIGHTS, ...JSON.parse(settings.riskWeights) }); } catch { /* defaults */ }
      const loaded = await Promise.all(ps.map(async (p): Promise<[string, ProjectData]> => {
        const base = `/api/projects/${p.slug}`;
        const [findings, profile, features, coverage] = await Promise.all([
          listProjectFindings(p.slug, true).catch(() => [] as Finding[]),
          getJSON<Profile | null>(`${base}/profile`, null),
          getJSON<Feature[]>(`${base}/features`, []),
          getJSON<{ coveragePct?: string } | null>(`${base}/coverage`, null),
        ]);
        return [p.slug, { findings, profile, features, coverage: coverage?.coveragePct != null ? Number(coverage.coveragePct) : null }];
      }));
      if (!live) return;
      const next = Object.fromEntries(loaded);
      setData(next);
      primeSearchIndex(ps, next, fs);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);


  // ── Per-project rows (the risk matrix) ──
  const rows = useMemo(() => projects.map((p) => {
    const d = data[p.slug];
    const open = (d?.findings ?? []).filter(isOpenFinding);
    const bySev = Object.fromEntries(SEVERITIES.map((s) => [s, open.filter((f) => f.severity === s).length])) as Record<Sev, number>;
    const breaches = open.filter((f) => ageDays(f.createdAt) > SLA_DAYS[f.severity as Sev]);
    const baselineAge = p.riskData?.latestBaselineAt ? Math.floor(ageDays(p.riskData.latestBaselineAt)) : null;
    return {
      p, d, open, bySev, breaches, baselineAge,
      risk: computeRiskScore(p, weights),
      commits: p.riskData?.commitsSince ?? 0,
      files: p.riskData?.filesChangedSince ?? 0,
      exposed: d?.profile?.externallyFacing === 'full' || d?.profile?.externallyFacing === 'partial',
      profileSet: !!(d?.profile && (d.profile.externallyFacing || d.profile.dataSensitivity || d.profile.criticality)),
    };
  }).sort((a, b) => b.risk - a.risk), [projects, data, weights]);

  const allOpen = rows.flatMap((r) => r.open.map((f) => ({ f, r })));
  const allFindings = rows.flatMap((r) => (r.d?.findings ?? []).map((f) => ({ f, r })));
  const breaches = rows.flatMap((r) => r.breaches.map((f) => ({ f, r })))
    .sort((a, b) => (ageDays(b.f.createdAt) - SLA_DAYS[b.f.severity as Sev]) - (ageDays(a.f.createdAt) - SLA_DAYS[a.f.severity as Sev]));

  // ── Posture numbers ──
  const portfolioRisk = rows.length ? Math.round(rows.reduce((n, r) => n + r.risk, 0) / rows.length) : 0;
  const mttr = median(allFindings.filter(({ f }) => f.createdAt && f.resolvedAt)
    .map(({ f }) => (new Date(f.resolvedAt!).getTime() - new Date(f.createdAt!).getTime()) / DAY));
  const unreviewedCommits = rows.reduce((n, r) => n + r.commits, 0);
  const unreviewedFiles = rows.reduce((n, r) => n + r.files, 0);
  const covered = rows.filter((r) => r.d?.coverage != null);
  const coverage = covered.length ? covered.reduce((n, r) => n + (r.d!.coverage as number), 0) / covered.length : null;
  // A stat opens where its number comes from: one project's own page when only that project
  // contributes, else the cross-project view.
  const breachSlugs = [...new Set(breaches.map((b) => b.r.p.slug))];
  const slaLink: StatLink = breachSlugs.length === 1
    ? { href: `/p/${breachSlugs[0]}#/findings?overdue=1`, to: 'findings past SLA', go: () => onOpenProject(breachSlugs[0], '#/findings?overdue=1') }
    : { href: '/activity?kinds=sla&since=all', to: 'findings past SLA', go: () => onOpenPath('/activity?kinds=sla&since=all') };
  const changed = rows.filter((r) => r.commits > 0);
  const changeLink: StatLink = changed.length === 1
    ? { href: `/p/${changed[0].p.slug}#/delta`, to: 'Changes', go: () => onOpenProject(changed[0].p.slug, '#/delta') }
    : { href: '/projects', to: 'Projects', go: onOpenProjects };

  const scopedBaselines = useMemo(() => baselines.filter((b) => rows.some((r) => r.p.slug === b.projectSlug)), [baselines, rows]);
  // One chart marker per day: baselines taken together (e.g. a first import) share a label.
  const baselineMarkers = useMemo(() => {
    const byDay = new Map<string, PlatformBaseline[]>();
    for (const b of scopedBaselines) {
      const day = b.createdAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), b]);
    }
    return [...byDay.values()].map((bs) => ({
      t: new Date(bs[0].createdAt).getTime(),
      label: bs.length > 1 ? `${bs.length} baselines` : rows.length > 1 ? `${bs[0].projectName} #${bs[0].seq}` : `#${bs[0].seq}`,
    }));
  }, [scopedBaselines, rows.length]);

  // ── Next actions: the few things worth doing first ──
  const actions = useMemo(() => {
    const out: { key: string; kind: ActionKind; tone: 'critical' | 'high' | 'medium'; text: string; open: () => void }[] = [];
    if (breaches.length) {
      const worst = breaches[0];
      out.push({ key: 'sla', kind: 'sla', tone: 'critical', text: `${plural(breaches.length, 'finding')} past SLA — oldest: “${worst.f.title}” in ${worst.r.p.name}, ${Math.floor(ageDays(worst.f.createdAt))} days`, open: () => onOpenProject(worst.r.p.slug, `#/finding/${worst.f.id}`) });
    }
    for (const r of rows) if (r.exposed && (r.bySev.critical + r.bySev.high) > 0) {
      out.push({ key: `exp:${r.p.slug}`, kind: 'exposure', tone: 'critical', text: `${r.p.name} is internet-facing with ${plural(r.bySev.critical + r.bySev.high, 'critical/high finding')} open`, open: () => onOpenProject(r.p.slug, '#/findings') });
    }
    for (const r of rows) if (r.commits > 0 && (r.baselineAge ?? Infinity) > STALE_DAYS) {
      out.push({ key: `chg:${r.p.slug}`, kind: 'change', tone: 'high', text: `${r.p.name}: ${plural(r.commits, 'commit')} (${plural(r.files, 'file')}) unreviewed since the last baseline, ${r.baselineAge ?? '—'} days ago`, open: () => onOpenProject(r.p.slug, '#/delta') });
    }
    for (const f of flows) if ((f.openFindings?.critical ?? 0) > 0) {
      out.push({ key: `flow:${f.id}`, kind: 'flow', tone: 'critical', text: `Flow “${f.name}” has ${plural(f.openFindings!.critical, 'critical finding')} on its path`, open: () => onOpenFlow(f.id) });
    }
    const noProfile = rows.filter((r) => !r.profileSet);
    if (noProfile.length) {
      out.push({ key: 'profile', kind: 'profile', tone: 'medium', text: `${plural(noProfile.length, 'project')} without a service profile (${nameList(noProfile.map((r) => r.p.name))}): exposure and data sensitivity are unknown`, open: () => onOpenProject(noProfile[0].p.slug, '#/profile') });
    }
    const rank = { critical: 0, high: 1, medium: 2 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [breaches, rows, flows, onOpenProject, onOpenFlow]);

  // ── SLA & ageing: open findings by severity × age ──
  const ageing = SEVERITIES.filter((s) => s !== 'info').map((s) => {
    const fs = allOpen.filter(({ f }) => f.severity === s);
    const buckets = AGE_BUCKETS.map((b, i) => fs.filter(({ f }) => {
      const a = ageDays(f.createdAt);
      return a <= b.max && (i === 0 || a > AGE_BUCKETS[i - 1].max);
    }).length);
    return { s, total: fs.length, buckets, late: fs.filter(({ f }) => ageDays(f.createdAt) > SLA_DAYS[s]).length };
  });
  const ageMax = Math.max(1, ...ageing.map((a) => a.total));

  // ── Weaknesses ──
  // Open findings per category, worst first. Each bar is that category's open findings split by
  // severity, drawn to the scale of the busiest category.
  const categories = useMemo(() => {
    const m = new Map<string, typeof allOpen>();
    for (const o of allOpen) {
      const c = o.f.category || 'uncategorised';
      m.set(c, [...(m.get(c) ?? []), o]);
    }
    const weight = (os: typeof allOpen) => os.reduce((n, { f }) => n + (5 - SEVERITIES.indexOf(f.severity as Sev)), 0);
    return [...m.entries()]
      .map(([cat, os]) => ({ cat, open: os.sort((a, b) => SEVERITIES.indexOf(a.f.severity as Sev) - SEVERITIES.indexOf(b.f.severity as Sev)) }))
      .sort((a, b) => b.open.length - a.open.length || weight(b.open) - weight(a.open))
      .slice(0, 6);
  }, [allOpen]);
  const cwes = useMemo(() => {
    const m = new Map<string, number>();
    for (const { f } of allOpen) if (f.cwe) m.set(f.cwe, (m.get(f.cwe) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [allOpen]);
  const catMax = Math.max(1, ...categories.map((c) => c.open.length));
  const [openCat, setOpenCat] = useState<string | null>(null);
  const [allActions, setAllActions] = useState(false);
  const [allSurface, setAllSurface] = useState(false);

  // ── Findings over time: found and fixed per week, and how many were open at each week's end ──
  const weeks = useMemo((): FindingsWeek[] => {
    const now = Date.now();
    const start0 = now - WEEKS * 7 * DAY;
    // Weeks run up to now, so the last one ends "today".
    const ws = Array.from({ length: WEEKS }, (_, i) => ({ t: start0 + (i + 1) * 7 * DAY, found: 0, fixed: 0, open: 0 }));
    // Something created this very moment belongs to the last week.
    const idx = (iso?: string) => (iso ? Math.min(WEEKS - 1, Math.floor((new Date(iso).getTime() - start0) / (7 * DAY))) : -1);
    for (const { f } of allFindings) {
      const o = idx(f.createdAt); if (o >= 0) ws[o].found++;
      const r = idx(f.resolvedAt); if (r >= 0) ws[r].fixed++;
      if (!f.createdAt) continue;
      const created = new Date(f.createdAt).getTime();
      const resolved = f.resolvedAt ? new Date(f.resolvedAt).getTime() : null;
      const open = isOpenFinding(f);
      // Open at a week's end: created by then, and still open now or resolved after it. A closed
      // finding with no resolved date has no known close time, so it is left out of the history.
      for (const w of ws) if (created <= w.t && (open || (resolved != null && resolved > w.t))) w.open++;
    }
    return ws;
  }, [allFindings]);

  // ── Attack surface over time: features mapped by each week's end, by kind ──
  const surfaceWeeks = useMemo(() => {
    const now = Date.now();
    const all = rows.flatMap((r) => r.d?.features ?? []);
    return Array.from({ length: WEEKS + 1 }, (_, i) => {
      const at = now - (WEEKS - i) * 7 * DAY;
      const point: Record<string, number> = { t: at };
      for (const k of KINDS) point[k] = 0;
      for (const f of all) {
        const created = f.createdAt ? new Date(f.createdAt).getTime() : 0;
        if (created <= at && f.status !== 'removed') point[f.kind] = (point[f.kind] ?? 0) + 1;
      }
      return point;
    });
  }, [rows]);

  // ── Attack surface: which mapped features does at least one documented flow walk through? ──
  const inFlow = useMemo(() => {
    const set = new Set<string>();
    for (const f of flows) for (const n of f.shape ?? []) if (n.projectSlug && n.featureId) set.add(`${n.projectSlug}:${n.featureId}`);
    return set;
  }, [flows]);
  // Coverage per project is the share of its features on a flow (0% when nothing is mapped);
  // the headline is the average of those, so every project counts equally.
  const surfaceTotals = useMemo(() => {
    const shares = rows.map((r) => {
      const fs = r.d?.features ?? [];
      return fs.length ? fs.filter((f) => inFlow.has(`${r.p.slug}:${f.id}`)).length / fs.length : 0;
    });
    return { average: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0, projects: rows.length };
  }, [rows, inFlow]);

  if (!loading && projects.length === 0) {
    return (
      <div className="home-page">
        <h1 className="overview-section-title">Bench</h1>
        <div className="home-empty">
          <p>No projects yet. Add one to see its security posture here.</p>
          <button type="button" className="baseline-action-btn baseline-action-btn-primary" onClick={onOpenProjects}>Add a project</button>
        </div>
      </div>
    );
  }

  return (
    <div className="home-page">
      <div className="home-header">
        <h1 className="overview-section-title">Bench</h1>
        <HomeSearch projects={projects} data={data} onOpen={onOpenProject} onSearch={onSearch} />
      </div>

      {/* 1 + 2: posture hero and next actions */}
      <div className="home-hero">
        <section className="ovp-panel home-posture" aria-labelledby="home-posture-title">
          <h2 className="ovp-panel-title" id="home-posture-title">Posture</h2>
          {loading ? (
            <div className="home-posture-body">
              <Skeleton width={140} height={126} radius="50%" />
              <div className="home-posture-trend">
                <div className="home-metric-label">Findings, last {WEEKS} weeks</div>
                <Skeleton height={16} width="55%" />
                <Skeleton height={180} />
              </div>
            </div>
          ) : <div className="home-posture-body">
            <RiskGauge score={portfolioRisk} />
            <div className="home-posture-trend">
              <div className="home-metric-label">Findings, last {WEEKS} weeks</div>
              <TrendChart weeks={weeks} baselines={baselineMarkers} />
            </div>
          </div>}
          <div className="home-posture-stats">
            <Stat loading={loading} link={slaLink} label="Past SLA" value={breaches.length} tone={breaches.length ? 'critical' : 'ok'} sub={breaches.length ? 'open beyond their fix deadline' : 'all within deadline'} />
            <Stat loading={loading} label="Median time to fix" value={mttr == null ? '—' : `${Math.round(mttr)}d`} sub={mttr == null ? 'no resolved findings with dates' : 'created → resolved'} />
            <Stat loading={loading} link={changeLink} label="Unreviewed change" value={unreviewedCommits} unit="commits" tone={unreviewedCommits ? 'high' : 'ok'} sub={`${plural(unreviewedFiles, 'file')} since last baselines`} />
            <Stat loading={loading} label="Review coverage" value={coverage == null ? '—' : `${coverage.toFixed(0)}%`} tone={coverage != null && coverage < 25 ? 'high' : undefined} sub="files marked reviewed" />
          </div>
        </section>

        <section className="ovp-panel home-actions" aria-labelledby="home-actions-title">
          <h2 className="ovp-panel-title" id="home-actions-title">Next actions</h2>
          {loading ? <SkeletonRows rows={TOP_N} height={34} gap={6} lastWidth="100%" />
            : actions.length === 0 ? <div className="ovp-empty">Nothing pressing. Nice.</div> : (
            <ol className="home-action-list">
              {(allActions ? actions : actions.slice(0, TOP_N)).map((a) => (
                <li key={a.key}>
                  <button type="button" className="home-action" onClick={a.open}>
                    <ActionIcon kind={a.kind} />
                    <span className="home-action-text">{a.text}</span>
                    <span className="home-row-go" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <MoreToggle total={loading ? 0 : actions.length} expanded={allActions} onToggle={() => setAllActions(!allActions)} />
        </section>
      </div>

      {/* Left: findings and remediation. Right: the attack surface, over time and as it stands. */}
      <div className="home-grid">
        <div className="home-col">
          {/* 4: SLA & ageing */}
          <section className="ovp-panel" aria-labelledby="home-sla-title">
            <h2 className="ovp-panel-title" id="home-sla-title">SLA &amp; ageing of open findings</h2>
            <div className="home-ageing">
              {ageing.map((a) => (
                <div key={a.s} className="home-ageing-row">
                  <span className="home-ageing-sev">
                    <span className="home-dot" style={{ background: `var(--severity-${a.s})` }} />{a.s}
                    <span className="home-ageing-sla" title={`SLA: fix within ${SLA_DAYS[a.s]} days`}>{SLA_DAYS[a.s]}d</span>
                  </span>
                  {loading ? <Skeleton height={10} width="60%" /> : <span className="home-ageing-bar" style={{ width: `${(a.total / ageMax) * 100}%` }}>
                    {a.buckets.map((n, i) => n > 0 && (
                      <span key={i} className={`home-age home-age-${AGE_BUCKETS[i].id}`} style={{ flex: n }} title={`${n} ${a.s}, ${AGE_BUCKETS[i].label} old`} />
                    ))}
                  </span>}
                  {loading ? <Skeleton height={12} width={24} style={{ justifySelf: 'end' }} />
                    : <span className="home-ageing-count">{a.total}{a.late ? <em> · {a.late} late</em> : null}</span>}
                </div>
              ))}
              <div className="home-ageing-legend">
                {AGE_BUCKETS.map((b) => <span key={b.id}><i className={`home-age home-age-${b.id}`} />{b.label}</span>)}
              </div>
            </div>
            {breaches.length > 0 && (
              <ul className="home-list home-breaches">
                {breaches.slice(0, 4).map(({ f, r }) => (
                  <li key={f.id}>
                    <button type="button" className="home-row" onClick={() => onOpenProject(r.p.slug, `#/finding/${f.id}`)}>
                      <span className="home-dot" style={{ background: `var(--severity-${f.severity})` }} />
                      <span className="home-row-label">{f.title}</span>
                      <span className="home-row-detail">{r.p.name}</span>
                      <span className="home-bad">{Math.floor(ageDays(f.createdAt) - SLA_DAYS[f.severity as Sev])}d over</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 5: weaknesses */}
          <section className="ovp-panel" aria-labelledby="home-weak-title">
            <h2 className="ovp-panel-title" id="home-weak-title">Top weaknesses</h2>
            {loading ? <SkeletonRows rows={6} height={15} gap={12} lastWidth="100%" />
              : categories.length === 0 ? <div className="ovp-empty">No open findings.</div> : (
              <ul className="home-list">
                {categories.map(({ cat, open }) => {
                  const expanded = openCat === cat;
                  const label = categoryMeta(cat).label;
                  return (
                    <li key={cat}>
                      <div className="home-weak-row">
                        <button
                          type="button"
                          className="home-table-link home-row-label"
                          aria-expanded={expanded}
                          onClick={() => setOpenCat(expanded ? null : cat)}
                        >{label}</button>
                        <span className="home-weak-bar" style={{ width: `${(open.length / catMax) * 100}%` }} aria-hidden="true">
                          {SEVERITIES.map((sev) => {
                            const n = open.filter(({ f }) => f.severity === sev).length;
                            return n > 0 && <span key={sev} style={{ flex: n, background: `var(--severity-${sev})` }} title={`${n} ${sev}`} />;
                          })}
                        </span>
                        <span className="home-weak-count">{open.length}<span> open</span></span>
                      </div>
                      {expanded && (
                        <ul className="home-weak-findings" aria-label={`Open ${label} findings`}>
                          {open.map(({ f, r }) => (
                            <li key={`${r.p.slug}:${f.id}`}>
                              <button type="button" className="home-weak-finding" onClick={() => onOpenProject(r.p.slug, `#/finding/${f.id}`)}>
                                <span className="home-dot" style={{ background: `var(--severity-${f.severity})` }} title={f.severity} />
                                <span className="home-weak-finding-title">{f.title}</span>
                                <span className="home-weak-finding-project">{r.p.name}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {cwes.length > 0 && (
              <div className="home-cwes" aria-label="Most common CWEs">
                {cwes.map(([cwe, n]) => <span key={cwe} className="home-cwe">{cwe} <b>{n}</b></span>)}
              </div>
            )}
          </section>
        </div>
        <div className="home-col">
          {/* Attack surface over time: mapped features at each week's end, by kind */}
          <section className="ovp-panel" aria-labelledby="home-surface-trend-title">
            <h2 className="ovp-panel-title" id="home-surface-trend-title">Attack surface over time</h2>
            {loading ? (
              <div className="skeleton-stack" style={{ gap: 12 }}>
                <Skeleton height={16} width="55%" />
                <Skeleton height={180} />
              </div>
            ) : <SurfaceTrend points={surfaceWeeks} />}
          </section>

          {/* 6: attack surface */}
          <section className="ovp-panel" aria-labelledby="home-surface-title">
            <h2 className="ovp-panel-title" id="home-surface-title">Mapped attack surface</h2>
            {loading ? (
              <div className="skeleton-stack" style={{ gap: 14 }}>
                <Skeleton height={32} width="45%" />
                <SkeletonRows rows={Math.min(TOP_N, Math.max(1, projects.length))} height={24} gap={14} lastWidth="100%" />
              </div>
            ) : <AttackSurface rows={allSurface ? rows : rows.slice(0, TOP_N)} inFlow={inFlow} totals={surfaceTotals} onOpenProject={onOpenProject} />}
            <MoreToggle total={loading ? 0 : rows.length} expanded={allSurface} onToggle={() => setAllSurface(!allSurface)} noun="project" />
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────

/** What a next action is about: an icon in that kind's colour, so a long list scans by type. */
type ActionKind = 'sla' | 'exposure' | 'change' | 'flow' | 'profile';
const ACTION_KINDS: Record<ActionKind, { label: string; color: string; path: React.ReactNode }> = {
  sla: { label: 'Past SLA', color: 'var(--severity-critical)',
    path: <><path d="M4.5 2h7M4.5 14h7" /><path d="M5.5 2v2.5L8 7.5l2.5-3V2M5.5 14v-2.5L8 8.5l2.5 3V14" /></> },
  exposure: { label: 'Internet-facing exposure', color: 'var(--severity-high)',
    path: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14c-1.8-1.8-2.6-3.8-2.6-6S6.2 3.8 8 2z" /></> },
  change: { label: 'Unreviewed change since the last baseline', color: 'var(--accent-blue)',
    path: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></> },
  flow: { label: 'Flow with critical findings', color: 'var(--accent-purple)',
    path: <><circle cx="3.25" cy="8" r="1.75" /><circle cx="12.75" cy="3.75" r="1.75" /><circle cx="12.75" cy="12.25" r="1.75" /><path d="M4.9 7.3 11.1 4.4M4.9 8.7l6.2 2.9" /></> },
  profile: { label: 'Configuration: service profile missing', color: 'var(--severity-critical)',
    path: <path d="M10.2 2.3a3.2 3.2 0 0 0-3.9 4.1L2.6 10.1a1.4 1.4 0 0 0 2 2l3.7-3.7a3.2 3.2 0 0 0 4.1-3.9l-2 2-1.6-.4-.4-1.6 2-2.2z" /> },
};

function ActionIcon({ kind }: { kind: ActionKind }) {
  const k = ACTION_KINDS[kind];
  return (
    <svg className="home-action-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={k.color} strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={k.label}>
      <title>{k.label}</title>
      {k.path}
    </svg>
  );
}

/** "+N more" under a list cut to TOP_N; expands it in place, and collapses it again. */
function MoreToggle({ total, expanded, onToggle, noun }: { total: number; expanded: boolean; onToggle: () => void; noun?: string }) {
  if (total <= TOP_N) return null;
  const rest = total - TOP_N;
  return (
    <button type="button" className="home-more" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? 'Show fewer' : `+${rest} more${noun ? ` ${noun}${rest === 1 ? '' : 's'}` : ''}`}
    </button>
  );
}

type StatLink = { href: string; to: string; go: () => void };

function Stat({ label, value, unit, sub, tone, loading, link }: { label: string; value: number | string; unit?: string; sub: string; tone?: 'critical' | 'high' | 'ok'; loading?: boolean; link?: StatLink }) {
  if (loading) {
    return (
      <div className="home-stat">
        <span className="home-metric-label">{label}</span>
        <Skeleton height={28} width="45%" style={{ margin: '4px 0' }} />
        <Skeleton height={11} width="80%" />
      </div>
    );
  }
  const body = (
    <>
      <span className="home-metric-label">
        {(tone === 'critical' || tone === 'high') && <span className="home-dot" style={{ background: `var(--severity-${tone})` }} aria-hidden="true" />}
        {label}
      </span>
      <span className="home-stat-value">{value}{unit && <span className="ovp-kpi-unit"> {unit}</span>}</span>
      <span className="home-metric-sub">{sub}</span>
    </>
  );
  const cls = `home-stat${tone ? ` home-tone-${tone}` : ''}`;
  if (!link) return <div className={cls}>{body}</div>;
  // A real link, so a modified click opens a new tab; a plain one stays in the app.
  return (
    <a className={`${cls} home-stat--link`} href={link.href} title={`Open ${link.to}`}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        link.go();
      }}>
      {body}
    </a>
  );
}

function RiskGauge({ score }: { score: number }) {
  // 240° arc, filled to the score, coloured by band.
  const R = 46, C = 2 * Math.PI * R, ARC = C * (240 / 360);
  const filled = (Math.min(100, Math.max(0, score)) / 100) * ARC;
  return (
    <div className="home-gauge" role="img" aria-label={`Portfolio risk ${score} out of 100`}>
      <svg viewBox="0 0 120 108" width="140" height="126" aria-hidden="true">
        <g transform="rotate(150 60 60)">
          <circle cx="60" cy="60" r={R} fill="none" stroke="var(--bg-surface)" strokeWidth="10" strokeDasharray={`${ARC} ${C}`} strokeLinecap="round" />
          <circle cx="60" cy="60" r={R} fill="none" stroke={riskColor(score)} strokeWidth="10" strokeDasharray={`${filled} ${C}`} strokeLinecap="round" />
        </g>
      </svg>
      <div className="home-gauge-label">
        <span className="home-gauge-value">{score}</span>
        <span className="home-metric-sub">portfolio risk</span>
      </div>
    </div>
  );
}

/** Found and fixed per week (bars) with the open count (line), keyed with this period's totals. */
function TrendChart({ weeks, baselines }: { weeks: FindingsWeek[]; baselines: { t: number; label: string }[] }) {
  const found = weeks.reduce((n, w) => n + w.found, 0);
  const fixed = weeks.reduce((n, w) => n + w.fixed, 0);
  const openNow = weeks[weeks.length - 1]?.open ?? 0;
  return (
    <div className="home-trend-body">
      <div className="home-trend-legend">
        <span><i className="home-swatch home-swatch-opened" />Found <strong>{found}</strong></span>
        <span><i className="home-swatch home-swatch-resolved" />Fixed <strong>{fixed}</strong></span>
        <span><i className="home-swatch home-swatch-open" />Open now <strong>{openNow}</strong></span>
        {found + fixed > 0 && <span className={fixed >= found ? 'home-good' : 'home-bad'}>{fixed >= found ? 'burning down' : 'backlog growing'}</span>}
      </div>
      <FindingsTrendChart weeks={weeks} baselines={baselines} />
    </div>
  );
}

/** Mapped features at the end of each week, stacked by kind, with the total now. */
function SurfaceTrend({ points }: { points: Record<string, number>[] }) {
  const last = points[points.length - 1] ?? {};
  const first = points[0] ?? {};
  const total = (p: Record<string, number>) => KINDS.reduce((n, k) => n + (p[k] ?? 0), 0);
  const now = total(last), then = total(first);
  return (
    <div className="home-trend-body">
      <div className="home-trend-legend">
        <span>Mapped now <strong>{now}</strong></span>
        {now !== then && <span className="home-metric-sub">{now > then ? '+' : ''}{now - then} in {WEEKS} weeks</span>}
      </div>
      {/* Key for the lines: one per kind, with its count now. */}
      <div className="home-ageing-legend home-surface-key">
        {KINDS.map((k) => <span key={k}><i style={{ background: `var(--kind-${k})` }} />{KIND_LABEL[k]} {last[k] ?? 0}</span>)}
      </div>
      {now === 0 ? <div className="ovp-empty">Nothing mapped yet.</div> : <SurfaceChart points={points} kinds={[...KINDS]} labels={KIND_LABEL} />}
    </div>
  );
}

/** One square per mapped feature (bench's Overview waffle): coloured by kind, dimmed when no
 *  documented flow walks through it, notched when it has open findings; hover for bench's
 *  feature card. Each project shows the share of its features that flows cover. */
function AttackSurface({ rows, inFlow, totals, onOpenProject }: {
  rows: { p: Project; d?: ProjectData; open: Finding[] }[];
  inFlow: Set<string>;
  totals: { average: number; projects: number };
  onOpenProject: (slug: string, hash?: string) => void;
}) {
  const { card, containerRef, showCard, cancelClose, scheduleClose } = useHoverCard<{ f: Feature; slug: string; open: number; titles: Map<string, string> }>();
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  return (
    <div
      className="home-surface"
      ref={containerRef}
      // Card and square links are workbench hashes (#/features/…): open them in their project.
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        const slug = a.closest('[data-slug]')?.getAttribute('data-slug') ?? card?.payload.slug;
        if (!slug) return;
        e.preventDefault();
        onOpenProject(slug, new URL(a.href, window.location.href).hash);
      }}
    >
      <div className="home-surface-total">
        <span className="home-surface-pct">{Math.round(totals.average * 100)}%</span>
        <span className="home-metric-sub">average flow coverage across {plural(totals.projects, 'project')} (features used in flows)</span>
      </div>
      <ul className="home-list">
        {rows.map((r) => {
          const fs = [...(r.d?.features ?? [])].sort((x, y) =>
            KINDS.indexOf(x.kind as typeof KINDS[number]) - KINDS.indexOf(y.kind as typeof KINDS[number])
            || Number(inFlow.has(`${r.p.slug}:${y.id}`)) - Number(inFlow.has(`${r.p.slug}:${x.id}`)));
          const touched = fs.filter((f) => inFlow.has(`${r.p.slug}:${f.id}`)).length;
          // A big service can map hundreds of features: draw the first SQUARES_MAX (already
          // ordered by kind, flow-covered first) and count the rest.
          const shown = fs.slice(0, SQUARES_MAX);
          const titles = new Map(fs.map((f) => [f.id, f.title]));
          const openBy = new Map<string, number>();
          for (const fd of r.open) for (const id of ((fd as unknown as { features?: string[] }).features ?? [])) openBy.set(id, (openBy.get(id) ?? 0) + 1);
          return (
            <li key={r.p.slug} className="home-surface-row" data-slug={r.p.slug}>
              <span className="home-row-label">{r.p.name}</span>
              {fs.length === 0 ? <span className="home-row-detail home-warn">nothing mapped yet</span> : (
                <span className="ovp-kind-squares" role="group" aria-label={`${r.p.name}: ${fs.length} features, ${touched} on a flow`}>
                  {shown.map((f) => {
                    const on = inFlow.has(`${r.p.slug}:${f.id}`);
                    const open = openBy.get(f.id) ?? 0;
                    return (
                      <a
                        key={f.id}
                        className={`ovp-kind-square${open > 0 ? ' ovp-kind-square-alert' : ''}${on ? '' : ' home-square-off'}`}
                        style={{ background: KIND_COLORS[f.kind] }}
                        href={`#/feature/${f.id}`}
                        aria-label={`${f.title}${on ? '' : ' (not on any flow)'}`}
                        onMouseEnter={(e) => showCard({ f, slug: r.p.slug, open, titles }, e.currentTarget)}
                        onMouseLeave={scheduleClose}
                        onFocus={(e) => showCard({ f, slug: r.p.slug, open, titles }, e.currentTarget)}
                        onBlur={scheduleClose}
                      />
                    );
                  })}
                  {fs.length > shown.length && (
                    <a className="home-squares-more" href="#/features" title={`${fs.length} features in ${r.p.name}`}>+{fs.length - shown.length}</a>
                  )}
                </span>
              )}
              <span className="home-surface-share" title={`${touched} of ${fs.length} on a flow`}>
                {pct(touched, fs.length)}%
              </span>
            </li>
          );
        })}
      </ul>
      <div className="home-ageing-legend">
        {KINDS.map((k) => <span key={k}><i style={{ background: KIND_COLORS[k] }} />{KIND_LABEL[k]}</span>)}
        <span><i className="home-legend-off" />not on a flow</span>
      </div>
      {card && (
        <FeatureMiniCard
          feature={card.payload.f}
          openCount={card.payload.open}
          links={(card.payload.f.linkedFeatures ?? []).filter((lf) => card.payload.titles.has(lf.id))}
          titleById={card.payload.titles}
          className="ovp-kind-card"
          style={{ left: card.left, top: card.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </div>
  );
}
