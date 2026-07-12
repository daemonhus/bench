// Labels and one-line descriptions for finding categories, shared by the
// Overview systemic-issues panel and the Findings metrics heatmap.

export const CATEGORY_META: Record<string, { label: string; desc: string }> = {
  'auth': { label: 'Authentication', desc: 'Verifying who the caller is: logins, tokens, credentials' },
  'authz': { label: 'Authorization', desc: 'What callers may do: access control, object-level checks' },
  'session': { label: 'Session Management', desc: 'Session lifecycle: fixation, expiry, invalidation' },
  'injection': { label: 'Injection', desc: 'Untrusted input reaching interpreters: SQL, command, template' },
  'ssrf': { label: 'SSRF', desc: 'Server-side requests to attacker-chosen destinations' },
  'crypto': { label: 'Cryptography', desc: 'Weak algorithms, poor randomness, key handling' },
  'data-exposure': { label: 'Data Exposure', desc: 'Sensitive data leaked via responses, logs, or storage' },
  'input-validation': { label: 'Input Validation', desc: 'Missing or weak validation of untrusted input' },
  'path-traversal': { label: 'Path Traversal', desc: 'File paths escaping their intended directory' },
  'deserialization': { label: 'Deserialization', desc: 'Untrusted data deserialised into live objects' },
  'race-condition': { label: 'Race Conditions', desc: 'Time-of-check to time-of-use and concurrency flaws' },
  'config': { label: 'Configuration', desc: 'Insecure defaults and missing hardening' },
  'error-handling': { label: 'Error Handling', desc: 'Failures that leak detail or fail open' },
  'logging': { label: 'Logging', desc: 'Missing audit trails or sensitive data in logs' },
  'business-logic': { label: 'Business Logic', desc: 'Flaws in the rules the application enforces' },
  'dependencies': { label: 'Dependencies', desc: 'Vulnerable or outdated third-party components' },
  'uncategorised': { label: 'Uncategorised', desc: 'Findings without a category assigned' },
  'uncategorized': { label: 'Uncategorised', desc: 'Findings without a category assigned' },
};

export function categoryMeta(cat: string): { label: string; desc: string } {
  const titleCased = cat.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return CATEGORY_META[cat] ?? { label: titleCased, desc: 'Findings in this category' };
}

export const SEVERITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

/** A finding counts as open unless closed or carrying a resolved commit. */
export function isOpenFinding(f: { status: string; resolvedCommit?: string }): boolean {
  return f.status !== 'closed' && !f.resolvedCommit;
}
