import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceProfile } from '../core/types';
import { useProfileStore } from '../stores/profile-store';
import { useEvents } from '../core/use-events';

// ---------------------------------------------------------------------------
// Field metadata - options, labels, and the "why this matters" hint per field.
// The hints teach reviewers what each field is for: every attribute exists to
// make some finding class moot or hotter.
// ---------------------------------------------------------------------------

const VALUE_LABELS: Record<string, string> = {
  'vps': 'VPS',
  'bare-metal': 'Bare Metal',
  'pii': 'PII',
  'phi': 'PHI',
  'payment': 'Payment (PCI)',
  'credentials': 'Credentials & Secrets',
  'pci-dss': 'PCI-DSS',
  'hipaa': 'HIPAA',
  'soc2': 'SOC 2',
  'gdpr': 'GDPR',
  'waf': 'WAF',
  'api-gateway': 'API Gateway',
  'ddos-protection': 'DDoS Protection',
  'oauth-oidc': 'OAuth/OIDC',
  'mtls': 'mTLS',
  'api-key': 'API Key',
  'gateway-terminated': 'Terminated at Gateway',
  'first-party-frontend': 'First-party Frontend',
  'internal-services': 'Internal Services',
  'third-party-partners': 'Third-party Partners',
  'general-public': 'General Public',
};

function valueLabel(v: string): string {
  if (VALUE_LABELS[v]) return VALUE_LABELS[v];
  return v.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

type SingleKey = 'externallyFacing' | 'compute' | 'dataSensitivity' | 'criticality' | 'tenancy' | 'lifecycle';
type MultiKey = 'edgeProtections' | 'complianceScope' | 'authenticationModel' | 'consumerType';

interface SingleField {
  key: SingleKey;
  label: string;
  options: string[];
  hint: string;
}

interface MultiField {
  key: MultiKey;
  label: string;
  options: string[];
  hint: string;
}

interface Section {
  title: string;
  singles?: SingleField[];
  multis?: MultiField[];
}

const SECTIONS: Section[] = [
  {
    title: 'Exposure',
    singles: [
      {
        key: 'externallyFacing',
        label: 'Externally Facing',
        options: ['full', 'partial', 'none'],
        hint: 'Internet reachability. "None" downgrades unauthenticated-access and pre-auth findings; "Full" amplifies them.',
      },
      {
        key: 'compute',
        label: 'Compute',
        options: ['vps', 'kubernetes', 'serverless', 'bare-metal'],
        hint: 'The runtime environment shapes the relevance of container-escape, persistence, and local-file findings (e.g. path traversal to persistent disk is moot on serverless).',
      },
    ],
    multis: [
      {
        key: 'edgeProtections',
        label: 'Edge Protections',
        options: ['waf', 'api-gateway', 'rate-limiting', 'ddos-protection', 'none'],
        hint: 'Infra-level controls the app code can\'t see. Rate limiting downgrades brute-force and enumeration findings; a WAF tempers (never dismisses) injection findings.',
      },
    ],
  },
  {
    title: 'Data & Impact',
    singles: [
      {
        key: 'dataSensitivity',
        label: 'Data Sensitivity',
        options: ['public', 'internal', 'pii', 'payment', 'phi', 'credentials'],
        hint: 'The declared highest data classification, and the single biggest impact multiplier. Review-inferred sensitivity above the declared value is itself a signal.',
      },
      {
        key: 'criticality',
        label: 'Criticality',
        options: ['low', 'medium', 'high', 'critical'],
        hint: 'Business impact if compromised or down. Feeds directly into risk-score weighting.',
      },
    ],
    multis: [
      {
        key: 'complianceScope',
        label: 'Compliance Scope',
        options: ['pci-dss', 'hipaa', 'soc2', 'gdpr', 'none'],
        hint: 'Regulatory framing and disclosure obligations for anything found.',
      },
    ],
  },
  {
    title: 'Access',
    singles: [
      {
        key: 'tenancy',
        label: 'Tenancy',
        options: ['single-tenant', 'multi-tenant'],
        hint: 'Multi-tenant amplifies every authorization finding, since cross-tenant data leakage raises the blast radius.',
      },
    ],
    multis: [
      {
        key: 'authenticationModel',
        label: 'Authentication Model',
        options: ['none', 'api-key', 'oauth-oidc', 'mtls', 'session', 'gateway-terminated'],
        hint: 'How callers authenticate. This may live entirely outside app code ("Terminated at Gateway"); missing-auth findings are moot if auth terminates upstream, and "None" plus fully external is the hottest quadrant.',
      },
      {
        key: 'consumerType',
        label: 'Consumer Type',
        options: ['first-party-frontend', 'internal-services', 'third-party-partners', 'general-public'],
        hint: 'Who calls the service. Governs how much input can be trusted and how coordinated a fix rollout must be.',
      },
    ],
  },
  {
    title: 'Lifecycle',
    singles: [
      {
        key: 'lifecycle',
        label: 'Lifecycle',
        options: ['active', 'maintenance', 'deprecated', 'decommissioning'],
        hint: 'Remediation-worthiness. A critical finding on a service scheduled for decommission is triaged differently from one under active development.',
      },
    ],
  },
];

function fieldEqual(a: ServiceProfile[keyof ServiceProfile], b: ServiceProfile[keyof ServiceProfile]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function formatUpdatedAt(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function ConfigView() {
  const profile = useProfileStore((s) => s.profile);
  const configured = useProfileStore((s) => s.configured);
  const loaded = useProfileStore((s) => s.loaded);
  const load = useProfileStore((s) => s.load);
  const save = useProfileStore((s) => s.save);

  const [draft, setDraft] = useState<ServiceProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The profile snapshot the draft was last synced from - used to tell local
  // edits apart from server-side changes when merging.
  const syncedRef = useRef<ServiceProfile>(profile);

  useEffect(() => {
    load();
  }, [load]);

  // Merge incoming profile state (initial load, our own save response, or
  // another session via SSE) into the draft - but keep any field the user
  // has edited since the last sync, so a save round-trip never clobbers
  // in-flight typing.
  useEffect(() => {
    setDraft((d) => {
      const prev = syncedRef.current;
      const next: ServiceProfile = { ...profile };
      for (const k of Object.keys(next) as (keyof ServiceProfile)[]) {
        if (k === 'updatedAt') continue;
        if (!fieldEqual(d[k], prev[k])) {
          (next as unknown as Record<string, unknown>)[k] = d[k];
        }
      }
      return next;
    });
    syncedRef.current = profile;
  }, [profile]);

  useEvents('profile', useCallback(() => { load(); }, [load]));

  const dirtyKeys = useMemo(() => {
    const keys: (keyof ServiceProfile)[] = [];
    for (const k of Object.keys(draft) as (keyof ServiceProfile)[]) {
      if (k === 'updatedAt') continue;
      if (!fieldEqual(draft[k], profile[k])) keys.push(k);
    }
    return keys;
  }, [draft, profile]);

  const dirty = dirtyKeys.length > 0;

  const doSave = useCallback(async (patch: Partial<ServiceProfile>) => {
    setSaving(true);
    setError(null);
    try {
      await save(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [save]);

  // Auto-save: debounce edits, then PATCH only the dirty fields so concurrent
  // edits elsewhere survive. Controls settle instantly; typing gets a pause.
  useEffect(() => {
    if (dirtyKeys.length === 0) return;
    const t = setTimeout(() => {
      const patch: Partial<ServiceProfile> = {};
      for (const k of dirtyKeys) {
        (patch as Record<string, unknown>)[k] = draft[k];
      }
      doSave(patch);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const setSingle = (key: SingleKey, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const toggleMulti = (key: MultiKey, value: string) => {
    setDraft((d) => {
      const current = d[key];
      let next: string[];
      if (current.includes(value)) {
        next = current.filter((v) => v !== value);
      } else if (value === 'none') {
        // 'none' is an explicit exclusive claim.
        next = ['none'];
      } else {
        next = [...current.filter((v) => v !== 'none'), value];
      }
      return { ...d, [key]: next };
    });
  };

  if (!loaded) {
    return <div className="config-view"><div className="config-loading">Loading profile…</div></div>;
  }

  return (
    <div className="config-view">
      <div className="config-column">
        <div className="config-header">
          <div>
            <h2 className="config-title">Service Profile</h2>
          </div>
          <div className="config-header-actions">
            <span
              className={`config-save-status${saving || dirty ? ' config-save-status-pending' : ''}`}
              role="status"
            >
              {saving || dirty ? (
                'Saving…'
              ) : error ? (
                'Save failed'
              ) : configured ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="7" cy="7" r="6" />
                    <path d="M4.5 7l2 2 3-3.5" />
                  </svg>
                  Saved
                </>
              ) : null}
            </span>
            {profile.updatedAt && (
              <span className="config-updated-at">Last updated {formatUpdatedAt(profile.updatedAt)}</span>
            )}
          </div>
        </div>

        {error && <div className="config-error">{error}</div>}

        <div className="config-section">
          <h3 className="config-section-title">Identity</h3>
          <div className="config-field">
            <label className="finding-form-label" htmlFor="config-description">Description</label>
            <textarea
              id="config-description"
              className="finding-edit-textarea"
              placeholder="What does this service do?"
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              rows={3}
            />
          </div>
          <div className="config-field">
            <label className="finding-form-label" htmlFor="config-owner">Owner</label>
            <input
              id="config-owner"
              className="finding-edit-input"
              placeholder="Team or person accountable, e.g. platform-team"
              value={draft.owner}
              onChange={(e) => setDraft((d) => ({ ...d, owner: e.target.value }))}
            />
          </div>
        </div>

        {SECTIONS.map((section) => (
          <div className="config-section" key={section.title}>
            <h3 className="config-section-title">{section.title}</h3>
            {section.singles?.map((field) => (
              <div className="config-field" key={field.key}>
                <label className="finding-form-label">{field.label}</label>
                <p className="config-hint">{field.hint}</p>
                <div className="config-choices config-choices-radio" role="radiogroup" aria-label={field.label}>
                  {['', ...field.options].map((opt) => (
                    <button
                      key={opt || '__unset'}
                      className={`config-choice config-choice-radio${draft[field.key] === opt ? ' config-choice-active' : ''}`}
                      role="radio"
                      aria-checked={draft[field.key] === opt}
                      onClick={() => setSingle(field.key, opt)}
                    >
                      <span className="config-choice-ind config-choice-ind-radio" aria-hidden="true" />
                      {opt === '' ? 'Not set' : valueLabel(opt)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {section.multis?.map((field) => (
              <div className="config-field" key={field.key}>
                <label className="finding-form-label">{field.label}</label>
                <p className="config-hint">{field.hint}</p>
                <div className="config-choices config-choices-check" role="group" aria-label={field.label}>
                  {field.options.map((opt) => {
                    const checked = draft[field.key].includes(opt);
                    const noneSelected = draft[field.key].includes('none');
                    const disabled = noneSelected && opt !== 'none';
                    return (
                      <label
                        key={opt}
                        className={`config-choice config-choice-check${checked ? ' config-choice-active' : ''}${disabled ? ' config-choice-disabled' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleMulti(field.key, opt)}
                        />
                        <span className="config-choice-ind config-choice-ind-check" aria-hidden="true" />
                        {opt === 'none' ? 'None (confirmed absent)' : valueLabel(opt)}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
