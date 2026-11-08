/**
 * Shop orders: instead of wanting more every cycle, a shop posts an order for a fixed number of
 * pallets, is paid per pallet as they arrive, and when the order is filled pays a completion bonus
 * to the companies that delivered (split by how much each did). Then it goes quiet for a while.
 *
 * The town keeps a steady amount of open demand: whenever the pallets still wanted across all open
 * orders fall below a target (a share of what producers make per cycle), it posts a new order at a
 * shop chosen by a weighted draw: favouring goods whose producers have the least open demand,
 * shops near unclaimed factory sites (a reason to build there), and never a shop that's still quiet.
 *
 * Trucks claim a pallet when they're sent, following a delivery plan made across every company's
 * trucks (see Game.makePlan): each pallet goes to whichever truck would get it there soonest, so
 * nobody drives for a pallet the shop no longer wants, and nobody is ever turned back.
 */
import type { LocationState } from './economy.js';
import type { Rng } from './rng.js';

export interface OrdersConfig {
  /** Shops take orders (true), or want more every cycle (false). */
  enabled: boolean;
  /** Pallets per order, inclusive range. */
  size: [number, number];
  /** Seconds a shop stays quiet after its order is filled, inclusive range. */
  quietSec: [number, number];
  /** Open demand the town keeps up: pallets still wanted across all orders, as a multiple of what
   *  every producer makes in one cycle. */
  openShare: number;
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
  size: [4, 12],
  quietSec: [60, 180],
  openShare: 1,
  bonusPerPallet: 0.6,
  nearSiteWeight: 3,
  lateSec: 8,
  replanSec: 20,
  batchSec: 5,
};

/** Pallets an order still wants (not yet delivered, or being unloaded). */
export const openPallets = (s: LocationState) => (s.order ? s.demand : 0);

/**
 * Pick the next shop to take an order: weighted by how short its good is (producer output against
 * open demand for that good) and whether it's near an unclaimed site. Null if no shop is free.
 */
export function pickOrderShop(
  shops: LocationState[],
  producers: LocationState[],
  t: number,
  nearSite: (shop: LocationState) => boolean,
  cfg: OrdersConfig,
  rng: Rng,
  rate: (s: LocationState) => number,
): LocationState | null {
  const free = shops.filter((s) => !s.closed && s.order === null && t >= s.quietUntil - 1e-9);
  if (free.length === 0) return null;
  const supply = new Map<number, number>();
  for (const p of producers) if (!p.closed) supply.set(p.good, (supply.get(p.good) ?? 0) + rate(p));
  const open = new Map<number, number>();
  for (const s of shops) open.set(s.good, (open.get(s.good) ?? 0) + openPallets(s));
  const weights = free.map((s) => {
    const short = (supply.get(s.good) ?? 0) / (1 + (open.get(s.good) ?? 0));
    return Math.max(0.05, short) * (nearSite(s) ? cfg.nearSiteWeight : 1);
  });
  return free[rng.weighted(weights)];
}

/** Post an order at a shop. */
export function postOrder(s: LocationState, companies: number, t: number, cfg: OrdersConfig, rng: Rng) {
  const size = rng.int(cfg.size[0], cfg.size[1]);
  s.order = { size, delivered: new Array(companies).fill(0), postedAt: t };
  s.demand = size;
  s.served = 0;
  s.cycleAmount = size;
}

/**
 * Credit a delivery to the shop's order. Returns the completed order (and clears it, quieting the
 * shop) when this was its last pallet.
 */
export function creditOrder(s: LocationState, company: number, t: number, cfg: OrdersConfig, rng: Rng): { size: number; delivered: number[] } | null {
  if (!s.order) return null;
  s.order.delivered[company]++;
  const total = s.order.delivered.reduce((a, b) => a + b, 0);
  if (total < s.order.size) return null;
  const done = s.order;
  s.order = null;
  s.demand = 0;
  s.quietUntil = t + cfg.quietSec[0] + rng.next() * (cfg.quietSec[1] - cfg.quietSec[0]);
  return done;
}
