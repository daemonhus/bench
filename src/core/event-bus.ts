/**
 * Singleton SSE event bus.
 * Connects to GET /api/events and dispatches topic-based notifications.
 * Auto-reconnects on disconnect with jittered backoff.
 */

import { getApiBase } from './api';

type Topic = 'annotations' | 'baselines' | 'git';
type Listener = () => void;

const listeners = new Map<Topic, Set<Listener>>();
let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function jitter(base: number): number {
  return base + Math.random() * 500;
}

function connect() {
  if (eventSource) return;

  const url = `${getApiBase()}/api/events`;
  const es = new EventSource(url);
  eventSource = es;

  const topics: Topic[] = ['annotations', 'baselines', 'git'];
  for (const topic of topics) {
    es.addEventListener(topic, () => {
      const delay = jitter(50);
      setTimeout(() => {
        const set = listeners.get(topic);
        if (set) {
          for (const fn of set) fn();
        }
      }, delay);
    });
  }

  es.onerror = () => {
    es.close();
    eventSource = null;
    // Reconnect with jittered backoff
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (listeners.size > 0) connect();
      }, jitter(2000));
    }
  };
}

function disconnect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

export function subscribe(topic: Topic, fn: Listener): () => void {
  let set = listeners.get(topic);
  if (!set) {
    set = new Set();
    listeners.set(topic, set);
  }
  set.add(fn);

  // Connect on first subscriber
  if (!eventSource && !reconnectTimer) {
    connect();
  }

  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(topic);
    // Disconnect when no listeners remain
    if (listeners.size === 0) disconnect();
  };
}
