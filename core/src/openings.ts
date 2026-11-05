/**
 * New producers and consumers opening on empty lots during the game.
 *
 * Roughly one opening a minute (configurable). The lot is chosen by a weighted draw: lots right
 * next to existing producers and consumers score low, lots that are reachable but quiet score
 * high, and the draw itself adds unpredictability. The good is random, with a slight preference
 * for whichever kind (producer or consumer) of that good the town has fewer of.
 */
import { distancesFrom } from './graph.js';
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
  everySec: 60,
  quietStartSec: 60,
  quietEndSec: 120,
  crowdRadius: 2,
  remoteRadius: 8,
  openLevel: 3,
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
  const good = rng.int(0, town.cfg.goods.length - 1);
  const producers = live.filter((l) => l.kind === 'producer' && l.good === good).length;
  const consumers = live.filter((l) => l.kind === 'consumer' && l.good === good).length;
  // Lean towards the side that's short, but not deterministically.
  const pConsumer = consumers >= 2 * producers ? 0.35 : producers >= consumers ? 0.75 : 0.6;
  const kind = rng.next() < pConsumer ? 'consumer' : 'producer';
  return { lot: lot.id, kind, good };
}
