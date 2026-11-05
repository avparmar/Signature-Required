import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CYCLES,
  Rng,
  deliverPallet,
  newGame,
  takePallet,
  updateCycles,
  type CycleConfig,
  type LocationState,
} from '../src/index.js';

// These tests check the arithmetic, so they pin the original numbers (3 pallets made, 3 wanted).
const cfg: CycleConfig = { ...DEFAULT_CYCLES, produceBase: 3, demandBase: [3, 3] };

function loc(kind: 'producer' | 'consumer', o: Partial<LocationState> = {}): LocationState {
  return {
    id: kind === 'producer' ? 1 : 2,
    kind,
    good: 0,
    level: 1,
    growth: 0,
    cycleSec: 45,
    nextCycleAt: 0,
    stock: 0,
    demand: 0,
    cycleAmount: 0,
    served: 0,
    history: [],
    price: 0,
    ...o,
  };
}

describe('cycles', () => {
  it('producers add their output every cycle, carrying over up to two cycles of stock', () => {
    const p = loc('producer');
    const rng = new Rng(1);
    updateCycles([p], 0, cfg, rng);
    expect(p.stock).toBe(3);
    expect(p.nextCycleAt).toBe(45);
    updateCycles([p], 44.9, cfg, rng);
    expect(p.stock).toBe(3);
    updateCycles([p], 45, cfg, rng);
    expect(p.stock).toBe(6);
    updateCycles([p], 90, cfg, rng);
    expect(p.stock).toBe(6); // capped at 2 cycles' worth
  });

  it('consumers want pallets again every cycle (reverse producers)', () => {
    const c = loc('consumer');
    const rng = new Rng(1);
    updateCycles([c], 0, cfg, rng);
    expect(c.demand).toBe(3);
    for (let i = 0; i < 3; i++) expect(deliverPallet(c, null)).toBe(true);
    expect(deliverPallet(c, null)).toBe(false); // satisfied: a truck would wait for the next cycle
    updateCycles([c], 45, cfg, rng);
    expect(c.demand).toBe(3);
  });

  it('consumer demand varies within its range', () => {
    const rng = new Rng(5);
    const c = loc('consumer');
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      c.demand = 0;
      updateCycles([c], i * 45, { ...DEFAULT_CYCLES, demandBase: [2, 4], growthWindow: 1000 }, rng);
      seen.add(c.cycleAmount);
    }
    expect([...seen].sort()).toEqual([2, 3, 4]);
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

  it('levels add pallets per cycle', () => {
    const p = loc('producer', { level: 3 });
    updateCycles([p], 0, cfg, new Rng(1));
    expect(p.stock).toBe(5);
  });
});

describe('growth', () => {
  /** Run n cycles, serving `share` of each cycle's amount. */
  function run(s: LocationState, n: number, share: number) {
    const rng = new Rng(2);
    const p = s.kind === 'producer' ? s : null;
    for (let i = 0; i <= n; i++) {
      updateCycles([s], i * 45, cfg, rng);
      const serve = Math.round(s.cycleAmount * share);
      for (let k = 0; k < serve; k++) {
        if (p) {
          if (takePallet(p)) p.served++;
        } else deliverPallet(s, null);
      }
    }
  }

  it('well-served producers grow', () => {
    const p = loc('producer');
    run(p, 4, 1);
    expect(p.growth).toBe(1);
    expect(p.cycleAmount).toBe(4); // the cycle that just started already uses the new rate
    run(p, 8, 1);
    expect(p.growth).toBeGreaterThanOrEqual(2);
  });

  it('neglected locations shrink, but never below one pallet per cycle', () => {
    const c = loc('consumer');
    run(c, 40, 0);
    expect(c.growth).toBe(cfg.growthRange[0]);
    updateCycles([c], 41 * 45, cfg, new Rng(3));
    expect(c.cycleAmount).toBeGreaterThanOrEqual(1);
  });

  it('half-served locations stay put', () => {
    const c = loc('consumer', { growth: 0 });
    const rng = new Rng(4);
    for (let i = 0; i <= 12; i++) {
      updateCycles([c], i * 45, { ...cfg, demandBase: [4, 4] }, rng);
      deliverPallet(c, null);
      deliverPallet(c, null);
      c.demand = 0;
    }
    expect(c.growth).toBe(0);
  });

  it('growth is capped', () => {
    const p = loc('producer');
    run(p, 200, 1);
    expect(p.growth).toBe(cfg.growthRange[1]);
  });
});

describe('cycles in the game', () => {
  it('every producer and consumer gets state, cycles at different times, and the game stays deterministic', () => {
    const g = newGame({ seed: 4, auctions: { openingRound: false } });
    const count = g.town.locations.filter((l) => l.kind !== 'depot').length;
    expect(g.locations).toHaveLength(count);
    expect(new Set(g.locations.map((l) => l.nextCycleAt.toFixed(2))).size).toBeGreaterThan(count / 2);
    for (let i = 0; i < 600; i++) g.step(); // one minute
    expect(g.locations.filter((l) => l.kind === 'producer').every((l) => l.stock > 0)).toBe(true);
    expect(g.locations.filter((l) => l.kind === 'consumer').every((l) => l.demand > 0)).toBe(true);
    const h = newGame({ seed: 4, auctions: { openingRound: false } });
    for (let i = 0; i < 600; i++) h.step();
    expect(h.stateHash()).toEqual(g.stateHash());
  });

  it('with nobody delivering, the town shrinks over a full game', () => {
    const g = newGame({ seed: 2, auctions: { openingRound: false } });
    g.runToEnd();
    expect(g.locations.every((l) => l.growth === g.cfg.cycles.growthRange[0])).toBe(true);
    expect(g.drainEvents(0).some((e) => e.type === 'shrank')).toBe(true);
  });
});
