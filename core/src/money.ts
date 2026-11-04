/**
 * Money: what deliveries earn, dividends, and location investment.
 *
 * - Each consumer pays one price per pallet. Every delivery puts that amount into the company's
 *   treasury immediately and the same amount into its dividend pot.
 * - Every few minutes each company pays out its pot, split into one equal part per share. Parts
 *   for shares the bank still holds aren't paid. Dividends (printed by the bank) are players'
 *   only income.
 * - The final payout also includes part of each company's assets, so shares keep their value
 *   to the end.
 * - Any player can pay to raise a producer or consumer one level.
 */
import type { Rng } from './rng.js';

export interface MoneyConfig {
  /** What a consumer pays per pallet. */
  palletPrice: number;
  /** What a premium buyer pays per pallet. */
  premiumPrice: number;
  /** Share of consumers that are premium buyers. */
  premiumShare: number;
  /** Seconds between dividend payouts; the last payout is at the end of the game. */
  payoutEverySec: number;
  /** Share of company assets (trucks and depots at purchase price, plus treasury) in the final payout. */
  finalAssetShare: number;
  /** Price to raise a location from level 1 to 2. */
  investBase: number;
  /** Each further level costs this much more (multiplied). */
  investGrowth: number;
}

export const DEFAULT_MONEY: MoneyConfig = {
  palletPrice: 2,
  premiumPrice: 3,
  premiumShare: 0.25,
  payoutEverySec: 180,
  finalAssetShare: 0.5,
  investBase: 60,
  investGrowth: 1.5,
};

/** Price per pallet for each consumer (location id -> price), with a random set of premium buyers. */
export function assignPrices(consumerIds: number[], cfg: MoneyConfig, rng: Rng): Map<number, number> {
  const ids = rng.shuffle([...consumerIds]);
  const premium = Math.round(ids.length * cfg.premiumShare);
  const prices = new Map<number, number>();
  ids.forEach((id, i) => prices.set(id, i < premium ? cfg.premiumPrice : cfg.palletPrice));
  return prices;
}

/** Cost to raise a location from `level` to `level + 1`. Whole dollars. */
export function investCost(cfg: MoneyConfig, level: number): number {
  return Math.round(cfg.investBase * Math.pow(cfg.investGrowth, level - 1));
}

/**
 * Split an amount into one equal part per share and pay the owners.
 * Returns what each player received; parts for bank-held shares are simply not paid.
 */
export function payPerShare(shares: (number | null)[], amount: number): Map<number, number> {
  const part = amount / shares.length;
  const paid = new Map<number, number>();
  for (const owner of shares) if (owner !== null) paid.set(owner, (paid.get(owner) ?? 0) + part);
  return paid;
}
