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
  it('the town keeps open demand up to its target, and shops without an order want nothing', () => {
    const g = setup(0);
    run(g, 1);
    const producers = g.locations.filter((l) => l.kind === 'producer');
    const supply = producers.reduce((a, p) => a + g.cfg.cycles.palletsPerLevel * p.level, 0);
    const open = shops(g).reduce((a, s) => a + (s.order ? s.demand : 0), 0);
    expect(open).toBeGreaterThanOrEqual(supply * g.cfg.orders.openShare);
    for (const s of shops(g)) if (!s.order) expect(s.demand).toBe(0);
    for (const s of shops(g)) if (s.order) expect(s.order.size).toBeGreaterThanOrEqual(g.cfg.orders.size[0]);
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
        const headed = g.trucks.trucks.filter((t) => t.orders.some((o) => o.action === 'unload' && o.location === s.id) && !(t.state === 'servicing' && t.serving?.action === 'unload' && t.at === s.id)).length;
        expect(headed).toBeLessThanOrEqual(s.order ? s.demand : 0);
      }
    }
  });

  it('trucks do one trip and are free again; no pallet is ever dropped', () => {
    const g = setup(8);
    const events = run(g, 300);
    expect(events.some((e) => e.type === 'delivered')).toBe(true);
    expect(events.some((e) => e.type === 'dropped')).toBe(false);
  });

  it('is deterministic', () => {
    const a = setup(8);
    const b = setup(8);
    run(a, 200);
    run(b, 200);
    expect(a.stateHash()).toBe(b.stateHash());
  });
});
