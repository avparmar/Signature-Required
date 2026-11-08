/**
 * Producer and consumer cycles, and the level ladder.
 *
 * Producers make pallets every cycle; trucks take them first come, first served.
 * Consumers are "reverse producers": every cycle they want the same good again, in varying
 * quantities, and trucks fill that demand first come, first served.
 *
 * Every location is just a level. It makes or wants a fixed amount per level. Over a window of
 * recent cycles, a location served below half its amount drops a level and one served three
 * quarters or more gains one. A level-1 location that would drop closes instead (after a short
 * "closing" warning). Served pallets are those that actually reach a consumer, so dumping goods
 * can't fake it. Location investment buys a level.
 */
import type { Rng } from './rng.js';
import type { Location } from './town.js';

export interface CycleConfig {
  /** Cycle length range in seconds; each location gets its own length and a random phase. */
  cycleSec: [number, number];
  /** Pallets per cycle, per level, that a producer makes. */
  palletsPerLevel: number;
  /** A shop wants this share of what a producer makes (0.5 with two shops per producer: supply = demand). */
  shopShare: number;
  /** Shops want more every cycle (true), or only through orders the game posts (false: see orders.ts). */
  shopCycles: boolean;
  /** Producers make more every cycle (true), or only offer lots the game posts (false: see orders.ts). */
  producerCycles: boolean;
  /** Level new and starting locations begin at. */
  startLevel: number;
  /** Highest level. */
  maxLevel: number;
  /** Unsold stock / unfilled demand carries over, up to this many cycles' worth. */
  carryCycles: number;
  /** How many recent cycles a level change looks at. */
  window: number;
  /** Served share at or above this over the window: up a level. */
  growAbove: number;
  /** Served share below this over the window: down a level (or close, at level 1). */
  shrinkBelow: number;
  /** A closing location stays open this many more cycles, marked as closing, before it goes. */
  closingCycles: number;
  /** A location can't level down or close for this many seconds after it opens (or the game starts). It can still level up. */
  graceSec: number;
}

export const DEFAULT_CYCLES: CycleConfig = {
  cycleSec: [45, 45],
  palletsPerLevel: 2,
  shopShare: 0.5,
  shopCycles: true,
  producerCycles: true,
  // Businesses stay at one level: they don't grow, shrink or close (growAbove/shrinkBelow out of reach).
  startLevel: 2,
  maxLevel: 2,
  carryCycles: 2,
  window: 2,
  growAbove: 2,
  shrinkBelow: -1,
  closingCycles: 1,
  graceSec: 60,
};

/** Dynamic state of a producer or consumer. */
export interface LocationState {
  id: number;
  kind: 'producer' | 'consumer';
  good: number;
  level: number;
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
  /** Cycles left before this location closes, or null if it isn't closing. */
  closingIn: number | null;
  /** True once it has closed; closed locations are removed from the live list. */
  closed: boolean;
  /** Game time until which it can't level down or close. */
  graceUntil: number;
  /**
   * Orders and lots (orders.ts): a shop's open order (pallets wanted per good) or a producer's lot,
   * with each company's deliveries (or pickups) towards it.
   */
  order: { size: number; wants: number[]; delivered: number[]; postedAt: number } | null;
  /** Orders and lots: no new one here before this time. */
  quietUntil: number;
  /** Orders and lots: how big the building has grown (1-4). */
  tier: number;
  /** Orders and lots: completed at this tier (towards the next). */
  completed: number;
}

export type CycleEvent =
  | { type: 'levelUp'; t: number; location: number; level: number }
  | { type: 'levelDown'; t: number; location: number; level: number }
  | { type: 'closing'; t: number; location: number }
  | { type: 'closed'; t: number; location: number };

/** Pallets per cycle for a location at its level: the same for producers and consumers. */
export function cycleRate(s: Pick<LocationState, 'kind' | 'level'>, cfg: CycleConfig): number {
  const per = s.kind === 'consumer' ? cfg.palletsPerLevel * cfg.shopShare : cfg.palletsPerLevel;
  return Math.max(1, Math.round(per * s.level));
}

/** Fresh state for a producer or consumer (a town location, or one that just opened). */
export function newLocationState(l: Location, cfg: CycleConfig, rng: Rng, now = 0): LocationState {
  const cycleSec = cfg.cycleSec[0] + rng.next() * (cfg.cycleSec[1] - cfg.cycleSec[0]);
  return {
    id: l.id,
    kind: l.kind as 'producer' | 'consumer',
    good: l.good!,
    level: cfg.startLevel,
    cycleSec,
    // Random phase so the whole town doesn't tick at once; first cycle within one cycle length.
    nextCycleAt: now + rng.next() * cycleSec,
    // Open for business from the start: a producer has a cycle's goods ready, a shop a cycle's order.
    stock: l.kind === 'producer' && cfg.producerCycles ? cycleRate({ kind: 'producer', level: cfg.startLevel }, cfg) : 0,
    demand: l.kind === 'consumer' && cfg.shopCycles ? cycleRate({ kind: 'consumer', level: cfg.startLevel }, cfg) : 0,
    cycleAmount: 0,
    served: 0,
    history: [],
    price: 0,
    closingIn: null,
    closed: false,
    graceUntil: now + cfg.graceSec,
    order: null,
    quietUntil: 0,
    tier: 1,
    completed: 0,
  };
}

export function initLocations(locs: Location[], cfg: CycleConfig, rng: Rng): LocationState[] {
  return locs.filter((l) => l.kind === 'producer' || l.kind === 'consumer').map((l) => newLocationState(l, cfg, rng));
}

/**
 * Run every cycle that's due at time t. Returns level and closure events. Closed locations are
 * marked `closed` (the game removes them from its live list).
 */
export function updateCycles(states: LocationState[], t: number, cfg: CycleConfig, rng: Rng): CycleEvent[] {
  const events: CycleEvent[] = [];
  for (const s of states) {
    if (s.closed) continue;
    while (t >= s.nextCycleAt - 1e-9 && !s.closed) {
      const at = s.nextCycleAt;
      if (s.closingIn !== null) {
        s.closingIn--;
        if (s.closingIn <= 0) {
          s.closed = true;
          s.stock = 0;
          s.demand = 0;
          events.push({ type: 'closed', t: at, location: s.id });
          break;
        }
      } else if (s.cycleAmount > 0) {
        // Close out the cycle that just ended (skip the very first, which had nothing on offer).
        s.history.push(Math.min(1, s.served / s.cycleAmount));
        if (s.history.length > cfg.window) s.history.shift();
        const e = applyLevel(s, at, cfg);
        if (e) events.push(e);
      }
      const amount = cycleRate(s, cfg);
      const cap = amount * cfg.carryCycles;
      if (s.kind === 'producer') {
        if (cfg.producerCycles) s.stock = Math.min(cap, s.stock + amount);
      }
      else if (cfg.shopCycles) s.demand = Math.min(cap, s.demand + amount);
      s.cycleAmount = amount;
      s.served = 0;
      s.nextCycleAt += s.cycleSec;
    }
  }
  return events;
}

function applyLevel(s: LocationState, t: number, cfg: CycleConfig): CycleEvent | null {
  if (s.history.length < cfg.window) return null;
  const avg = s.history.reduce((a, b) => a + b, 0) / s.history.length;
  if (avg >= cfg.growAbove && s.level < cfg.maxLevel) {
    s.level++;
    s.history = [];
    return { type: 'levelUp', t, location: s.id, level: s.level };
  }
  if (avg < cfg.shrinkBelow && t < s.graceUntil - 1e-9) {
    // Still in its grace period: not judged downwards yet (start the window again).
    s.history = [];
    return null;
  }
  if (avg < cfg.shrinkBelow) {
    s.history = [];
    if (s.level > 1) {
      s.level--;
      return { type: 'levelDown', t, location: s.id, level: s.level };
    }
    s.closingIn = cfg.closingCycles;
    return { type: 'closing', t, location: s.id };
  }
  return null;
}

/** Location investment: up a level, and a closing location is saved. */
export function raiseLevel(s: LocationState, cfg: CycleConfig): boolean {
  if (s.closed || s.level >= cfg.maxLevel) return false;
  s.level++;
  s.closingIn = null;
  s.history = [];
  return true;
}

/** A truck picks up one pallet. False if the producer has none. */
export function takePallet(producer: LocationState): boolean {
  if (producer.kind !== 'producer' || producer.closed || producer.stock <= 0) return false;
  producer.stock--;
  return true;
}

/**
 * A truck drops one pallet of `good` (picked up at `origin`). False if this consumer doesn't
 * want it right now. Credits both the consumer and the producer it came from.
 */
export function deliverPallet(consumer: LocationState, origin: LocationState | null, good: number = origin?.good ?? consumer.good): boolean {
  if (consumer.kind !== 'consumer' || consumer.closed || consumer.demand <= 0) return false;
  if (consumer.order) {
    // An order: only the goods it still wants.
    if ((consumer.order.wants[good] ?? 0) <= 0) return false;
    consumer.order.wants[good]--;
  } else if (good !== consumer.good) return false;
  consumer.demand--;
  consumer.served++;
  if (origin) origin.served++;
  return true;
}
