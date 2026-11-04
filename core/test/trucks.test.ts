import { describe, expect, it } from 'vitest';
import { distancesFrom, newGame, routeVia, shortestPath, type Game, type GameEvent } from '../src/index.js';

/** A game where player 0 is president of company 0 (no auctions yet, so set shares directly). */
function setup(o: Parameters<typeof newGame>[0] = {}) {
  const g = newGame({ seed: 7, ...o });
  g.companies[0].shares = [0, null, null, null, null];
  const depot = g.town.locations.find((l) => l.startCompany === 0)!;
  const d = distancesFrom(g.town.graph, depot.node);
  // Nearest producer, and the nearest consumer of the same good.
  const byDist = (kind: string, good?: number) =>
    g.town.locations
      .filter((l) => l.kind === kind && (good === undefined || l.good === good))
      .sort((a, b) => d[a.node] - d[b.node]);
  const producer = byDist('producer')[0];
  const consumer = byDist('consumer', producer.good!)[0];
  return { g, depot, producer, consumer };
}

function runFor(g: Game, sec: number) {
  const n = Math.round(sec / g.cfg.tickSec);
  for (let i = 0; i < n && !g.done; i++) g.step();
}

function events(g: Game, type: string): GameEvent[] {
  return g.drainEvents(0).filter((e) => e.type === type);
}

describe('routing', () => {
  it('finds shortest routes that agree with driving distances', () => {
    const { g } = setup();
    const graph = g.town.graph;
    const d = distancesFrom(graph, 0);
    for (const target of [5, 40, 100, graph.nodes.length - 1]) {
      const path = shortestPath(graph, 0, target)!;
      expect(path[0]).toBe(0);
      expect(path[path.length - 1]).toBe(target);
      let len = 0;
      for (let i = 1; i < path.length; i++) {
        const e = graph.adj[path[i - 1]].find((x) => x.to === path[i])!;
        len += graph.edges[e.edge].length;
      }
      expect(len).toBeCloseTo(d[target]);
    }
  });

  it('routes through waypoints in order', () => {
    const { g } = setup();
    const route = routeVia(g.town.graph, [0, 60, 10])!;
    expect(route[0]).toBe(0);
    expect(route).toContain(60);
    expect(route[route.length - 1]).toBe(10);
    expect(route.indexOf(60)).toBeLessThan(route.lastIndexOf(10));
  });
});

describe('trucks', () => {
  it('runs a load -> unload loop, delivering pallets that credit both ends', () => {
    const { g, producer, consumer } = setup();
    const truck = g.addTruck(0);
    g.act(0, {
      type: 'setOrders',
      truck: truck.id,
      stops: [
        { location: producer.id, action: 'load' },
        { location: consumer.id, action: 'unload' },
      ],
    });
    runFor(g, 300);
    const delivered = events(g, 'delivered');
    expect(delivered.length).toBeGreaterThanOrEqual(2);
    for (const e of delivered) if (e.type === 'delivered') expect(e.origin).toBe(producer.id);
  });

  it('drives at the configured speed', () => {
    const { g, depot, producer } = setup();
    const truck = g.addTruck(0);
    const dist = distancesFrom(g.town.graph, depot.node)[producer.node];
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }] });
    const expectSec = dist / g.cfg.trucks.speed;
    runFor(g, expectSec - 1);
    expect(g.trucks.trucks[0].state).toBe('driving');
    runFor(g, 1.5);
    expect(['queued', 'servicing']).toContain(g.trucks.trucks[0].state);
  });

  it('only presidents can give orders, and stops must make sense', () => {
    const { g, producer, consumer } = setup();
    const truck = g.addTruck(0);
    g.act(1, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }] });
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: consumer.id, action: 'load' }] });
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'unload' }] });
    g.act(0, { type: 'setOrders', truck: 99, stops: [] });
    g.step();
    expect(g.drainEvents(1).filter((e) => e.type === 'rejected')).toHaveLength(1);
    expect(g.drainEvents(0).filter((e) => e.type === 'rejected')).toHaveLength(3);
    expect(g.trucks.trucks[0].orders).toHaveLength(0);
  });

  it('co-presidents: the last order wins', () => {
    const { g, producer, consumer } = setup();
    g.companies[0].shares = [0, 1, null, null, null];
    const truck = g.addTruck(0);
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }] });
    g.act(1, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }, { location: consumer.id, action: 'unload' }] });
    g.step();
    expect(g.trucks.trucks[0].orders).toHaveLength(2);
  });

  it('queues at a building: two bays, first come first served, waiting trucks keep their place', () => {
    const { g, producer } = setup({ cycles: { produceBase: 1, cycleSec: [60, 60] } });
    const trucks = [g.addTruck(0), g.addTruck(0), g.addTruck(0), g.addTruck(0)];
    // Stagger departures so arrival order is known.
    for (const t of trucks) {
      g.act(0, { type: 'setOrders', truck: t.id, stops: [{ location: producer.id, action: 'load' }] });
      runFor(g, 0.5);
    }
    runFor(g, 200);
    const loaded = events(g, 'loaded').map((e) => (e.type === 'loaded' ? e.truck : -1));
    // One pallet per cycle at this producer, so trucks load one at a time, in arrival order.
    expect(loaded.slice(0, 3)).toEqual([0, 1, 2]);
    const st = g.observe(0);
    const q = st.queues[producer.id] ?? [];
    expect(q.length).toBeLessThanOrEqual(4);
  });

  it('never has more trucks loading than the building has bays', () => {
    const { g, producer } = setup({ cycles: { produceBase: 6 }, trucks: { serviceSec: 20 } });
    for (let i = 0; i < 5; i++) {
      const t = g.addTruck(0);
      g.act(0, { type: 'setOrders', truck: t.id, stops: [{ location: producer.id, action: 'load' }] });
    }
    let maxBusy = 0;
    for (let i = 0; i < 3000; i++) {
      g.step();
      const busy = g.trucks.trucks.filter((t) => t.state === 'servicing' && t.at === producer.id).length;
      maxBusy = Math.max(maxBusy, busy);
    }
    expect(maxBusy).toBe(producer.bays);
  });

  it('waits at a satisfied consumer instead of dumping', () => {
    const { g, producer, consumer } = setup();
    const truck = g.addTruck(0);
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }, { location: consumer.id, action: 'unload' }] });
    runFor(g, 2);
    // Make the consumer want nothing for a long time.
    const c = g.location(consumer.id)!;
    runFor(g, 0.1);
    c.demand = 0;
    c.nextCycleAt = 1e9;
    runFor(g, 200);
    const t = g.trucks.trucks[0];
    expect(t.cargo).not.toBeNull();
    expect(t.state).toBe('queued');
    expect(t.at).toBe(consumer.id);
  });

  it('a loaded truck skips load stops and heads for a consumer that takes its good', () => {
    const { g, producer, consumer } = setup();
    const truck = g.addTruck(0);
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }] });
    runFor(g, 200);
    expect(g.trucks.trucks[0].cargo).not.toBeNull();
    // Only a load stop and it's carrying: nothing useful to do.
    expect(g.trucks.trucks[0].state).toBe('idle');
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }, { location: consumer.id, action: 'unload' }] });
    runFor(g, 0.2);
    expect(g.trucks.trucks[0].orderIndex).toBe(1);
    runFor(g, 200);
    expect(events(g, 'delivered').length).toBeGreaterThanOrEqual(1);
  });

  it('new orders given mid-street take effect at the next intersection', () => {
    const { g, producer, consumer } = setup();
    const truck = g.addTruck(0);
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }] });
    runFor(g, 1);
    const t = g.trucks.trucks[0];
    expect(t.progress).toBeGreaterThan(0);
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: consumer.id, action: 'unload' }, { location: producer.id, action: 'load' }] });
    g.step();
    expect(t.pendingOrders).not.toBeNull();
    runFor(g, 10);
    expect(t.pendingOrders).toBeNull();
    expect(t.orders[0].location).toBe(consumer.id);
  });

  it('delivered pallets make producers and consumers grow', () => {
    const { g, producer, consumer } = setup();
    for (let i = 0; i < 4; i++) {
      const t = g.addTruck(0);
      g.act(0, { type: 'setOrders', truck: t.id, stops: [{ location: producer.id, action: 'load' }, { location: consumer.id, action: 'unload' }] });
    }
    runFor(g, 600);
    expect(g.location(producer.id)!.growth).toBeGreaterThan(g.cfg.cycles.growthRange[0]);
  });

  it('stays deterministic with trucks running', () => {
    const run = () => {
      const { g, producer, consumer } = setup();
      for (let i = 0; i < 3; i++) {
        const t = g.addTruck(0);
        g.act(0, { type: 'setOrders', truck: t.id, stops: [{ location: producer.id, action: 'load' }, { location: consumer.id, action: 'unload' }] });
      }
      runFor(g, 300);
      return g.stateHash();
    };
    expect(run()).toEqual(run());
  });

  it('reports truck positions in observations', () => {
    const { g, depot, producer } = setup();
    const truck = g.addTruck(0);
    expect(g.observe(0).trucks[0]).toMatchObject({ x: depot.x, y: depot.y });
    g.act(0, { type: 'setOrders', truck: truck.id, stops: [{ location: producer.id, action: 'load' }] });
    runFor(g, 3);
    const o = g.observe(0).trucks[0];
    expect(Math.hypot(o.x - depot.x, o.y - depot.y)).toBeGreaterThan(0.3);
  });
});
