/**
 * Orders and lots: shops ask for goods, producers offer them, and the town grows as they're served.
 *
 * Shops post orders: a fixed number of pallets (of one, two or three goods, by the shop's tier). Each
 * pallet pays as it's delivered; filling the order pays a completion bonus to the companies that
 * delivered, split by how much each did. Then the shop goes quiet for a while.
 *
 * Producers work the other way round: they offer a lot (a fixed number of pallets of their good),
 * trucks collect it, and once it's all gone the producer goes quiet until its next lot.
 *
 * The town grows: a shop or producer moves up a tier as it completes orders or lots (the first
 * completion takes it to tier 2, then a few more per tier, up to 4). Higher tiers ask for or offer
 * more, and from tier 3 a shop's orders mix goods: tall buildings mark where companies have been busy.
 *
 * Pacing: the town keeps open demand in step with the fleet (pallets still wanted across all orders,
 * per truck in town), and open supply in step with demand, good by good. New orders favour shops of
 * goods that are short of demand, near unclaimed factory sites, and taller buildings; new lots go to
 * producers near the shops that want their good.
 *
 * Trucks claim a pallet when they're sent, following a delivery plan made across every company's
 * trucks (see Game.makePlan): each pallet goes to whichever truck would get it there soonest, so
 * nobody drives for a pallet that's gone, and nobody is ever turned back.
 */
import type { LocationState } from './economy.js';
import type { Rng } from './rng.js';

export interface OrdersConfig {
  /** Shops take orders and producers offer lots (true), or both run on cycles (false). */
  enabled: boolean;
  /** Pallets per good in a shop's order, by tier (1-4), inclusive ranges. */
  orderSize: [number, number][];
  /** Goods in a shop's order, by tier: its own, then others. */
  orderGoods: number[];
  /** Pallets in a producer's lot, by tier (1-4), inclusive ranges. */
  lotSize: [number, number][];
  /** Completed orders (or lots) at each tier that move a place up to the next. */
  tierUpAfter: number[];
  /** Seconds a shop stays quiet after its order is filled, inclusive range. */
  quietSec: [number, number];
  /** Seconds a producer rests after its lot is collected, inclusive range. */
  lotQuietSec: [number, number];
  /** Open demand the town keeps up, in pallets per truck in town (all companies)... */
  openPerTruck: number;
  /** ...but never less than this. */
  minOpen: number;
  /** Open supply kept up per good, as a multiple of that good's open demand. */
  supplyShare: number;
  /** Completion bonus, dollars per pallet of the order's size, split by each company's deliveries. */
  bonusPerPallet: number;
  /** How much likelier a shop near an unclaimed factory site (within its district) gets an order. */
  nearSiteWeight: number;
  /** Replan if a truck is free this many seconds later than the plan expected (and with nothing planned). */
  lateSec: number;
  /** Replan at least this often anyway (seconds), to catch drift. */
  replanSec: number;
  /** Changes are batched: replan at most this often (seconds), unless a free truck has nothing planned. */
  batchSec: number;
}

export const DEFAULT_ORDERS: OrdersConfig = {
  enabled: true,
  orderSize: [
    [4, 6],
    [8, 12],
    [5, 7],
    [4, 6],
  ],
  orderGoods: [1, 1, 2, 3],
  lotSize: [
    [4, 6],
    [7, 10],
    [10, 14],
    [14, 18],
  ],
  tierUpAfter: [1, 2, 3],
  quietSec: [60, 180],
  lotQuietSec: [15, 45],
  openPerTruck: 1.3,
  minOpen: 40,
  supplyShare: 1.1,
  bonusPerPallet: 0.6,
  nearSiteWeight: 3,
  lateSec: 8,
  replanSec: 20,
  batchSec: 5,
};

/** Pallets a shop's order still wants (not yet delivered or being unloaded), or a producer's lot still holds. */
export const openPallets = (s: LocationState) => (s.order ? (s.kind === 'consumer' ? s.demand : s.stock) : 0);
/** Pallets of one good a shop's order still wants. */
export const wantsOf = (s: LocationState, good: number) => (s.order ? s.order.wants[good] ?? 0 : 0);

/** Free to take an order or lot: open, none on now, and not resting. */
const isFree = (s: LocationState, t: number) => !s.closed && s.order === null && t >= s.quietUntil - 1e-9;

/** Pick the next shop to take an order (weighted), or null if none is free. */
export function pickOrderShop(
  shops: LocationState[],
  t: number,
  short: (good: number) => number,
  nearSite: (shop: LocationState) => boolean,
  cfg: OrdersConfig,
  rng: Rng,
): LocationState | null {
  const free = shops.filter((s) => isFree(s, t));
  if (free.length === 0) return null;
  const weights = free.map((s) => Math.max(0.05, short(s.good)) * (nearSite(s) ? cfg.nearSiteWeight : 1) * s.tier);
  return free[rng.weighted(weights)];
}

/** Pick the next producer of a good to offer a lot (weighted by nearby demand and tier), or null. */
export function pickLotProducer(producers: LocationState[], good: number, t: number, nearbyDemand: (p: LocationState) => number, rng: Rng): LocationState | null {
  const free = producers.filter((p) => p.good === good && isFree(p, t));
  if (free.length === 0) return null;
  return free[rng.weighted(free.map((p) => (0.5 + nearbyDemand(p)) * p.tier))];
}

const sizeAt = (ranges: [number, number][], tier: number, rng: Rng) => {
  const [lo, hi] = ranges[Math.min(ranges.length, Math.max(1, tier)) - 1];
  return rng.int(lo, hi);
};

/** Post an order at a shop: its own good, plus others from tier 3 (other goods drawn at random). */
export function postOrder(s: LocationState, goods: number, companies: number, t: number, cfg: OrdersConfig, rng: Rng) {
  const wants = new Array(goods).fill(0);
  const n = Math.min(goods, cfg.orderGoods[Math.min(cfg.orderGoods.length, s.tier) - 1] ?? 1);
  const others = rng.shuffle([...Array(goods).keys()].filter((g) => g !== s.good));
  for (const g of [s.good, ...others.slice(0, n - 1)]) wants[g] = sizeAt(cfg.orderSize, s.tier, rng);
  const size = wants.reduce((a, b) => a + b, 0);
  s.order = { size, wants, delivered: new Array(companies).fill(0), postedAt: t };
  s.demand = size;
  s.served = 0;
  s.cycleAmount = size;
}

/** Offer a lot at a producer. */
export function postLot(p: LocationState, companies: number, t: number, cfg: OrdersConfig, rng: Rng) {
  const size = sizeAt(cfg.lotSize, p.tier, rng);
  p.order = { size, wants: [], delivered: new Array(companies).fill(0), postedAt: t };
  p.stock = size;
  p.served = 0;
  p.cycleAmount = size;
}

/** Done: quiet for a while, and count towards the next tier. True if it moved up a tier. */
function finish(s: LocationState, t: number, cfg: OrdersConfig, rng: Rng): boolean {
  s.order = null;
  const [lo, hi] = s.kind === 'producer' ? cfg.lotQuietSec : cfg.quietSec;
  s.quietUntil = t + lo + rng.next() * (hi - lo);
  s.completed++;
  const need = cfg.tierUpAfter[s.tier - 1];
  if (need !== undefined && s.completed >= need) {
    s.tier++;
    s.completed = 0;
    return true;
  }
  return false;
}

/**
 * Credit a delivery to a shop's order. When it was the last pallet, the order is done: returns it
 * (and whether the shop moved up a tier), and the shop goes quiet.
 */
export function creditOrder(s: LocationState, company: number, t: number, cfg: OrdersConfig, rng: Rng) {
  if (!s.order) return null;
  s.order.delivered[company]++;
  if (s.order.delivered.reduce((a, b) => a + b, 0) < s.order.size) return null;
  const done = s.order;
  s.demand = 0;
  const grew = finish(s, t, cfg, rng);
  return { size: done.size, delivered: done.delivered, grew };
}

/** Credit a pickup from a producer's lot. When it was the last pallet, the lot is done (as above). */
export function creditLot(p: LocationState, company: number, t: number, cfg: OrdersConfig, rng: Rng) {
  if (!p.order) return null;
  p.order.delivered[company]++;
  if (p.order.delivered.reduce((a, b) => a + b, 0) < p.order.size) return null;
  const done = p.order;
  p.stock = 0;
  const grew = finish(p, t, cfg, rng);
  return { size: done.size, delivered: done.delivered, grew };
}
