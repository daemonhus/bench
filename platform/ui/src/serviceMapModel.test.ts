import { describe, it, expect } from 'vitest';
import {
  applyFilters, layoutMap, neighbourhood, connectionKey, linkKey, crossesBoundary, DEFAULT_FILTERS, CARD_W, ROW_CAP,
  type ServiceMapData, type MapFeature, type MapConnection, type MapLink,
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
  links: [],
};

const link = (from: string, to: string, inFlows = false): MapLink => {
  const [fp, ff] = from.split(':');
  const [tp, tf] = to.split(':');
  return { fromProject: fp, fromFeature: ff, toProject: tp, toFeature: tf, inFlows };
};

describe('feature links', () => {
  // web:form is linked to api:login (a flow covers it), web:unused to queue:events (none does),
  // and api:health to api:db (inside one service).
  const linked: ServiceMapData = {
    ...data,
    links: [link('web:form', 'api:login', true), link('queue:events', 'web:unused'), link('api:health', 'api:db')],
  };

  it('draws only the links no flow covers, between services unless internal edges are on', () => {
    expect(applyFilters(linked, DEFAULT_FILTERS).links.map(linkKey)).toEqual(['queue:events~web:unused']);
    expect(applyFilters(linked, { ...DEFAULT_FILTERS, internal: true }).links).toHaveLength(2);
    expect(applyFilters(linked, { ...DEFAULT_FILTERS, links: false }).links).toEqual([]);
    expect(applyFilters(linked, { ...DEFAULT_FILTERS, hiddenServices: ['queue'] }).links).toEqual([]);
  });

  it("keeps a linked feature on its card even when it isn't on a flow", () => {
    const v = applyFilters(linked, { ...DEFAULT_FILTERS, scope: 'connected' });
    expect(v.services[0].features.map((f) => f.id)).toEqual(['form', 'unused']);
  });

  it('draws a link left to right, and lights it from either end', () => {
    const v = applyFilters(linked, DEFAULT_FILTERS);
    const l = layoutMap(v);
    const [fl] = l.featureLinks;
    expect(fl.x1).toBeLessThan(fl.x2);
    expect(neighbourhood(v, { slug: 'web', feature: 'unused' }).connections.has('queue:events~web:unused')).toBe(true);
  });

  it('groups services joined only by a link', () => {
    // Groups are placed before lone services, and lone ones by name: "0 Edge" would come
    // first if the link didn't make A and B a group.
    const lone: ServiceMapData = {
      services: [
        { slug: 'a', name: 'A', features: [feat('x', 'interface')] },
        { slug: 'b', name: 'B', features: [feat('y', 'interface')] },
        { slug: 'c', name: '0 Edge', features: [feat('z', 'interface')] },
      ],
      connections: [], internal: [], links: [link('a:x', 'b:y')],
    };
    // Placement order: rows top to bottom, then left to right.
    const order = (d: ServiceMapData) => layoutMap(applyFilters(d, DEFAULT_FILTERS)).cards
      .slice().sort((p, q) => p.y - q.y || p.x - q.x).map((c) => c.service.slug);
    expect(order(lone).at(-1)).toBe('c');
    expect(order({ ...lone, links: [] })[0]).toBe('c');
  });
});

describe('crossesBoundary', () => {
  it('counts a marked boundary or ends in different zones', () => {
    expect(crossesBoundary(conn('a:x', 'b:y'))).toBe(false);
    expect(crossesBoundary({ ...conn('a:x', 'b:y'), trustBoundary: true })).toBe(true);
    expect(crossesBoundary({ ...conn('a:x', 'b:y'), zoneBoundary: true })).toBe(true);
  });
});

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

describe('layoutMap at scale', () => {
  // Forty services of 200 features each; a few pairs joined, the rest on their own.
  const many: ServiceMapData = {
    services: Array.from({ length: 40 }, (_, i) => ({
      slug: `svc${i}`, name: `Service ${String(i).padStart(2, '0')}`,
      features: Array.from({ length: 200 }, (_, j) => ({ ...feat(`f${j}`, 'interface'), openFindings: j === 150 ? 2 : 0 })),
    })),
    connections: [conn('svc0:f199', 'svc1:f0'), conn('svc1:f0', 'svc2:f5'), conn('svc10:f3', 'svc11:f4')],
    internal: [],
  };
  const v = applyFilters(many, { ...DEFAULT_FILTERS, scope: 'all' });
  const l = layoutMap(v);
  const card = (slug: string) => l.cards.find((c) => c.service.slug === slug)!;

  it('caps a card at ROW_CAP rows, keeping connected and flagged features, and folds the rest', () => {
    const c = card('svc0');
    expect(c.rows).toHaveLength(ROW_CAP);
    expect(c.more).toBe(200 - ROW_CAP);
    expect(c.rows.map((f) => f.id)).toContain('f199'); // connected
    expect(c.rows.map((f) => f.id)).toContain('f150'); // open findings
    // A folded feature's connections land on the "+N more" row.
    expect(card('svc1').rowY.get('f99')).toBe(card('svc1').moreY);
  });

  it('expands a card on request, and keeps pinned features in view', () => {
    const e = layoutMap(v, { expanded: new Set(['svc3']), pinned: new Set(['svc4:f120']) });
    expect(e.cards.find((c) => c.service.slug === 'svc3')!.rows).toHaveLength(200);
    expect(e.cards.find((c) => c.service.slug === 'svc4')!.rows.map((f) => f.id)).toContain('f120');
  });

  it('packs the services into a screen-shaped area with no overlaps, not one column', () => {
    const w = l.bounds.maxX - l.bounds.minX;
    const h = l.bounds.maxY - l.bounds.minY;
    expect(w / h).toBeGreaterThan(0.8);
    expect(w / h).toBeLessThan(4);
    const boxes = l.cards.map((c) => ({ x1: c.x, y1: c.y, x2: c.x + CARD_W, y2: c.y + c.h }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1, `${l.cards[i].service.slug} overlaps ${l.cards[j].service.slug}`).toBe(true);
    }
    // A joined group still runs left to right.
    expect(card('svc0').x).toBeLessThan(card('svc1').x);
    expect(card('svc1').x).toBeLessThan(card('svc2').x);
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
