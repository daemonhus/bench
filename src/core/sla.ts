// Fix-time SLAs: how long an open finding of each severity may stay open. The platform's home,
// project cards and Activity use the same rule as the findings list's Past SLA filter.

export type Sev = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Days an open finding of each severity may stay open before it is past SLA. */
export const SLA_DAYS: Record<Sev, number> = { critical: 7, high: 30, medium: 90, low: 180, info: Infinity };

const DAY = 86_400_000;

export const ageDays = (iso?: string) => (iso ? Math.max(0, (Date.now() - new Date(iso).getTime()) / DAY) : 0);

/** Open findings past their severity's SLA. */
export function pastSla<T extends { severity: string; createdAt?: string }>(open: T[]): T[] {
  return open.filter((f) => ageDays(f.createdAt) > SLA_DAYS[f.severity as Sev]);
}
