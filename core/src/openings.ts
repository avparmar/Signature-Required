/**
 * New producers and consumers opening on empty lots during the game.
 *
 * Roughly one opening a minute (configurable). The lot is chosen by a weighted draw: lots right
 * next to existing producers and consumers score low, lots that are reachable but quiet score
 * high, and the draw itself adds unpredictability. The good is random, with a slight preference
 * for whichever kind (producer or consumer) of that good the town has fewer of.
 */
import { distancesFrom } from './graph.js';
import { pairOk } from './town.js';
import type { Rng } from './rng.js';
import type { Location, Town } from './town.js';

export interface OpeningConfig {
  /** Average seconds between openings (Poisson). 0 turns openings off. */
  everySec: number;
  /** No openings in the first / last this many seconds of the game. */
  quietStartSec: number;
  quietEndSec: number;
  /** Lots closer than this (drive distance, blocks) to a producer/consumer are strongly avoided. */
  crowdRadius: number;
  /** Lots further than this from every producer/consumer are also avoided (too remote). */
  remoteRadius: number;
  /** Level a newly opened location starts at. */
  openLevel: number;
}

export const DEFAULT_OPENINGS: OpeningConfig = {
  everySec: 30,
  quietStartSec: 60,
  quietEndSec: 120,
  crowdRadius: 2,
  remoteRadius: 8,
  openLevel: 2,
};

export interface OpeningChoice {
  lot: number;
  kind: 'producer' | 'consumer';
  good: number;
}

/** Weight for opening on a lot: how far it is from the nearest live producer/consumer. */
export function lotWeight(nearest: number, cfg: OpeningConfig): number {
  if (nearest < cfg.crowdRadius) return 0.1;
  if (nearest > cfg.remoteRadius) return 0.3;
  // Peak a few blocks out, tapering towards both ends.
  const mid = (cfg.crowdRadius + cfg.remoteRadius) / 2;
  return 1 + 1.5 * (1 - Math.abs(nearest - mid) / (mid - cfg.crowdRadius));
}

/** Pick where and what to open, or null if there's no empty lot. */
export function chooseOpening(town: Town, live: Location[], cfg: OpeningConfig, rng: Rng): OpeningChoice | null {
  const lots = town.locations.filter((l) => l.kind === 'lot');
  if (lots.length === 0) return null;
  const liveNodes = live.map((l) => l.node);
  const weights = lots.map((lot) => {
    if (liveNodes.length === 0) return 1;
    const d = distancesFrom(town.graph, lot.node);
    const nearest = Math.min(...liveNodes.map((n) => d[n]));
    return lotWeight(nearest, cfg);
  });
  const lot = lots[rng.weighted(weights)];
  // What to open: whichever good and kind is shortest nearby (within reach of the lot), so the town
  // keeps supply and demand in step where it matters. Shops count against their share of a
  // producer's output (two shops per producer balance).
  const share = town.cfg.shopsPerProducer > 0 ? town.cfg.shopsPerProducer : 2;
  const dLot = distancesFrom(town.graph, lot.node);
  const reach = Math.max(town.cfg.shopReach, 4);
  const shortfall: { kind: 'producer' | 'consumer'; good: number; need: number }[] = [];
  for (let g = 0; g < town.cfg.goods.length; g++) {
    const near = live.filter((l) => l.good === g && dLot[l.node] <= reach);
    const p = near.filter((l) => l.kind === 'producer').length;
    const c = near.filter((l) => l.kind === 'consumer').length;
    // Positive: shops short of this good's supply here; negative: producers short.
    const gap = p * share - c;
    shortfall.push({ kind: 'consumer', good: g, need: gap + rng.next() * 0.5 });
    shortfall.push({ kind: 'producer', good: g, need: -gap / share + rng.next() * 0.5 });
  }
  shortfall.sort((a, b) => b.need - a.need);
  let good = shortfall[0].good;
  let kind: 'producer' | 'consumer' = shortfall[0].kind;
  // Never right next to its own trading partner: try the other kind, then other goods.
  // Preferably not right beside a twin (same kind and good) either.
  const apart = (k: 'producer' | 'consumer', g: number) =>
    live.every((l) => l.kind !== k || l.good !== g || Math.abs(l.x - lot.x) + Math.abs(l.y - lot.y) >= town.cfg.sameGap);
  const ok = (k: 'producer' | 'consumer', g: number) => pairOk(live, k, g, lot, town.cfg.pairGap);
  if (!ok(kind, good) || !apart(kind, good)) {
    const options: ['producer' | 'consumer', number][] = [];
    for (const x of shortfall) options.push([x.kind, x.good]);
    const pick = options.find(([kk, g]) => ok(kk, g) && apart(kk, g)) ?? options.find(([kk, g]) => ok(kk, g));
    if (!pick) return null;
    [kind, good] = pick;
  }
  return { lot: lot.id, kind, good };
}
