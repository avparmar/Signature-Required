/**
 * Producer and consumer cycles, and growth.
 *
 * Producers make pallets every cycle; trucks take them first come, first served.
 * Consumers are "reverse producers": every cycle they want the same good again, in varying
 * quantities, and trucks fill that demand first come, first served.
 * Locations grow or shrink with how well they're served, judged on pallets that actually
 * reach a consumer (so dumping goods can't fake it).
 */
import type { Rng } from './rng.js';
import type { Location } from './town.js';

export interface CycleConfig {
  /** Cycle length range in seconds; each location gets its own length and a random phase. */
  cycleSec: [number, number];
  /** Pallets a level-1 producer makes per cycle (before growth). */
  produceBase: number;
  /** Pallets a level-1 consumer wants per cycle (before growth): a random amount in this range. */
  demandBase: [number, number];
  /** Extra pallets per cycle for each level above 1 (location investment). */
  levelStep: number;
  /** Unsold stock / unfilled demand carries over, up to this many cycles' worth. */
  carryCycles: number;
  /** How many recent cycles growth looks at. */
  growthWindow: number;
  /** Served share at or above this over the window: grow one step. */
  growAbove: number;
  /** Served share at or below this over the window: shrink one step. */
  shrinkBelow: number;
  /** Growth steps allowed below / above the base. Each step is ±1 pallet per cycle. */
  growthRange: [number, number];
}

export const DEFAULT_CYCLES: CycleConfig = {
  cycleSec: [45, 45],
  produceBase: 3,
  demandBase: [2, 4],
  levelStep: 1,
  carryCycles: 2,
  growthWindow: 4,
  growAbove: 0.75,
  shrinkBelow: 0.25,
  growthRange: [-2, 3],
};

/** Dynamic state of a producer or consumer. */
export interface LocationState {
  id: number;
  kind: 'producer' | 'consumer';
  good: number;
  level: number;
  /** Growth steps from the base (negative = shrunk). */
  growth: number;
  cycleSec: number;
  /** Game time of the next cycle. */
  nextCycleAt: number;
  /** Producers: pallets waiting to be picked up. */
  stock: number;
  /** Consumers: pallets still wanted. */
  demand: number;
  /** What this cycle made available (producers) or asked for (consumers). */
  cycleAmount: number;
  /** Pallets from this location's current cycle that reached a consumer (producers) / were received (consumers). */
  served: number;
  /** Served share of recent cycles, newest last. */
  history: number[];
  /** Consumers: what they pay per pallet (set by the money rules; 0 for producers). */
  price: number;
}

export type CycleEvent =
  | { type: 'grew'; t: number; location: number; growth: number }
  | { type: 'shrank'; t: number; location: number; growth: number };

/** Pallets per cycle for a location at its current level and growth (never below 1). */
export function cycleRate(s: Pick<LocationState, 'kind' | 'level' | 'growth'>, cfg: CycleConfig, rng?: Rng): number {
  const base = s.kind === 'producer' ? cfg.produceBase : rng ? rng.int(...cfg.demandBase) : (cfg.demandBase[0] + cfg.demandBase[1]) / 2;
  return Math.max(1, Math.round(base + (s.level - 1) * cfg.levelStep + s.growth));
}

export function initLocations(locs: Location[], cfg: CycleConfig, rng: Rng): LocationState[] {
  return locs
    .filter((l) => l.kind !== 'depot')
    .map((l) => {
      const cycleSec = cfg.cycleSec[0] + rng.next() * (cfg.cycleSec[1] - cfg.cycleSec[0]);
      return {
        id: l.id,
        kind: l.kind as 'producer' | 'consumer',
        good: l.good!,
        level: l.level,
        growth: 0,
        cycleSec,
        // Random phase so the whole town doesn't tick at once; first cycle within one cycle length.
        nextCycleAt: rng.next() * cycleSec,
        stock: 0,
        demand: 0,
        cycleAmount: 0,
        served: 0,
        history: [],
        price: 0,
      };
    });
}

/** Run every cycle that's due at time t. Returns growth events. */
export function updateCycles(states: LocationState[], t: number, cfg: CycleConfig, rng: Rng): CycleEvent[] {
  const events: CycleEvent[] = [];
  for (const s of states) {
    while (t >= s.nextCycleAt - 1e-9) {
      const at = s.nextCycleAt;
      // Close out the cycle that just ended (skip the very first, which had nothing on offer).
      if (s.cycleAmount > 0) {
        s.history.push(Math.min(1, s.served / s.cycleAmount));
        if (s.history.length > cfg.growthWindow) s.history.shift();
        const e = applyGrowth(s, at, cfg);
        if (e) events.push(e);
      }
      const amount = cycleRate(s, cfg, rng);
      const cap = amount * cfg.carryCycles;
      if (s.kind === 'producer') s.stock = Math.min(cap, s.stock + amount);
      else s.demand = Math.min(cap, s.demand + amount);
      s.cycleAmount = amount;
      s.served = 0;
      s.nextCycleAt += s.cycleSec;
    }
  }
  return events;
}

function applyGrowth(s: LocationState, t: number, cfg: CycleConfig): CycleEvent | null {
  if (s.history.length < cfg.growthWindow) return null;
  const avg = s.history.reduce((a, b) => a + b, 0) / s.history.length;
  const [lo, hi] = cfg.growthRange;
  if (avg >= cfg.growAbove && s.growth < hi) {
    s.growth++;
    s.history = [];
    return { type: 'grew', t, location: s.id, growth: s.growth };
  }
  if (avg <= cfg.shrinkBelow && s.growth > lo) {
    s.growth--;
    s.history = [];
    return { type: 'shrank', t, location: s.id, growth: s.growth };
  }
  return null;
}

/** A truck picks up one pallet. False if the producer has none. */
export function takePallet(producer: LocationState): boolean {
  if (producer.kind !== 'producer' || producer.stock <= 0) return false;
  producer.stock--;
  return true;
}

/**
 * A truck drops one pallet of `good` (picked up at `origin`). False if this consumer doesn't
 * want it right now. Credits both the consumer and the producer it came from.
 */
export function deliverPallet(consumer: LocationState, origin: LocationState | null): boolean {
  if (consumer.kind !== 'consumer' || consumer.demand <= 0) return false;
  if (origin && origin.good !== consumer.good) return false;
  consumer.demand--;
  consumer.served++;
  if (origin) origin.served++;
  return true;
}
