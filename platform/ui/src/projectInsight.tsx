import { useEffect, useState } from 'react';
import { ToneChip } from '@bench/components/SelectDropdown';

// What the platform knows about a project beyond its stats: fix-time SLAs, finding age, and the
// service profile's exposure. Shared by the home dashboard and the project cards.

export { SLA_DAYS, ageDays, pastSla, type Sev } from '@bench/core/sla';

/** "1 commit", "3 commits". */
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface Profile { externallyFacing?: string; dataSensitivity?: string; criticality?: string; owner?: string }

export const profileIsSet = (p: Profile | null) => !!(p && (p.externallyFacing || p.dataSensitivity || p.criticality));

const profileCache = new Map<string, Profile | null>();

/** A project's service profile (cached per session; null when it has none or it can't be read). */
export function useProfile(slug: string): Profile | null | undefined {
  const [profile, setProfile] = useState<Profile | null | undefined>(profileCache.get(slug));
  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${slug}/profile`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((p: Profile | null) => { profileCache.set(slug, p); if (live) setProfile(p); });
    return () => { live = false; };
  }, [slug]);
  return profile;
}

/** Exposure from the service profile, as read-only chips: internet-facing and high criticality stand out. */
export function Exposure({ profile }: { profile: Profile | null | undefined }) {
  if (profile === undefined) return null; // still loading
  // No service profile: show nothing (the home page's Next actions already flags missing profiles).
  if (!profileIsSet(profile)) return null;
  const p = profile!;
  const facing = ({ full: 'internet', partial: 'partly public', none: 'internal' } as Record<string, string>)[p.externallyFacing ?? ''];
  const hot = 'var(--severity-critical)';
  return (
    <span className="exposure-chips">
      {facing && <ToneChip label={facing} tone={p.externallyFacing === 'full' ? hot : undefined} title="Exposure" />}
      {p.dataSensitivity && p.dataSensitivity !== 'public' && <ToneChip label={p.dataSensitivity} title="Data sensitivity" />}
      {p.criticality && <ToneChip label={p.criticality} tone={p.criticality === 'critical' || p.criticality === 'high' ? hot : undefined} title="Criticality" />}
    </span>
  );
}
