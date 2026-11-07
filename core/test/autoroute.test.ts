import { describe, expect, it } from 'vitest';
import { newGame, type Game } from '../src/index.js';

/** A running game where player 0 runs company 0, which has `trucks` trucks. */
function setup(trucks = 4) {
  const g = newGame({ seed: 7, auctions: { openingRound: false } });
  g.companies[0].shares = [0, null, null, null, null];
  for (let i = 0; i < trucks; i++) g.addTruck(0);
  return g;
}

function runFor(g: Game, sec: number) {
  const n = Math.round(sec / g.cfg.tickSec);
  for (let i = 0; i < n && !g.done; i++) g.step();
}

const consumerOf = (g: Game, route: string) => Number(route.split('>')[2]);
const rejected = (g: Game, p = 0) => g.drainEvents(p).filter((e) => e.type === 'rejected');

describe('automatic routes', () => {
  it('companies put their own trucks to work, and they deliver', () => {
    const g = setup();
    runFor(g, 2);
    const mine = g.trucks.trucks.filter((t) => t.company === 0);
    expect(mine.every((t) => t.route !== null)).toBe(true);
    let delivered = 0;
    for (let i = 0; i < 1200; i++) {
      g.step();
      delivered += g.drainEvents(0).filter((e) => e.type === 'delivered').length;
    }
    expect(delivered).toBeGreaterThan(0);
  });

  it('every company starts with a truck at its starting factory', () => {
    const g = newGame({ seed: 7 });
    for (const c of g.companies) expect(g.trucks.trucks.filter((t) => t.company === c.id)).toHaveLength(g.cfg.startingTrucks);
    expect(g.cfg.startingTrucks).toBe(1);
  });

  it('routes by hand are refused', () => {
    const g = setup(1);
    const depot = g.town.locations.find((l) => l.startCompany === 0)!;
    const producer = g.town.locations.find((l) => l.kind === 'producer')!;
    const consumer = g.town.locations.find((l) => l.kind === 'consumer' && l.good === producer.good)!;
    g.act(0, { type: 'assignRoute', depot: depot.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(rejected(g)).toHaveLength(1);
  });

  it('only delivers to shops in its area, and trucks whose shop leaves the area come free', () => {
    const g = setup(6);
    runFor(g, 2);
    // The area: the blocks of the shops it serves now, less one of them.
    const shops = [...new Set(g.trucks.trucks.filter((t) => t.company === 0 && t.route).map((t) => consumerOf(g, t.route!)))];
    expect(shops.length).toBeGreaterThan(0);
    const dropped = shops[0];
    const keep = shops.slice(1).map((s) => g.blockOf(s));
    const area = keep.length ? keep : [g.blockOf(g.town.locations.find((l) => l.kind === 'consumer' && l.id !== dropped)!.id)];
    g.act(0, { type: 'setArea', company: 0, blocks: area.filter((b) => b !== g.blockOf(dropped)) });
    runFor(g, 60);
    for (const t of g.trucks.trucks.filter((x) => x.company === 0 && x.route && !x.homing)) {
      expect(g.serves(0, consumerOf(g, t.route!))).toBe(true);
      expect(consumerOf(g, t.route!)).not.toBe(dropped);
    }
  });

  it('focus: sends a truck to a focused place, at most a few of them, presidents only', () => {
    const g = setup(4);
    runFor(g, 2);
    const served = new Set(g.trucks.trucks.filter((t) => t.company === 0 && t.route).map((t) => consumerOf(g, t.route!)));
    const depot = g.town.locations.find((l) => l.startCompany === 0)!;
    // A shop it isn't serving, as near its factory as possible.
    const target = g.town.locations
      .filter((l) => l.kind === 'consumer' && !served.has(l.id))
      .sort((a, b) => Math.hypot(a.x - depot.x, a.y - depot.y) - Math.hypot(b.x - depot.x, b.y - depot.y))[0];
    g.act(1, { type: 'setFocus', company: 0, location: target.id, on: true });
    g.act(0, { type: 'setFocus', company: 0, location: target.id, on: true });
    g.step();
    expect(rejected(g, 1)).toHaveLength(1);
    expect(g.companies[0].focus).toEqual([target.id]);
    runFor(g, 90);
    expect(g.trucks.trucks.some((t) => t.company === 0 && t.route && consumerOf(g, t.route) === target.id)).toBe(true);
    const others = g.town.locations.filter((l) => l.kind === 'consumer' && l.id !== target.id).slice(0, g.cfg.maxFocus);
    for (const o of others) g.act(0, { type: 'setFocus', company: 0, location: o.id, on: true });
    g.step();
    expect(g.companies[0].focus).toHaveLength(g.cfg.maxFocus);
    expect(rejected(g)).toHaveLength(1);
  });

  it('only a president sets the area, and it must be blocks in town', () => {
    const g = setup(0);
    g.act(1, { type: 'setArea', company: 0, blocks: [0] });
    g.act(0, { type: 'setArea', company: 0, blocks: [-1] });
    g.act(0, { type: 'setArea', company: 0, blocks: [5, 3, 5] });
    g.step();
    expect(rejected(g, 1)).toHaveLength(1);
    expect(rejected(g, 0)).toHaveLength(1);
    expect(g.companies[0].area).toEqual([3, 5]);
  });
});
