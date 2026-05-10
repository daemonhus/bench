// Unified orphan signal across entity types.
//
// Features carry orphan state on `status` (the FeatureStatus enum includes
// 'orphaned'). Findings and comments carry it on `confidence` — the position
// resolver tags annotations whose code couldn't be located.
//
// Anything that needs to ask "is this orphaned?" should go through this helper
// so a future schema change only needs to land in one place.

import type { Finding, Comment, Feature } from './types';
import { getConfidence } from './types';

export function isOrphaned(entity: Finding | Comment | Feature): boolean {
  if ('status' in entity && (entity as Feature).status === 'orphaned') return true;
  return getConfidence(entity) === 'orphaned';
}

export function countOrphaned<T extends Finding | Comment | Feature>(items: T[]): number {
  let n = 0;
  for (const item of items) if (isOrphaned(item)) n++;
  return n;
}
