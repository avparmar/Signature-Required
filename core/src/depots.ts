/**
 * Depots and buying trucks.
 *
 * - Every company starts with one depot (free). A depot services a limited number of trucks.
 * - Buying depots at fixed sites is the only way to grow a fleet past that limit.
 * - Depots are rare and big. A site's price is a premium base price, discounted by the local
 *   authority for companies that already serve the area: the discount grows with your share of
 *   recent pallets loaded and delivered in the site's district. Growing into an area you serve
 *   is cheap; leaping into one you don't pays full price.
 * - (The older rule, kept for experiments: the price rises with distance from your depots.)
 * - Everything is paid from the company treasury.
 */
import { distancesFrom, type RoadGraph } from './graph.js';
import type { Location } from './town.js';

export interface DepotConfig {
  /** Trucks a depot can service. */
  capacity: number;
  /** Price of a truck. */
  truckPrice: number;
  /** How depot sites are priced: local subsidy (default) or distance from your depots (older rule). */
  pricing: 'subsidy' | 'distance';
  /** Full price of a depot site (subsidy pricing), or the price close to your network (distance pricing). */
  depotBase: number;
  /** Subsidy pricing: discount for a company doing all the recent service in a site's district. */
  maxSubsidy: number;
  /** Subsidy pricing: a site's district is everything within this drive distance (blocks). */
  districtBlocks: number;
  /** Subsidy pricing: service counts towards the subsidy for this long (seconds). */
  subsidyWindowSec: number;
  /** Drive distance (blocks) from your nearest depot that still costs only the base price. */
  depotFreeBlocks: number;
  /** Extra price per block beyond that. */
  depotPerBlock: number;
}

export const DEFAULT_DEPOTS: DepotConfig = {
  capacity: 8,
  truckPrice: 12,
  pricing: 'subsidy',
  depotBase: 150,
  maxSubsidy: 0.6,
  districtBlocks: 5,
  subsidyWindowSec: 180,
  depotFreeBlocks: 4,
  depotPerBlock: 10,
};

/** Drive distance from a site to the nearest of a company's depots. */
export function distanceToNetwork(graph: RoadGraph, siteNode: number, ownNodes: number[]): number {
  if (ownNodes.length === 0) return Infinity;
  const d = distancesFrom(graph, siteNode);
  return Math.min(...ownNodes.map((n) => d[n]));
}

/** Distance pricing: price of a site at `distance` from the company's nearest depot. Whole dollars. */
export function depotPrice(cfg: DepotConfig, distance: number): number {
  if (!Number.isFinite(distance)) return cfg.depotBase;
  return Math.round(cfg.depotBase + cfg.depotPerBlock * Math.max(0, distance - cfg.depotFreeBlocks));
}

/** Depot sites in a town. */
export function depotSites(locations: Location[]): Location[] {
  return locations.filter((l) => l.kind === 'depot');
}

/**
 * Subsidy pricing: the full price, less the local subsidy for a company that did `share` (0 to 1)
 * of the recent service in the site's district. Whole dollars.
 */
export function subsidisedPrice(cfg: DepotConfig, share: number): number {
  return Math.round(cfg.depotBase * (1 - cfg.maxSubsidy * Math.max(0, Math.min(1, share))));
}
