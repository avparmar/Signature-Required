import { DEFAULT_CYCLES, type CycleConfig } from './economy.js';
import { makeTownConfig, type TownConfig } from './town.js';

/**
 * Every tunable in one place. Later issues add their own sections (cycles, trucks, money);
 * keep defaults here so experiments can override anything with a plain object.
 */
export interface GameConfig {
  seed: number;
  /** Number of players (2–4). */
  players: number;
  /** Delivery companies; defaults to players + 1. */
  companies: number;
  /** Shares per company. */
  sharesPerCompany: number;
  /** Real-time length of a match. */
  durationSec: number;
  /** Simulation step. Everything advances in whole ticks so games are reproducible. */
  tickSec: number;
  /** Cash each player starts with (to bid in share auctions; dividends are the only income after that). */
  startingCash: number;
  /** Cash each company's treasury starts with. */
  startingTreasury: number;
  town: TownConfig;
  cycles: CycleConfig;
}

export const DEFAULT_GAME: Omit<GameConfig, 'town' | 'companies' | 'cycles'> = {
  seed: 1,
  players: 4,
  sharesPerCompany: 5,
  durationSec: 15 * 60,
  tickSec: 0.1,
  startingCash: 100,
  startingTreasury: 0,
};

export type GameConfigOverrides = Partial<Omit<GameConfig, 'town' | 'cycles'>> & {
  town?: Partial<TownConfig>;
  cycles?: Partial<CycleConfig>;
};

export function makeGameConfig(o: GameConfigOverrides = {}): GameConfig {
  const players = o.players ?? DEFAULT_GAME.players;
  const companies = o.companies ?? players + 1;
  const seed = o.seed ?? DEFAULT_GAME.seed;
  return {
    ...DEFAULT_GAME,
    ...o,
    players,
    companies,
    seed,
    // The town shares the game's seed and has one starting depot per company.
    town: makeTownConfig({ seed, companies, ...o.town }),
    cycles: { ...DEFAULT_CYCLES, ...o.cycles },
  } as GameConfig;
}
