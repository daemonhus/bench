import { useEffect, useState } from 'react';
import { listAllFlows, flowStatusOption, type FlowSummary } from './flows';
import { ToneChip } from '@bench/components/SelectDropdown';
import { SkeletonRows } from '@bench/components/Skeleton';

// "Used in flows": for a workbench feature page, every documented flow that walks through this
// feature, as "Flow name, step N", with where it sits in the path and what else the flow touches.
// Rendered into bench's feature detail side column through WorkbenchView's extensions.

type ShapeNode = NonNullable<FlowSummary['shape']>[number];

/** Step numbers as the flow page shows them: depth-first, siblings by position. */
function numberSteps(shape: ShapeNode[]): Map<string, number> {
  const kids = new Map<string, ShapeNode[]>();
  for (const n of shape) {
    const k = n.parentStepId ?? '';
    kids.set(k, [...(kids.get(k) ?? []), n]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  const out = new Map<string, number>();
  let i = 1;
  const walk = (parent: string) => { for (const n of kids.get(parent) ?? []) { out.set(n.id, i++); walk(n.id); } };
  walk('');
  return out;
}

interface Use {
  flow: FlowSummary;
  steps: number[];
  total: number;
  role: 'entry point' | 'end of path' | 'mid-path';
  others: string[];
}

function usesOf(flows: FlowSummary[], slug: string, featureId: string): Use[] {
  const out: Use[] = [];
  for (const flow of flows) {
    const shape = flow.shape ?? [];
    const here = shape.filter((n) => n.projectSlug === slug && n.featureId === featureId);
    if (here.length === 0) continue;
    const nums = numberSteps(shape);
    const hasChildren = (id: string) => shape.some((n) => n.parentStepId === id);
    const first = here[0];
    const role = !first.parentStepId && nums.get(first.id) === 1 ? 'entry point' : !hasChildren(first.id) ? 'end of path' : 'mid-path';
    out.push({
      flow,
      steps: here.map((n) => nums.get(n.id) ?? 0).sort((a, b) => a - b),
      total: shape.length,
      role,
      others: flow.projectSlugs.filter((s) => s !== slug),
    });
  }
  return out.sort((a, b) => a.flow.name.localeCompare(b.flow.name));
}

const stepLabel = (steps: number[]) =>
  steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}`;

export function FeatureFlowsCard({ projectSlug, featureId, onOpenFlow }: {
  projectSlug: string;
  featureId: string;
  onOpenFlow: (id: string) => void;
}) {
  const [uses, setUses] = useState<Use[] | null>(null);
  useEffect(() => {
    let live = true;
    listAllFlows({ withFindings: true, project: [projectSlug] })
      .then((items) => { if (live) setUses(usesOf(items, projectSlug, featureId)); })
      .catch(() => { if (live) setUses([]); });
    return () => { live = false; };
  }, [projectSlug, featureId]);

  return (
    <div className="fd-card ff-card">
      <h2 className="fd-card-title">Used in flows {uses && <span className="fd-count">{uses.length}</span>}</h2>
      {uses == null ? <SkeletonRows rows={2} height={36} gap={8} lastWidth="100%" />
        : uses.length === 0 ? <div className="fd-muted">Not on any documented flow yet.</div>
        : (
          <ul className="ff-list">
            {uses.map((u) => {
              const crit = u.flow.openFindings?.critical ?? 0;
              const high = u.flow.openFindings?.high ?? 0;
              return (
                <li key={u.flow.id}>
                  <button type="button" className="ff-row" onClick={() => onOpenFlow(u.flow.id)}>
                    <span className="ff-row-top">
                      <span className="ff-name">{u.flow.name}, {stepLabel(u.steps)}</span>
                      <ToneChip label={flowStatusOption(u.flow.status)?.label ?? u.flow.status} tone={flowStatusOption(u.flow.status)?.tone} title="Status" />
                    </span>
                    <span className="ff-meta">
                      <span>of {u.total}</span>
                      <span>{u.role}</span>
                      {u.others.length > 0 && <span>also {u.others.join(', ')}</span>}
                      {(crit > 0 || high > 0) && (
                        <span className="ff-findings">
                          {crit > 0 && <><i style={{ background: 'var(--severity-critical)' }} />{crit} critical</>}
                          {high > 0 && <><i style={{ background: 'var(--severity-high)' }} />{high} high</>}
                          {' '}open on the path
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
