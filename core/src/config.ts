import { DEFAULT_AUCTIONS, type AuctionConfig } from './auctions.js';
import { DEFAULT_DEPOTS, type DepotConfig } from './depots.js';
import { DEFAULT_CYCLES, type CycleConfig } from './economy.js';
import { DEFAULT_MONEY, type MoneyConfig } from './money.js';
import { DEFAULT_OPENINGS, type OpeningConfig } from './openings.js';
import { DEFAULT_ORDERS, type OrdersConfig } from './orders.js';
import { makeTownConfig, type TownConfig } from './town.js';
import { DEFAULT_TRUCKS, type TruckConfig } from './trucks.js';

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
  /** Trucks each company starts with, free, at its starting factory (so no start is dead in the water). */
  startingTrucks: number;
  /**
   * Companies pick their own routes (see Game.autoRoute): presidents choose a delivery area and
   * places to focus on instead of setting routes by hand. Off, routes are assigned by hand.
   */
  autoRoutes: boolean;
  /** Most places a company can focus on at once. */
  maxFocus: number;
  town: TownConfig;
  cycles: CycleConfig;
  trucks: TruckConfig;
  depots: DepotConfig;
  money: MoneyConfig;
  auctions: AuctionConfig;
  openings: OpeningConfig;
  orders: OrdersConfig;
}

export const DEFAULT_GAME: Omit<GameConfig, 'town' | 'companies' | 'cycles' | 'trucks' | 'depots' | 'money' | 'auctions' | 'openings' | 'orders'> = {
  seed: 1,
  players: 4,
  sharesPerCompany: 5,
  durationSec: 15 * 60,
  tickSec: 0.1,
  startingCash: 150,
  startingTreasury: 0,
  startingTrucks: 1,
  autoRoutes: true,
  maxFocus: 3,
};

export type GameConfigOverrides = Partial<Omit<GameConfig, 'town' | 'cycles' | 'trucks' | 'depots' | 'money' | 'auctions' | 'openings' | 'orders'>> & {
  town?: Partial<TownConfig>;
  cycles?: Partial<CycleConfig>;
  trucks?: Partial<TruckConfig>;
  depots?: Partial<DepotConfig>;
  money?: Partial<MoneyConfig>;
  auctions?: Partial<AuctionConfig>;
  openings?: Partial<OpeningConfig>;
  orders?: Partial<OrdersConfig>;
};

export function makeGameConfig(o: GameConfigOverrides = {}): GameConfig {
  const players = o.players ?? DEFAULT_GAME.players;
  const companies = o.companies ?? players + 1;
  const seed = o.seed ?? DEFAULT_GAME.seed;
  // Shop orders need the companies routing their own trucks (one trip per dispatch); with routes set
  // by hand, shops want more every cycle as before.
  const autoRoutes = o.autoRoutes ?? DEFAULT_GAME.autoRoutes;
  const orders: OrdersConfig = { ...DEFAULT_ORDERS, ...o.orders };
  orders.enabled = orders.enabled && autoRoutes;
  return {
    ...DEFAULT_GAME,
    ...o,
    players,
    companies,
    seed,
    // The town shares the game's seed and has one starting depot per company.
    town: makeTownConfig({ seed, companies, ...o.town }),
    cycles: { ...DEFAULT_CYCLES, shopCycles: !orders.enabled, producerCycles: !orders.enabled, ...o.cycles },
    trucks: { ...DEFAULT_TRUCKS, oneTrip: orders.enabled, ...o.trucks },
    depots: { ...DEFAULT_DEPOTS, ...o.depots },
    money: { ...DEFAULT_MONEY, ...o.money },
    auctions: { ...DEFAULT_AUCTIONS, ...o.auctions },
    openings: { ...DEFAULT_OPENINGS, ...o.openings },
    orders,
  } as GameConfig;
}
