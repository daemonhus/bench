import { useEffect } from 'react';
import { subscribe } from './event-bus';

type Topic = 'annotations' | 'baselines' | 'git';

/**
 * Subscribe to one or more SSE topics. Calls `callback` when any of
 * the specified topics fire. The callback is stable-ref'd internally
 * so callers don't need to memoize it.
 */
export function useEvents(topics: Topic | Topic[], callback: () => void): void {
  useEffect(() => {
    const list = Array.isArray(topics) ? topics : [topics];
    const unsubs = list.map((t) => subscribe(t, callback));
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(topics) ? topics.join(',') : topics, callback]);
}
