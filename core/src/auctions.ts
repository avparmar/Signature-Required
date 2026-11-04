/**
 * Share auctions.
 *
 * - Opening round, before the game clock starts: one share of each company, one company at a time.
 * - During play, a company's president can put up one of its bank-held shares. Once all of a
 *   company's shares are out, a shareholder may put up one of their own (the money still goes
 *   to the company). A company nobody owns is re-offered by the bank after a cooldown.
 * - One auction at a time; requests queue, one per company.
 * - Soft close: a bid near the end resets the clock to a few seconds, so an auction only ends
 *   after a quiet moment. Highest bid wins; the money goes to the company treasury.
 * - A player's leading bid is held from their cash until they're outbid or the auction ends.
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
}

export const DEFAULT_AUCTIONS: AuctionConfig = {
  openingRound: true,
  openingClockSec: 30,
  clockSec: 30,
  softCloseSec: 10,
  openingBid: 20,
  minRaise: 2,
  noBidCooldownSec: 60,
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
  opening: boolean;
}

export interface AuctionRequest {
  company: number;
  seller: number | null;
  startedBy: number | 'bank';
}

export type AuctionEvent =
  | { type: 'auctionStart'; t: number; company: number; seller: number | null; opening: boolean; timeLeft: number }
  | { type: 'bid'; t: number; company: number; player: number; amount: number; timeLeft: number }
  | { type: 'auctionWon'; t: number; company: number; player: number; amount: number; seller: number | null }
  | { type: 'auctionNoBids'; t: number; company: number }
  | { type: 'auctionQueued'; t: number; company: number; position: number };

/** Lowest bid that would be accepted right now. */
export function minimumBid(a: Auction, cfg: AuctionConfig): number {
  return a.highBidder === null ? cfg.openingBid : a.highBid + cfg.minRaise;
}
