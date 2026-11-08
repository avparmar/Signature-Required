/**
 * Money: what deliveries earn, dividends, and location investment.
 *
 * - Each consumer pays one price per pallet. Every delivery puts that amount into the company's
 *   treasury immediately and the same amount into its dividend pot.
 * - Every few minutes each company pays out its pot, split into one equal part per share. Parts
 *   for shares the company owns itself go into its treasury.
 * - The last payout is at the end of the game. It can add part of each company's assets (off by
 *   default: shares are worth what they pay and what they sell for, see auctions.ts).
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
  /**
   * Where each delivery's price goes, as multiples of the price (default: half to each, nothing printed). 1 and 1 = the company and its
   * shareholders each get the full price (the bank prints the second copy). SAR-style is 0 and 1:
   * income goes only to dividends, so companies grow only from share auctions.
   */
  deliveryToTreasury: number;
  deliveryToPot: number;
  /** Seconds between dividend payouts; the last payout is at the end of the game. */
  payoutEverySec: number;
  /**
   * What the final payout adds on top of the pot:
   * - 'assets': `finalAssetShare` of the company's assets (trucks and depots at purchase price, plus treasury)
   * - 'earnings': `finalEarningsMultiple` x what the company earned since the previous payout
   *   (a buy-out based on performance, so money invested is only rewarded if it earned)
   */
  finalBonus: 'assets' | 'earnings';
  finalAssetShare: number;
  finalEarningsMultiple: number;
  /** Price to raise a location from level 1 to 2. */
  investBase: number;
  /** Each further level costs this much more (multiplied). */
  investGrowth: number;
}

export const DEFAULT_MONEY: MoneyConfig = {
  palletPrice: 3.6,
  premiumPrice: 5.4,
  premiumShare: 0.25,
  deliveryToTreasury: 0.5,
  deliveryToPot: 0.5,
  payoutEverySec: 180,
  finalBonus: 'assets',
  finalAssetShare: 0,
  finalEarningsMultiple: 2,
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

/**
 * Cost to raise a location from `level` to `level + 1`. The base price buys the first level above
 * the start level; levels below that (a shrunken location) are cheaper. Whole dollars.
 */
export function investCost(cfg: MoneyConfig, level: number, startLevel = 1): number {
  return Math.round(cfg.investBase * Math.pow(cfg.investGrowth, level - startLevel));
}

/**
 * Split an amount into one equal part per share and pay the owners.
 * Returns what each player received; parts for company-owned shares aren't in it (the game puts them in the treasury).
 */
export function payPerShare(shares: (number | null)[], amount: number): Map<number, number> {
  const part = amount / shares.length;
  const paid = new Map<number, number>();
  for (const owner of shares) if (owner !== null) paid.set(owner, (paid.get(owner) ?? 0) + part);
  return paid;
}
