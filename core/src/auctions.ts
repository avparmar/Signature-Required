/**
 * Share auctions.
 *
 * - Opening round, before the game clock starts: one share of each company, one company at a time.
 * - During play, a company's president can put up one of its bank-held shares. Anyone else can
 *   too, by opening the bidding themselves (at least `rivalOpeningBid`), so a rival can force a
 *   share onto the market and the president has to outbid them to keep it. Once all of a
 *   company's shares are out, a shareholder may put up one of their own (the money still goes
 *   to the company). A company nobody owns is re-offered by the bank after a cooldown.
 * - One auction at a time; requests queue, one per company.
 * - Soft close: a bid near the end resets the clock to a few seconds, so an auction only ends
 *   after a quiet moment, but never runs longer than `maxSec` in all, so small raises can't
 *   hold up the auctions waiting behind it. Highest bid wins; the money goes to the company treasury.
 * - A player's leading bid is held from their cash until they're outbid or the auction ends.
 * - Anyone may pass. Once everyone but the high bidder (and the seller) has passed, the auction
 *   ends at once. A new bid clears the passes, so the others can answer it.
 */

export interface AuctionConfig {
  /** Run the opening round before the game clock starts. */
  openingRound: boolean;
  /** Seconds on the clock for each opening-round auction. */
  openingClockSec: number;
  /** Seconds on the clock for an in-game auction. */
  clockSec: number;
  /** A bid with less than this left resets the clock to this. */
  softCloseSec: number;
  /** Lowest first bid. */
  openingBid: number;
  /** Each bid must beat the current one by at least this. */
  minRaise: number;
  /** After an auction with no bids, seconds before that company can auction again. */
  noBidCooldownSec: number;
  /** After a share of a company sells (once the game is running), seconds before that company can
   *  auction another, so shares don't all go in one burst. */
  saleCooldownSec: number;
  /** No auction runs longer than this in all (seconds), however late the bids come. */
  maxSec: number;
  /** Lowest opening bid for a player who puts up a bank share of a company they don't lead. */
  rivalOpeningBid: number;
}

export const DEFAULT_AUCTIONS: AuctionConfig = {
  openingRound: true,
  openingClockSec: 30,
  clockSec: 30,
  softCloseSec: 10,
  openingBid: 0,
  minRaise: 2,
  noBidCooldownSec: 60,
  saleCooldownSec: 60,
  rivalOpeningBid: 5,
  maxSec: 60,
};

export interface Auction {
  company: number;
  /** Player selling one of their own shares, or null when the bank is selling. */
  seller: number | null;
  /** Who started it: a president, or the bank (opening round / unowned company). */
  startedBy: number | 'bank';
  highBid: number;
  highBidder: number | null;
  /** Seconds left on the clock. */
  timeLeft: number;
  /** Seconds it has been running. */
  age: number;
  opening: boolean;
  /** Players who have passed since the last bid. */
  passed: number[];
}

export interface AuctionRequest {
  company: number;
  seller: number | null;
  startedBy: number | 'bank';
  /** The starter's own opening bid, placed when the auction starts (required of non-presidents). */
  bid?: number;
}

export type AuctionEvent =
  | { type: 'auctionStart'; t: number; company: number; seller: number | null; opening: boolean; timeLeft: number }
  | { type: 'bid'; t: number; company: number; player: number; amount: number; timeLeft: number }
  | { type: 'auctionWon'; t: number; company: number; player: number; amount: number; seller: number | null }
  | { type: 'auctionNoBids'; t: number; company: number }
  | { type: 'pass'; t: number; company: number; player: number }
  | { type: 'auctionQueued'; t: number; company: number; position: number };

/** Lowest bid that would be accepted right now. */
export function minimumBid(a: Auction, cfg: AuctionConfig): number {
  return a.highBidder === null ? cfg.openingBid : a.highBid + cfg.minRaise;
}

/** Players who still have a say in an auction: everyone but its seller and the high bidder. */
export function stillBidding(a: Auction, players: number): number[] {
  return Array.from({ length: players }, (_, p) => p).filter((p) => p !== a.seller && p !== a.highBidder && !a.passed.includes(p));
}
