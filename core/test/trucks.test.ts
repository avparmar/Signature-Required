import { describe, expect, it } from 'vitest';
import { atGoal, distancesFrom, newGame, routeVia, shortestPath, spotS, type Game, type GameEvent } from '../src/index.js';

/** A game where player 0 is president of company 0 (no auctions yet, so set shares directly). */
function setup(o: Parameters<typeof newGame>[0] = {}) {
  const g = newGame({ seed: 7, autoRoutes: false, startingTrucks: 0, ...o, auctions: { openingRound: false, ...o.auctions } });
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

describe('trucks on routes', () => {
  /** Put n free trucks at company 0's depot on the producer -> consumer route. */
  function assign(g: Game, depot: number, producer: number, consumer: number, n = 1) {
    for (let i = 0; i < n; i++) {
      g.addTruck(0);
      g.act(0, { type: 'assignRoute', depot, producer, consumer });
    }
    g.step();
  }

  it('runs a load -> unload loop, delivering pallets that credit both ends', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id);
    runFor(g, 300);
    const delivered = events(g, 'delivered');
    expect(delivered.length).toBeGreaterThanOrEqual(2);
    for (const e of delivered) if (e.type === 'delivered') expect(e.origin).toBe(producer.id);
    expect(g.routes()).toEqual([{ key: `${depot.id}>${producer.id}>${consumer.id}`, company: 0, depot: depot.id, producer: producer.id, consumer: consumer.id, trucks: 1 }]);
  });

  it('drives at the configured speed', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id);
    const t = g.trucks.trucks[0];
    // Out on the road: a second covers `speed` blocks along its route.
    while (t.berth) g.step();
    const along = (x: typeof t) => {
      let d = -x.progress;
      let prev = x.node;
      for (const n of x.path) {
        d += Math.hypot(g.town.graph.nodes[n].x - g.town.graph.nodes[prev].x, g.town.graph.nodes[n].y - g.town.graph.nodes[prev].y);
        prev = n;
      }
      return d;
    };
    const before = along(t);
    runFor(g, 1);
    expect(before - along(t)).toBeCloseTo(g.cfg.trucks.speed, 5);
  });

  it('only presidents of the depot\'s company can assign, and the route must make sense', () => {
    const { g, depot, producer, consumer } = setup();
    g.addTruck(0);
    const otherGood = g.town.locations.find((l) => l.kind === 'consumer' && l.good !== producer.good)!;
    const otherDepot = g.town.locations.find((l) => l.startCompany === 1)!;
    g.act(1, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id }); // not president
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: consumer.id, consumer: producer.id }); // backwards
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: otherGood.id }); // wrong good
    g.act(0, { type: 'assignRoute', depot: otherDepot.id, producer: producer.id, consumer: consumer.id }); // someone else's depot
    g.step();
    expect(g.drainEvents(1).filter((e) => e.type === 'rejected')).toHaveLength(1);
    expect(g.drainEvents(0).filter((e) => e.type === 'rejected')).toHaveLength(3);
    expect(g.routes()).toHaveLength(0);
  });

  it('needs a free truck at that depot', () => {
    const { g, depot, producer, consumer } = setup();
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(g.drainEvents(0).filter((e) => e.type === 'rejected')).toHaveLength(1);
    assign(g, depot.id, producer.id, consumer.id, 2);
    expect(g.routes()[0].trucks).toBe(2);
  });

  it('unassigning sends a truck home, where it becomes free again', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id, 2);
    runFor(g, 20);
    g.act(0, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(g.routes()[0].trucks).toBe(1);
    const freed = g.trucks.trucks.find((t) => t.route === null)!;
    // It may still have a pallet to deliver first (no dumping); then it heads home.
    expect(freed.orders.every((o) => o.action === 'unload' || o.action === 'signOff')).toBe(true);
    runFor(g, 120);
    expect(freed.state).toBe('idle');
    expect(freed.node).toBe(depot.node);
    expect(freed.cargo).toBeNull();
    // ...and can be put straight back to work.
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(g.routes()[0].trucks).toBe(2);
    g.act(0, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.act(0, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.act(0, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(g.routes()).toHaveLength(0);
    expect(g.drainEvents(0).filter((e) => e.type === 'rejected')).toHaveLength(1); // nothing left to remove
  });

  it('a truck taken off its route with a raw pallet still has it processed before delivering it', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id, 1);
    const t = g.trucks.trucks.find((x) => x.route !== null)!;
    let delivered: boolean | null = null;
    for (let i = 0; i < 3000 && !(t.cargo && !t.cargo.processed && t.state === 'driving'); i++) g.step();
    expect(t.cargo?.processed).toBe(false);
    g.act(0, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(t.orders.map((o) => o.action)).toEqual(['signOff', 'unload']);
    for (let i = 0; i < 3000 && t.cargo; i++) {
      if (t.state === 'servicing' && t.cargo) delivered = t.cargo.processed;
      g.step();
    }
    expect(delivered).toBe(true);
  });

  it("a truck off its route whose shop has closed leaves its pallet and is free again", () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id, 1);
    const t = g.trucks.trucks.find((x) => x.route !== null)!;
    for (let i = 0; i < 3000 && !(t.cargo && t.state === 'driving'); i++) g.step();
    expect(t.cargo).not.toBeNull();
    g.act(0, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    g.trucks.locationClosed(consumer.id, g.t); // its shop closes before it gets there
    g.drainEvents(0);
    for (let i = 0; i < 3000 && t.state !== 'idle'; i++) g.step();
    expect(t.cargo).toBeNull();
    expect(t.orders).toEqual([]);
    expect(t.node).toBe(depot.node); // back home, free
  });

  it('a tie keeps the president: the other holder can\'t direct the trucks', () => {
    const { g, depot, producer, consumer } = setup();
    expect(g.presidents(0)).toEqual([0]);
    g.companies[0].shares = [0, 1, null, null, null];
    g.addTruck(0);
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.act(1, { type: 'unassignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(g.routes()).toHaveLength(1);
    expect(g.drainEvents(1).filter((e) => e.type === 'rejected')).toHaveLength(1);
  });

  it('queues at a building: two bays, first come first served, waiting trucks keep their place', () => {
    const { g, depot, producer, consumer } = setup({ cycles: { palletsPerLevel: 1, startLevel: 1, cycleSec: [60, 60] } });
    // Stagger departures so arrival order is known.
    for (let i = 0; i < 4; i++) {
      assign(g, depot.id, producer.id, consumer.id);
      runFor(g, 0.5);
    }
    runFor(g, 200);
    const loaded = events(g, 'loaded').map((e) => (e.type === 'loaded' ? e.truck : -1));
    // One pallet per cycle at this producer, so trucks load one at a time, in arrival order.
    expect(loaded.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('takes turns between companies at a busy building, however many trucks each has there', () => {
    const { g, depot, producer, consumer } = setup({ cycles: { palletsPerLevel: 1, startLevel: 1, cycleSec: [30, 30] } });
    g.companies[1].shares = [1, null, null, null, null];
    const rival = g.town.locations.find((l) => l.startCompany === 1)!;
    assign(g, depot.id, producer.id, consumer.id, 4);
    for (let i = 0; i < 2; i++) {
      g.addTruck(1);
      g.act(1, { type: 'assignRoute', depot: rival.id, producer: producer.id, consumer: consumer.id });
    }
    g.drainEvents(0);
    let last = -1;
    let checked = 0;
    let loading = new Set<number>();
    for (let i = 0; i < 9000; i++) {
      // Waiting at a bay, stopped there, ready to load.
      const atBay = (t: (typeof g.trucks.trucks)[number]) => {
        const line = t.berth && g.trucks.line(t.node, t.berth.kerb);
        return !!line && t.berth!.spot < producer.bays && atGoal(t.berth!, { s: spotS(line, t.berth!.spot, g.cfg.trucks), side: 'near' });
      };
      const waiting = new Set(g.trucks.trucks.filter((t) => t.state === 'queued' && t.at === producer.id && atBay(t)).map((t) => t.company));
      g.step();
      // Whose turn it was: the trucks that started loading at the producer this step.
      const now = new Set(g.trucks.trucks.filter((t) => t.state === 'servicing' && t.at === producer.id).map((t) => t.id));
      const started = [...now].filter((id) => !loading.has(id)).map((id) => g.trucks.trucks[id].company);
      if (started.length === 1) {
        // A company never loads twice running while the other company had a truck waiting.
        if (started[0] === last) expect(waiting.has(1 - started[0])).toBe(false);
        if (waiting.size === 2) checked++;
        last = started[0];
      } else if (started.length === 2) {
        // Both bays at once: one each, if both had trucks waiting.
        if (waiting.size === 2) {
          expect(new Set(started).size).toBe(2);
          checked++;
        }
        last = -1;
      }
      loading = now;
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('never has more trucks loading than the building has bays', () => {
    const { g, depot, producer, consumer } = setup({ trucks: { serviceSec: 20 } });
    assign(g, depot.id, producer.id, consumer.id, 5);
    let maxBusy = 0;
    for (let i = 0; i < 3000; i++) {
      g.step();
      const busy = g.trucks.trucks.filter((t) => t.state === 'servicing' && t.at === producer.id).length;
      maxBusy = Math.max(maxBusy, busy);
    }
    expect(maxBusy).toBe(producer.bays);
  });

  it('waits at a satisfied consumer instead of dumping', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id);
    runFor(g, 2);
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

  it('when a route\'s consumer closes, its trucks go home and the route is gone', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id, 2);
    runFor(g, 30);
    // Force the consumer to close now.
    const c = g.location(consumer.id)!;
    c.level = 1;
    c.closingIn = 1;
    c.nextCycleAt = g.t;
    g.step();
    const lost = events(g, 'routeLost');
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ company: 0, depot: depot.id, consumer: consumer.id, trucks: 2 });
    expect(g.routes()).toHaveLength(0);
    expect(g.town.locations[consumer.id].kind).toBe('lot');
    runFor(g, 200);
    for (const t of g.trucks.trucks) {
      expect(t.state).toBe('idle');
      expect(t.node).toBe(depot.node);
    }
  });

  it('delivered pallets keep producers and consumers at or above their level', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id, 4);
    runFor(g, 600);
    expect(g.location(producer.id)!.level).toBeGreaterThanOrEqual(g.cfg.cycles.startLevel);
  });

  it('stays deterministic with trucks running', () => {
    const run = () => {
      const { g, depot, producer, consumer } = setup();
      assign(g, depot.id, producer.id, consumer.id, 3);
      runFor(g, 300);
      return g.stateHash();
    };
    expect(run()).toEqual(run());
  });

  it('reports truck positions and routes in observations', () => {
    const { g, depot, producer, consumer } = setup();
    g.addTruck(0);
    const start = g.observe(0).trucks[0];
    expect(start).toMatchObject({ route: null });
    expect(Math.hypot(start.x - depot.x, start.y - depot.y)).toBeLessThan(1); // parked outside its depot
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    runFor(g, 3);
    const o = g.observe(0);
    expect(Math.hypot(o.trucks[0].x - start.x, o.trucks[0].y - start.y)).toBeGreaterThan(0.3);
    expect(o.routes).toHaveLength(1);
    expect(o.trucks[0].route).toBe(o.routes[0].key);
  });
});

describe('routes through the depot', () => {
  for (const via of ['loaded', 'hub'] as const) {
    it(`${via}: every load is signed off at the depot before it's delivered`, () => {
      const { g, depot, producer, consumer } = setup({ trucks: { viaDepot: via }, town: { blocksX: 16, blocksY: 16 } });
      g.addTruck(0);
      g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
      runFor(g, 300);
      const ev = g.drainEvents(0).filter((e) => e.type === 'loaded' || e.type === 'signedOff' || e.type === 'delivered');
      expect(ev.filter((e) => e.type === 'delivered').length).toBeGreaterThan(1);
      // Between each load and its delivery there is a loaded sign-off at the route's depot.
      let state: 'empty' | 'loaded' | 'signed' = 'empty';
      for (const e of ev) {
        if (e.type === 'loaded') state = 'loaded';
        if (e.type === 'signedOff' && e.loaded) {
          expect(state).toBe('loaded');
          expect(e.depot).toBe(depot.id);
          state = 'signed';
        }
        if (e.type === 'delivered') {
          expect(state).toBe('signed');
          state = 'empty';
        }
      }
      // The hub also signs off empty trucks on their way back.
      const empty = ev.filter((e) => e.type === 'signedOff' && !e.loaded).length;
      if (via === 'hub') expect(empty).toBeGreaterThan(0);
      else expect(empty).toBe(0);
    });
  }
});

describe('lines at buildings', () => {
  function assign(g: Game, depot: number, producer: number, consumer: number, n = 1) {
    for (let i = 0; i < n; i++) {
      g.addTruck(0);
      g.act(0, { type: 'assignRoute', depot, producer, consumer });
    }
    g.step();
  }

  it('the first truck drives past the driveway to the far bay, so the next can use the near one', () => {
    const { g, depot, producer, consumer } = setup({ trucks: { serviceSec: 30 } });
    assign(g, depot.id, producer.id, consumer.id, 2);
    for (let i = 0; i < 3000 && g.trucks.trucks.filter((t) => t.state === 'servicing').length < 2; i++) g.step();
    const serving = g.trucks.trucks.filter((t) => t.state === 'servicing' && t.at === producer.id);
    expect(serving).toHaveLength(2);
    // Same street, either side of the driveway: bay 0 past it, bay 1 before it.
    const [a, b] = serving.map((t) => t.berth!).sort((x, y) => x.spot - y.spot);
    expect(a.kerb).toBe(b.kerb);
    expect([a.spot, b.spot]).toEqual([0, 1]);
    expect(a.s).toBeLessThan(0);
    expect(b.s).toBeGreaterThan(0);
    expect(b.s - a.s).toBeCloseTo(g.cfg.trucks.spacing, 6);
  });

  it('is only served once stopped at a bay, and others wait behind', () => {
    const { g, depot, producer, consumer } = setup({ trucks: { serviceSec: 30 } });
    assign(g, depot.id, producer.id, consumer.id, 4);
    for (let i = 0; i < 4000; i++) {
      g.step();
      for (const t of g.trucks.trucks) {
        if (t.state !== 'servicing' || !t.berth) continue;
        const line = g.trucks.line(t.node, t.berth.kerb)!;
        expect(t.berth.spot).toBeLessThan(2);
        expect(atGoal(t.berth, { s: spotS(line, t.berth.spot, g.cfg.trucks), side: 'near' })).toBe(true);
      }
    }
  });

  it('never drives through a building: off the road only in a line, and pulls out forwards to the next junction', () => {
    const { g, depot, producer, consumer } = setup();
    assign(g, depot.id, producer.id, consumer.id, 3);
    let pulledOut = 0;
    const was = new Map<number, boolean>();
    for (let i = 0; i < 4000; i++) {
      g.step();
      for (const t of g.trucks.trucks) {
        if (!t.berth) expect(g.town.graph.terminal[t.node]).toBe(false);
        if (was.get(t.id) && !t.berth) {
          pulledOut++;
          // Back on the street it waited on, heading on downstream.
          expect(t.state).toBe('driving');
          expect(t.progress).toBeGreaterThan(0);
        }
        was.set(t.id, t.berth !== null);
      }
    }
    expect(pulledOut).toBeGreaterThan(3);
  });
});

