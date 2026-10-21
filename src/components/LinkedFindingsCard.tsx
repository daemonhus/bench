import { useMemo } from 'react';
import type { Finding } from '../core/types';
import { isOpenFinding } from '../core/finding-categories';
import { FINDING_STATUS_OPTIONS, SEVERITY_OPTIONS } from '../core/status-options';
import { ToneChip } from './SelectDropdown';
import { useForeignFindings, useOpenRef } from '../core/cross-refs';

// The findings linked to a feature, for the side column of the feature's page: open ones
// first by severity, then the closed ones, dimmed. Each opens the finding's page; the count
// opens the Findings list filtered to this feature, as the list card's link does. On a bench
// server, other projects' findings that affect the feature follow, labelled with their project.

/** Rows shown before "+N more" (which opens the filtered list). */
const SHOWN = 8;
const SEVERITY_RANK = new Map(SEVERITY_OPTIONS.map((o, i) => [o.value as string, i]));

const NO_REFS: string[] = [];

export function LinkedFindingsCard({ featureId, findings, crossRefs = NO_REFS }: {
  featureId: string;
  findings: Finding[];
  /** Other projects' findings affecting the feature ("<project>:<id>"). */
  crossRefs?: string[];
}) {
  const foreign = useForeignFindings(crossRefs);
  const openRef = useOpenRef();
  const others = useMemo(() => crossRefs
    .map((r) => foreign.get(r))
    .filter((x): x is NonNullable<typeof x> => !!x && !x.missing)
    .map((x) => ({ x, open: isOpenFinding({ status: x.status } as Finding) }))
    .sort((a, b) => Number(b.open) - Number(a.open) || (SEVERITY_RANK.get(a.x.severity) ?? 9) - (SEVERITY_RANK.get(b.x.severity) ?? 9)),
  [crossRefs, foreign]);
  const linked = useMemo(() => findings
    .filter((f) => f.features?.includes(featureId))
    .map((f) => ({ f, open: isOpenFinding(f) }))
    .sort((a, b) =>
      Number(b.open) - Number(a.open)
      || (SEVERITY_RANK.get(a.f.severity) ?? 9) - (SEVERITY_RANK.get(b.f.severity) ?? 9)
      || a.f.title.localeCompare(b.f.title)),
  [findings, featureId]);
  const openCount = linked.filter((l) => l.open).length;
  const listHash = `#/findings/feature/${featureId}`;

  return (
    <div className="fd-card fd-findings-card">
      <h2 className="fd-card-title">
        Findings <span className="fd-count" title={`${openCount} open`}>{linked.length + others.length}</span>
        {linked.length > 0 && <a className="fd-card-action" href={listHash}>View in list</a>}
      </h2>
      {linked.length + others.length === 0 ? (
        <div className="fd-muted">No findings linked to this feature.</div>
      ) : linked.length === 0 ? null : (
        <div className="fd-linked">
          {linked.slice(0, SHOWN).map(({ f, open }) => {
            const status = FINDING_STATUS_OPTIONS.find((o) => o.value === f.status);
            return (
              <a key={f.id} className={`fd-linked-item fd-finding-row${open ? '' : ' fd-finding-row--closed'}`} href={`#/finding/${f.id}`}>
                <span className="fd-finding-dot" style={{ background: `var(--severity-${f.severity})` }} title={f.severity} aria-label={f.severity} />
                <span className="fd-finding-title">{f.title}</span>
                <ToneChip label={status?.label ?? f.status} tone={status?.tone} />
              </a>
            );
          })}
          {linked.length > SHOWN && (
            <a className="fd-findings-more" href={listHash}>+{linked.length - SHOWN} more</a>
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="fd-linked fd-linked--other" aria-label="In other projects">
          {others.map(({ x, open }) => {
            const status = FINDING_STATUS_OPTIONS.find((o) => o.value === x.status);
            return (
              <button key={x.ref} type="button" className={`fd-linked-item fd-finding-row${open ? '' : ' fd-finding-row--closed'}`} onClick={() => openRef(x.ref, 'finding')}>
                <span className="fd-finding-dot" style={{ background: `var(--severity-${x.severity})` }} title={x.severity} aria-label={x.severity} />
                <span className="fd-linked-project">{x.projectName}</span>
                <span className="fd-finding-title">{x.title}</span>
                <ToneChip label={status?.label ?? x.status} tone={status?.tone} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
