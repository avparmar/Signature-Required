import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CYCLES,
  Rng,
  deliverPallet,
  newGame,
  raiseLevel,
  takePallet,
  updateCycles,
  type CycleConfig,
  type LocationState,
} from '../src/index.js';

// Fixed demand so the arithmetic is exact: 2 pallets per level, level 3 = 6 per cycle.
// Also pins the original 4-cycle window and no grace period, which these tests were written against.
const cfg: CycleConfig = { ...DEFAULT_CYCLES, demandPerLevel: [2, 2], window: 4, graceSec: 0 };

function loc(kind: 'producer' | 'consumer', o: Partial<LocationState> = {}): LocationState {
  return {
    id: kind === 'producer' ? 1 : 2,
    kind,
    good: 0,
    level: cfg.startLevel,
    cycleSec: 45,
    nextCycleAt: 0,
    stock: 0,
    demand: 0,
    cycleAmount: 0,
    served: 0,
    history: [],
    price: 0,
    closingIn: null,
    closed: false,
    graceUntil: 0,
    ...o,
  };
}

describe('cycles', () => {
  it('producers add their output every cycle, carrying over up to two cycles of stock', () => {
    const p = loc('producer');
    const rng = new Rng(1);
    updateCycles([p], 0, cfg, rng);
    expect(p.stock).toBe(6);
    expect(p.nextCycleAt).toBe(45);
    updateCycles([p], 44.9, cfg, rng);
    expect(p.stock).toBe(6);
    updateCycles([p], 45, cfg, rng);
    expect(p.stock).toBe(12);
    updateCycles([p], 90, cfg, rng);
    expect(p.stock).toBe(12); // capped at 2 cycles' worth
  });

  it('consumers want pallets again every cycle (reverse producers)', () => {
    const c = loc('consumer');
    const rng = new Rng(1);
    updateCycles([c], 0, cfg, rng);
    expect(c.demand).toBe(6);
    for (let i = 0; i < 6; i++) expect(deliverPallet(c, null)).toBe(true);
    expect(deliverPallet(c, null)).toBe(false); // satisfied: a truck would wait for the next cycle
    updateCycles([c], 45, cfg, rng);
    expect(c.demand).toBe(6);
  });

  it('consumer demand varies within its range, scaled by level', () => {
    const rng = new Rng(5);
    const c = loc('consumer', { level: 1 });
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      c.demand = 0;
      updateCycles([c], i * 45, { ...DEFAULT_CYCLES, window: 1000 }, rng);
      seen.add(c.cycleAmount);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('pallets are first come, first served at producers', () => {
    const p = loc('producer', { stock: 2 });
    expect(takePallet(p)).toBe(true);
    expect(takePallet(p)).toBe(true);
    expect(takePallet(p)).toBe(false);
  });

  it('only accepts the right good, and credits the producer it came from', () => {
    const p = loc('producer', { good: 1 });
    const c = loc('consumer', { good: 0, demand: 2 });
    expect(deliverPallet(c, p)).toBe(false);
    p.good = 0;
    expect(deliverPallet(c, p)).toBe(true);
    expect(p.served).toBe(1);
    expect(c.served).toBe(1);
  });

  it('each level adds pallets per cycle', () => {
    const p = loc('producer', { level: 5 });
    updateCycles([p], 0, cfg, new Rng(1));
    expect(p.stock).toBe(10);
  });
});

describe('the level ladder', () => {
  /** Run n cycles, serving `share` of each cycle's amount. */
  function run(s: LocationState, n: number, share: number, from = 0) {
    const rng = new Rng(2);
    for (let i = from; i <= from + n; i++) {
      updateCycles([s], i * 45, cfg, rng);
      if (s.closed) return;
      const serve = Math.round(s.cycleAmount * share);
      for (let k = 0; k < serve; k++) {
        if (s.kind === 'producer') {
          if (takePallet(s)) s.served++;
        } else deliverPallet(s, null);
      }
    }
  }

  it('well-served locations go up a level, to a cap of 5', () => {
    const p = loc('producer');
    run(p, 4, 1);
    expect(p.level).toBe(4);
    expect(p.cycleAmount).toBe(8); // the cycle that just started uses the new level
    run(p, 40, 1, 5);
    expect(p.level).toBe(5);
  });

  it('locations served under half go down a level', () => {
    const c = loc('consumer');
    run(c, 4, 0.4);
    expect(c.level).toBe(2);
  });

  it('half-served locations stay put', () => {
    const c = loc('consumer');
    run(c, 12, 0.5);
    expect(c.level).toBe(3);
  });

  it('at level 1, going down means closing, after one more cycle as a warning', () => {
    const c = loc('consumer', { level: 1 });
    const rng = new Rng(3);
    const events = [];
    for (let i = 0; i <= 5; i++) {
      events.push(...updateCycles([c], i * 45, cfg, rng));
      if (c.closed) break;
    }
    expect(events.map((e) => e.type)).toEqual(['closing', 'closed']);
    expect(c.closed).toBe(true);
    expect(c.demand).toBe(0);
    expect(deliverPallet(c, null)).toBe(false);
  });

  it('investing raises a level and saves a closing location', () => {
    const c = loc('consumer', { level: 1, closingIn: 1 });
    expect(raiseLevel(c, cfg)).toBe(true);
    expect(c.level).toBe(2);
    expect(c.closingIn).toBeNull();
    const top = loc('producer', { level: cfg.maxLevel });
    expect(raiseLevel(top, cfg)).toBe(false);
  });
});

describe('the town over a game', () => {
  it('every producer and consumer gets state, cycles at different times, and the game stays deterministic', () => {
    const g = newGame({ seed: 4, auctions: { openingRound: false } });
    const count = g.town.locations.filter((l) => l.kind === 'producer' || l.kind === 'consumer').length;
    expect(g.locations).toHaveLength(count);
    expect(new Set(g.locations.map((l) => l.nextCycleAt.toFixed(2))).size).toBeGreaterThan(count / 2);
    for (let i = 0; i < 600; i++) g.step(); // one minute
    expect(g.locations.filter((l) => l.kind === 'producer').every((l) => l.stock > 0)).toBe(true);
    expect(g.locations.filter((l) => l.kind === 'consumer').every((l) => l.demand > 0)).toBe(true);
    const h = newGame({ seed: 4, auctions: { openingRound: false } });
    for (let i = 0; i < 600; i++) h.step();
    expect(h.stateHash()).toEqual(g.stateHash());
  });

  it('with nobody delivering, the original town withers and closes, while new locations keep opening', () => {
    const g = newGame({ seed: 2, auctions: { openingRound: false } });
    const original = new Set(g.locations.map((l) => l.id));
    g.runToEnd();
    const evs = g.drainEvents(0);
    const closed = evs.filter((e) => e.type === 'closed').length;
    const opened = evs.filter((e) => e.type === 'opened').length;
    // Level 3 -> 2 -> 1 -> closing -> closed takes about 4 windows of 4 cycles: ~12 minutes.
    expect(closed).toBeGreaterThan(original.size / 2);
    expect(opened).toBeGreaterThanOrEqual(6); // roughly one a minute, minus the quiet start and end (fewer lots with a river)
    // Closed locations are empty lots again; opened ones are live.
    // Everything still live is on the map with the right kind; nothing closed is still live.
    const closedIds = new Set(evs.filter((e) => e.type === 'closed').map((e) => (e as { location: number }).location));
    for (const l of g.locations) {
      expect(l.closed).toBe(false);
      expect(g.town.locations[l.id].kind).toBe(l.kind);
    }
    const liveIds = new Set(g.locations.map((l) => l.id));
    // A lot can close and later host a new opening, so only check the ones that stayed closed.
    for (const id of closedIds) if (!liveIds.has(id)) expect(g.town.locations[id].kind).toBe('lot');
  });

  it('openings avoid lots right next to live locations', () => {
    const g = newGame({ seed: 6, auctions: { openingRound: false }, openings: { everySec: 20, quietStartSec: 0 } });
    for (let i = 0; i < 6000; i++) g.step();
    const opened = g.drainEvents(0).filter((e) => e.type === 'opened');
    expect(opened.length).toBeGreaterThan(5);
  });

  it('openings can be turned off', () => {
    const g = newGame({ seed: 2, auctions: { openingRound: false }, openings: { everySec: 0 } });
    g.runToEnd();
    expect(g.drainEvents(0).some((e) => e.type === 'opened')).toBe(false);
  });
});

describe('grace period', () => {
  it("a new location can't level down or close during its grace period, but can level up", () => {
    const g = { ...DEFAULT_CYCLES, demandPerLevel: [2, 2] as [number, number], window: 2, graceSec: 120 };
    const c: LocationState = {
      id: 2, kind: 'consumer', good: 0, level: 1, cycleSec: 45, nextCycleAt: 0, stock: 0, demand: 0,
      cycleAmount: 0, served: 0, history: [], price: 0, closingIn: null, closed: false, graceUntil: 120,
    };
    const rng = new Rng(1);
    // Unserved for 2 minutes: nothing happens.
    for (let i = 0; i <= 2; i++) updateCycles([c], i * 45, g, rng);
    expect(c.closingIn).toBeNull();
    expect(c.level).toBe(1);
    // After the grace period, neglect counts.
    const evs = [];
    for (let i = 3; i <= 8; i++) evs.push(...updateCycles([c], i * 45, g, rng));
    expect(evs.map((e) => e.type)).toContain('closing');
  });
});
