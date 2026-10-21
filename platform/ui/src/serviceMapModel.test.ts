import { describe, it, expect } from 'vitest';
import {
  applyFilters, layoutMap, neighbourhood, connectionKey, DEFAULT_FILTERS, CARD_W,
  type ServiceMapData, type MapFeature, type MapConnection,
} from './serviceMapModel';

const feat = (id: string, kind: MapFeature['kind'], flowCount = 1): MapFeature =>
  ({ id, kind, title: id, tags: [], openFindings: 0, flowCount, flows: [] });
const conn = (from: string, to: string, kind: MapConnection['kind'] = 'call'): MapConnection => {
  const [fp, ff] = from.split(':');
  const [tp, tf] = to.split(':');
  return { fromProject: fp, fromFeature: ff, toProject: tp, toFeature: tf, kind, protocol: 'http', auth: [], trustBoundary: false, tainted: false, count: 1, flows: [] };
};

const data: ServiceMapData = {
  services: [
    { slug: 'web', name: 'Web', features: [feat('form', 'interface'), feat('unused', 'interface', 0)] },
    { slug: 'api', name: 'API', features: [feat('login', 'interface'), feat('db', 'sink'), feat('health', 'interface', 0)] },
    { slug: 'queue', name: 'Queue', features: [feat('events', 'dependency')] },
  ],
  connections: [conn('web:form', 'api:login'), conn('api:login', 'queue:events', 'async')],
  internal: [conn('api:login', 'api:db', 'write')],
};

describe('applyFilters', () => {
  it('lists the features on flows by default, without internal edges', () => {
    const v = applyFilters(data, DEFAULT_FILTERS);
    expect(v.services.map((s) => s.features.map((f) => f.id))).toEqual([['form'], ['login', 'db'], ['events']]);
    expect(v.connections).toHaveLength(2);
  });

  it('narrows to connected features, or widens to all', () => {
    expect(applyFilters(data, { ...DEFAULT_FILTERS, scope: 'connected' }).services[1].features.map((f) => f.id)).toEqual(['login']);
    expect(applyFilters(data, { ...DEFAULT_FILTERS, scope: 'all' }).services[1].features.map((f) => f.id)).toEqual(['health', 'login', 'db']);
  });

  it('drops connections of a disabled kind, to a hidden service, or to a disabled feature kind', () => {
    expect(applyFilters(data, { ...DEFAULT_FILTERS, connectionKinds: ['call'] }).connections.map((c) => c.toProject)).toEqual(['api']);
    const noQueue = applyFilters(data, { ...DEFAULT_FILTERS, hiddenServices: ['queue'] });
    expect(noQueue.services.map((s) => s.slug)).toEqual(['web', 'api']);
    expect(noQueue.connections).toHaveLength(1);
    expect(applyFilters(data, { ...DEFAULT_FILTERS, featureKinds: ['interface', 'sink'] }).connections).toHaveLength(1);
  });

  it('adds internal edges when asked', () => {
    expect(applyFilters(data, { ...DEFAULT_FILTERS, internal: true }).connections).toHaveLength(3);
  });
});

describe('layoutMap', () => {
  it('runs left to right with connections leaving and entering the feature rows', () => {
    const l = layoutMap(applyFilters(data, { ...DEFAULT_FILTERS, internal: true }));
    const x = (slug: string) => l.cards.find((c) => c.service.slug === slug)!.x;
    expect(x('web')).toBeLessThan(x('api'));
    expect(x('api')).toBeLessThan(x('queue'));
    const first = l.links.find((k) => k.connection.toProject === 'api' && !k.internal)!;
    expect(first.x1).toBe(x('web') + CARD_W);
    expect(first.x2).toBe(x('api'));
    expect(first.back).toBe(false);
    const internal = l.links.find((k) => k.internal)!;
    expect(internal.x1).toBe(internal.x2);
    expect(l.bounds.maxX).toBeGreaterThan(l.bounds.minX);
  });
});

describe('neighbourhood', () => {
  it('collects what one hop from a feature touches', () => {
    const v = applyFilters(data, DEFAULT_FILTERS);
    const n = neighbourhood(v, { slug: 'api', feature: 'login' });
    expect([...n.features].sort()).toEqual(['api:login', 'queue:events', 'web:form']);
    expect(n.connections.has(connectionKey(data.connections[0]))).toBe(true);
  });
});
