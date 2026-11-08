import { describe, expect, it } from 'vitest';
import { newGame, type Game, type GameEvent } from '../src/index.js';

function setup(trucks = 6, o: Parameters<typeof newGame>[0] = {}) {
  const g = newGame({ seed: 7, startingTrucks: 0, ...o, auctions: { openingRound: false } });
  g.companies[0].shares = [0, null, null, null, null];
  for (let i = 0; i < trucks; i++) g.addTruck(0);
  return g;
}

function run(g: Game, sec: number) {
  const out: GameEvent[] = [];
  const n = Math.round(sec / g.cfg.tickSec);
  for (let i = 0; i < n && !g.done; i++) {
    g.step();
    out.push(...g.drainEvents(0));
  }
  return out;
}

const shops = (g: Game) => g.locations.filter((l) => l.kind === 'consumer' && !l.closed);

describe('shop orders', () => {
  it('the town keeps open demand in step with the fleet, and supply in step with demand', () => {
    const g = setup(0);
    run(g, 1);
    const goods = g.cfg.town.goods.length;
    const demand = new Array(goods).fill(0);
    for (const s of shops(g)) if (s.order) s.order.wants.forEach((w, k) => (demand[k] += w));
    const open = demand.reduce((a, b) => a + b, 0);
    expect(open).toBeGreaterThanOrEqual(Math.max(g.cfg.orders.minOpen, g.trucks.trucks.length * g.cfg.orders.openPerTruck));
    for (const s of shops(g)) if (!s.order) expect(s.demand).toBe(0);
    // Every order starts at tier 1: one good, its own.
    for (const s of shops(g)) if (s.order) expect(s.order.wants.filter((w) => w > 0)).toHaveLength(1);
    const producers = g.locations.filter((l) => l.kind === 'producer');
    for (let k = 0; k < goods; k++) {
      const supply = producers.filter((p) => p.good === k && p.order).reduce((a, p) => a + p.stock, 0);
      const free = producers.filter((p) => p.good === k && !p.order).length;
      if (free > 0) expect(supply).toBeGreaterThanOrEqual(demand[k] * g.cfg.orders.supplyShare);
    }
  });

  it('places grow a tier as they complete orders and lots; tier 3 shops order two goods', () => {
    const g = setup(24);
    const events = run(g, 600);
    const grew = events.filter((e) => e.type === 'grew') as Extract<GameEvent, { type: 'grew' }>[];
    expect(grew.length).toBeGreaterThan(0);
    expect(Math.max(...g.locations.map((l) => l.tier))).toBeGreaterThanOrEqual(2);
    const posted = events.filter((e) => e.type === 'orderPosted') as Extract<GameEvent, { type: 'orderPosted' }>[];
    for (const p of posted) {
      const tierThen = g.locations.find((l) => l.id === p.location)!.tier; // never shrinks, so at least
      if (p.wants.filter((w) => w > 0).length > 1) expect(tierThen).toBeGreaterThanOrEqual(3);
    }
  });

  it('a filled order pays its bonus to the companies that delivered, then the shop goes quiet', () => {
    const g = setup(10);
    const events = run(g, 400);
    const done = events.filter((e) => e.type === 'orderDone') as Extract<GameEvent, { type: 'orderDone' }>[];
    expect(done.length).toBeGreaterThan(0);
    for (const d of done) {
      expect(d.delivered.reduce((a, b) => a + b, 0)).toBe(d.size);
      expect(d.bonus.reduce((a, b) => a + b, 0)).toBeCloseTo(d.size * g.cfg.orders.bonusPerPallet);
    }
    const last = done[done.length - 1];
    const s = g.locations.find((l) => l.id === last.location)!;
    if (!s.order) expect(s.quietUntil).toBeGreaterThan(last.t);
  });

  it('never more trucks sent for a shop than its order still wants', () => {
    const g = setup(16);
    for (let k = 0; k < 120; k++) {
      run(g, 1);
      for (const s of shops(g)) {
        for (let k = 0; k < g.cfg.town.goods.length; k++) {
          const headed = g.trucks.trucks.filter((t) => {
            if (!t.orders.some((o) => o.action === 'unload' && o.location === s.id)) return false;
            if (t.state === 'servicing' && t.serving?.action === 'unload' && t.at === s.id) return false;
            const load = t.orders.find((o) => o.action === 'load');
            return (t.cargo?.good ?? (load ? g.town.locations[load.location].good : -1)) === k;
          }).length;
          expect(headed).toBeLessThanOrEqual(s.order ? s.order.wants[k] : 0);
        }
      }
    }
  });

  it('trucks do one trip and are free again; no pallet is ever dropped', () => {
    const g = setup(8);
    const events = run(g, 300);
    expect(events.some((e) => e.type === 'delivered')).toBe(true);
    expect(events.some((e) => e.type === 'dropped')).toBe(false);
  });

  it('a truck that has been sent keeps its trip: none turns back', () => {
    const g = setup(16);
    const sentFor = new Map<number, number>();
    for (let k = 0; k < 1500; k++) {
      g.step();
      // A truck that delivered this step may already be on its next trip.
      const delivered = new Set(g.peekEvents(0).filter((e) => e.type === 'delivered').map((e) => (e as { truck: number }).truck));
      for (const t of g.trucks.trucks) {
        const u = t.orders.find((o) => o.action === 'unload');
        if (u) {
          if (sentFor.has(t.id) && !delivered.has(t.id)) expect(sentFor.get(t.id)).toBe(u.location);
          sentFor.set(t.id, u.location);
        } else sentFor.delete(t.id);
      }
      g.drainEvents(0);
    }
  });

  it('plans only when something changes, not every second', () => {
    const g = setup(12);
    run(g, 300);
    expect(g.plans).toBeGreaterThan(0);
    expect(g.plans).toBeLessThan(300);
  });

  it('is deterministic', () => {
    const a = setup(8);
    const b = setup(8);
    run(a, 200);
    run(b, 200);
    expect(a.stateHash()).toBe(b.stateHash());
  });
});
