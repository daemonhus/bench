import { useMemo } from 'react';
import type { Finding } from '../core/types';
import { isOpenFinding } from '../core/finding-categories';
import { FINDING_STATUS_OPTIONS, SEVERITY_OPTIONS } from '../core/status-options';
import { ToneChip } from './SelectDropdown';

// The findings linked to a feature, for the side column of the feature's page: open ones
// first by severity, then the closed ones, dimmed. Each opens the finding's page; the count
// opens the Findings list filtered to this feature, as the list card's link does.

/** Rows shown before "+N more" (which opens the filtered list). */
const SHOWN = 8;
const SEVERITY_RANK = new Map(SEVERITY_OPTIONS.map((o, i) => [o.value as string, i]));

export function LinkedFindingsCard({ featureId, findings }: { featureId: string; findings: Finding[] }) {
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
        Findings <span className="fd-count" title={`${openCount} open`}>{linked.length}</span>
        {linked.length > 0 && <a className="fd-card-action" href={listHash}>View in list</a>}
      </h2>
      {linked.length === 0 ? (
        <div className="fd-muted">No findings linked to this feature.</div>
      ) : (
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
    </div>
  );
}
