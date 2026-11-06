/**
 * The share market.
 *
 * Every company has five shares. A share is owned by a player or by the company itself (at the
 * start, the company owns all five). One market per company:
 *
 * - Players' orders: each company has at most one standing bid (a player offering to buy a share
 *   at a price) and one standing ask (a player offering to sell one of theirs). A better price
 *   replaces the order it beats, which is cancelled; an order can be withdrawn at any time. A
 *   bid holds the bidder's cash until it's filled, beaten or withdrawn.
 * - Taking an order: anyone can buy at the standing ask or sell one of their shares to the
 *   standing bid, at once.
 * - The company's bid: a company buys back a share from any player who wants to sell, at
 *   `buybackShare` of its value per share (trucks and factories at what they cost, plus cash,
 *   divided by the number of shares), but only while its cash covers that price. The share it
 *   buys becomes company-owned again.
 * - Sales: anyone can put one of the company's own shares up for sale. A sale is a countdown
 *   (`clockSec`); players bid into the standing bid as usual, and when it ends the share goes to
 *   the standing bid if that is at least the company's minimum price (the same as its bid price,
 *   whether or not it could pay it, so nobody can sell to the company high and buy back cheap).
 *   The money goes to the company. A late bid extends the countdown to `softCloseSec`, but a sale
 *   never lasts more than `maxSec` in all. Several companies' sales can run at once.
 * - Opening round, before the game clock starts: one sale of each company in turn.
 * - Dividends for company-owned shares go into the company's treasury.
 */

export interface AuctionConfig {
  /** Run the opening round (one sale of each company) before the game clock starts. */
  openingRound: boolean;
  /** Seconds on the clock for each opening-round sale. */
  openingClockSec: number;
  /** Seconds on the clock for an in-game sale. */
  clockSec: number;
  /** A bid during a sale with less than this left resets its clock to this. */
  softCloseSec: number;
  /** No sale lasts longer than this in all (seconds), however late the bids come. */
  maxSec: number;
  /** Lowest first bid for a share. */
  openingBid: number;
  /** A new bid must beat the standing bid by at least this (and a new ask undercut the standing ask by it). */
  minRaise: number;
  /** After a sale nobody bid enough in, seconds before that company can hold another. */
  noBidCooldownSec: number;
  /** After a company sells a share (once the game is running), seconds before it can hold another sale. */
  saleCooldownSec: number;
  /** The company's bid for a share, as a fraction of its value per share. Also its minimum sale price. */
  buybackShare: number;
}

export const DEFAULT_AUCTIONS: AuctionConfig = {
  openingRound: true,
  openingClockSec: 30,
  clockSec: 30,
  softCloseSec: 10,
  maxSec: 60,
  openingBid: 0,
  minRaise: 2,
  noBidCooldownSec: 60,
  saleCooldownSec: 60,
  buybackShare: 0.5,
};

/** A standing order: who, and at what price. */
export interface Order {
  player: number;
  price: number;
}

/** A company's standing orders. */
export interface Book {
  bid: Order | null;
  ask: Order | null;
}

/** A sale of one of a company's own shares, counting down. */
export interface Sale {
  company: number;
  /** Who started it: a player, or the bank (opening round / a company nobody owns). */
  startedBy: number | 'bank';
  /** Seconds left on the clock. */
  timeLeft: number;
  /** Seconds it has been running. */
  age: number;
  opening: boolean;
}

export type CancelReason = 'withdrawn' | 'beaten' | 'noShares' | 'noCash';

export type AuctionEvent =
  | { type: 'saleStart'; t: number; company: number; startedBy: number | 'bank'; opening: boolean; timeLeft: number; minPrice: number }
  /** A company sold one of its shares at the end of a sale. */
  | { type: 'saleWon'; t: number; company: number; player: number; amount: number; opening: boolean }
  | { type: 'saleUnsold'; t: number; company: number }
  | { type: 'bidPosted'; t: number; company: number; player: number; price: number }
  | { type: 'askPosted'; t: number; company: number; player: number; price: number }
  | { type: 'orderCancelled'; t: number; company: number; side: 'bid' | 'ask'; player: number; price: number; reason: CancelReason }
  /** A share changed hands at once (an order was taken, or the company bought one back). */
  | { type: 'trade'; t: number; company: number; buyer: number | 'company'; seller: number; price: number };

/** Lowest bid that would stand now: the minimum raise over someone else's bid, else any positive amount. */
export function minimumBid(book: Book, player: number, cfg: AuctionConfig): number {
  if (!book.bid) return cfg.openingBid;
  return book.bid.player === player ? book.bid.price + 1 : book.bid.price + cfg.minRaise;
}

/** A company's value per share and what it would pay for one (whole dollars, rounded down). */
export function shareFloor(cfg: AuctionConfig, assets: number, treasury: number, shares: number): number {
  return Math.max(0, Math.floor((cfg.buybackShare * (assets + Math.max(0, treasury))) / shares));
}
