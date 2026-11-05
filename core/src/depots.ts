/**
 * Depots and buying trucks.
 *
 * - Every company starts with one depot (free). A depot services a limited number of trucks.
 * - Buying depots at fixed sites is the only way to grow a fleet past that limit.
 * - A depot's price rises with how far the site is from the company's existing depots, so
 *   expanding next door is cheap and leaping across town is possible but expensive.
 * - Everything is paid from the company treasury.
 */
import { distancesFrom, type RoadGraph } from './graph.js';
import type { Location } from './town.js';

export interface DepotConfig {
  /** Trucks a depot can service. */
  capacity: number;
  /** Price of a truck. */
  truckPrice: number;
  /** Price of a depot close to the company's network. */
  depotBase: number;
  /** Drive distance (blocks) from your nearest depot that still costs only the base price. */
  depotFreeBlocks: number;
  /** Extra price per block beyond that. */
  depotPerBlock: number;
}

export const DEFAULT_DEPOTS: DepotConfig = {
  capacity: 3,
  truckPrice: 15,
  depotBase: 80,
  depotFreeBlocks: 4,
  depotPerBlock: 10,
};

/** Drive distance from a site to the nearest of a company's depots. */
export function distanceToNetwork(graph: RoadGraph, siteNode: number, ownNodes: number[]): number {
  if (ownNodes.length === 0) return Infinity;
  const d = distancesFrom(graph, siteNode);
  return Math.min(...ownNodes.map((n) => d[n]));
}

/** Price of a depot site for a company that already has depots at `ownNodes`. Whole dollars. */
export function depotPrice(cfg: DepotConfig, distance: number): number {
  if (!Number.isFinite(distance)) return cfg.depotBase;
  return Math.round(cfg.depotBase + cfg.depotPerBlock * Math.max(0, distance - cfg.depotFreeBlocks));
}

/** Depot sites in a town. */
export function depotSites(locations: Location[]): Location[] {
  return locations.filter((l) => l.kind === 'depot');
}
