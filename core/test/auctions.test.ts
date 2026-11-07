import { describe, expect, it } from 'vitest';
import { Game, makeGameConfig, newGame, replay, type GameEvent } from '../src/index.js';

const of = (evs: GameEvent[], type: string) => evs.filter((e) => e.type === type);

function stepFor(g: Game, sec: number) {
  const n = Math.round(sec / g.cfg.tickSec);
  for (let i = 0; i < n && !g.done; i++) g.step();
}

/** A running game (opening round skipped) where player 0 owns a share of company 0 and nobody else owns anything. */
function running(shares: (number | null)[] = [0, null, null, null, null]) {
  const g = newGame({ seed: 3, startingTrucks: 0, auctions: { openingRound: false } });
  g.companies[0].shares = [...shares];
  // Everyone else's companies owned by player 3, so the bank doesn't hold sales of its own.
  for (const c of [1, 2, 3, 4]) g.companies[c].shares = [3, 3, 3, 3, 3];
  return g;
}

describe('opening round', () => {
  it('sells one share of each company in turn, 30s each, before the game clock starts', () => {
    const g = newGame({ seed: 3 });
    expect(g.phase).toBe('opening');
    g.step();
    expect(g.sales).toMatchObject([{ company: 0, opening: true }]);
    stepFor(g, 30);
    expect(g.sales[0]?.company).toBe(1);
    expect(g.tick).toBe(0); // the town hasn't started
    stepFor(g, 30 * 4);
    expect(g.phase).toBe('running');
    const evs = g.drainEvents(0);
    expect(of(evs, 'saleStart').map((e) => (e.type === 'saleStart' ? e.company : -1))).toEqual([0, 1, 2, 3, 4]);
    expect(of(evs, 'open')).toHaveLength(1);
  });

  it('the best bid gets the share and its bidder becomes president; the money funds the company', () => {
    const g = newGame({ seed: 3 });
    g.step();
    g.act(1, { type: 'bid', company: 0, amount: 20 });
    g.act(2, { type: 'bid', company: 0, amount: 24 });
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([2, null, null, null, null]);
    expect(g.presidents(0)).toEqual([2]);
    expect(g.companies[0].treasury).toBe(24);
    expect(g.players[2].cash).toBe(g.cfg.startingCash - 24);
    expect(g.players[1].held).toBe(0);
  });

  it('only the company being sold takes bids', () => {
    const g = newGame({ seed: 3 });
    g.step();
    g.act(1, { type: 'bid', company: 2, amount: 20 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
  });

  it('a company nobody bids on stays unowned, and is offered again later', () => {
    const g = newGame({ seed: 3 });
    stepFor(g, 152);
    expect(g.phase).toBe('running');
    expect(g.companies[0].shares.every((s) => s === null)).toBe(true);
    // Its cooldown has long run out by the time the game starts, so the bank offers it at once.
    expect(g.sales.some((x) => x.company === 0 && x.startedBy === 'bank')).toBe(true);
  });
});

describe('bids', () => {
  it('a new bid must beat the standing one by $2; the beaten bid is cancelled and its cash released', () => {
    const g = running();
    g.act(1, { type: 'bid', company: 0, amount: 10 });
    g.act(2, { type: 'bid', company: 0, amount: 11 }); // not enough
    g.act(2, { type: 'bid', company: 0, amount: 12 });
    g.step();
    expect(of(g.drainEvents(2), 'rejected')).toHaveLength(1);
    expect(g.books[0].bid).toEqual({ player: 2, price: 12 });
    expect(g.players[1].held).toBe(0);
    expect(g.players[2].held).toBe(12);
    const cancelled = of(g.drainEvents(1), 'orderCancelled');
    expect(cancelled).toMatchObject([{ player: 1, side: 'bid', reason: 'beaten' }]);
  });

  it('you can raise your own bid, and withdraw it', () => {
    const g = running();
    g.act(1, { type: 'bid', company: 0, amount: 10 });
    g.act(1, { type: 'bid', company: 0, amount: 11 });
    g.step();
    expect(g.books[0].bid).toEqual({ player: 1, price: 11 });
    expect(g.players[1].held).toBe(11);
    g.act(1, { type: 'cancelOrder', company: 0, side: 'bid' });
    g.step();
    expect(g.books[0].bid).toBeNull();
    expect(g.players[1].held).toBe(0);
  });

  it("can't bid more than you have free", () => {
    const g = running();
    g.act(1, { type: 'bid', company: 0, amount: g.cfg.startingCash + 1 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    expect(g.books[0].bid).toBeNull();
  });
});

describe('sales of company shares', () => {
  it('anyone can start one; when it ends, the standing bid gets the share and the company the money', () => {
    const g = running();
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    expect(g.sales).toMatchObject([{ company: 0, startedBy: 1 }]);
    g.act(1, { type: 'bid', company: 0, amount: 25 });
    g.act(0, { type: 'bid', company: 0, amount: 27 }); // the president outbids them to keep control
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([0, 0, null, null, null]);
    expect(g.companies[0].treasury).toBe(27);
    expect(g.books[0].bid).toBeNull();
  });

  it("a bid made before the sale counts; below the company's minimum price, the share stays unsold", () => {
    const g = running();
    g.companies[0].assets = 300; // the minimum is $30
    g.act(1, { type: 'bid', company: 0, amount: 25 }); // below it: refused
    g.act(1, { type: 'bid', company: 0, amount: 40 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    g.companies[0].assets = 500; // value per share $100, so the minimum is now $50
    expect(g.minPrice(0)).toBe(50);
    g.act(1, { type: 'startSale', company: 0 });
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([0, null, null, null, null]);
    expect(of(g.drainEvents(1), 'saleUnsold')).toHaveLength(1);
    expect(g.books[0].bid).toEqual({ player: 1, price: 40 }); // still standing
    // Nobody bid enough: a minute before the next sale.
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
  });

  it('one sale per company at a time, but several companies at once', () => {
    const g = running([0, null, null, null, null]);
    g.companies[1].shares = [3, null, null, null, null];
    g.act(1, { type: 'startSale', company: 0 });
    g.act(2, { type: 'startSale', company: 0 });
    g.act(2, { type: 'startSale', company: 1 });
    g.step();
    expect(of(g.drainEvents(2), 'rejected')).toHaveLength(1);
    expect(g.sales.map((x) => x.company)).toEqual([0, 1]);
  });

  it('after a share sells, the company waits a minute before its next sale', () => {
    const g = running();
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    g.act(1, { type: 'bid', company: 0, amount: 5 });
    stepFor(g, 31);
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    stepFor(g, 60);
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    expect(g.sales).toHaveLength(1);
  });

  it('late bids add time, but a sale never runs past 60s in all', () => {
    const g = running();
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    let amount = 2;
    let bidder = 1;
    let steps = 0;
    for (; steps < 2000 && g.sales.length; steps++) {
      if (g.sales[0].timeLeft < 2) {
        g.act(bidder, { type: 'bid', company: 0, amount });
        amount += 2;
        bidder = 3 - bidder;
      }
      g.step();
    }
    expect(steps * g.cfg.tickSec).toBeGreaterThan(40); // the bids did extend it past its 30s clock
    expect(steps * g.cfg.tickSec).toBeLessThanOrEqual(60);
    expect(g.drainEvents(0).some((e) => e.type === 'saleWon' && e.company === 0)).toBe(true);
  });

  it('ends at once when everyone but the highest bidder has passed; a new bid clears the passes', () => {
    const g = running();
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    g.act(1, { type: 'bid', company: 0, amount: 10 });
    g.act(0, { type: 'pass', company: 0 });
    g.act(2, { type: 'pass', company: 0 });
    g.step();
    g.act(2, { type: 'bid', company: 0, amount: 12 }); // clears the passes
    g.step();
    expect(g.sales[0].passed).toEqual([]);
    g.act(1, { type: 'pass', company: 0 });
    g.act(0, { type: 'pass', company: 0 });
    g.act(3, { type: 'pass', company: 0 });
    g.step();
    expect(g.sales).toHaveLength(0); // over well before its 30s
    expect(g.companies[0].shares).toEqual([0, 2, null, null, null]);
    expect(g.companies[0].treasury).toBe(12);
  });

  it("the highest bidder can't pass, and everyone passing with no bids ends it unsold", () => {
    const g = running();
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    for (const p of [0, 1, 2, 3]) g.act(p, { type: 'pass', company: 0 });
    g.step();
    expect(g.sales).toHaveLength(0);
    expect(of(g.drainEvents(0), 'saleUnsold')).toHaveLength(1);
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    g.act(2, { type: 'startSale', company: 0 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1); // cooldown after an unsold sale
  });

  it("can't start one while the company has no shares of its own", () => {
    const g = running([0, 0, 1, 1, 2]);
    g.act(1, { type: 'startSale', company: 0 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
  });
});

describe('trading between players', () => {
  it('an ask: anyone can buy at that price; the seller gets the money', () => {
    const g = running([0, 1, null, null, null]);
    g.act(1, { type: 'ask', company: 0, price: 30 });
    g.step();
    g.act(2, { type: 'buy', company: 0 });
    g.step();
    expect(g.companies[0].shares).toEqual([0, 2, null, null, null]);
    expect(g.players[1].cash).toBe(g.cfg.startingCash + 30);
    expect(g.players[2].cash).toBe(g.cfg.startingCash - 30);
    expect(g.books[0].ask).toBeNull();
  });

  it('selling to a standing bid', () => {
    const g = running([0, 1, null, null, null]);
    g.act(2, { type: 'bid', company: 0, amount: 20 });
    g.step();
    g.act(1, { type: 'sell', company: 0, to: 'bid' });
    g.step();
    expect(g.companies[0].shares).toEqual([0, 2, null, null, null]);
    expect(g.players[1].cash).toBe(g.cfg.startingCash + 20);
    expect(g.players[2].cash).toBe(g.cfg.startingCash - 20);
    expect(g.players[2].held).toBe(0);
  });

  it('a lower ask replaces the standing one; asks must stay above the best bid', () => {
    const g = running([0, 1, 2, null, null]);
    g.act(1, { type: 'ask', company: 0, price: 30 });
    g.act(2, { type: 'ask', company: 0, price: 29 }); // must undercut by $2
    g.act(2, { type: 'ask', company: 0, price: 28 });
    g.act(3, { type: 'bid', company: 0, amount: 20 });
    g.act(0, { type: 'ask', company: 0, price: 20 }); // at the bid: sell instead
    g.step();
    expect(g.books[0].ask).toEqual({ player: 2, price: 28 });
    expect(of(g.drainEvents(1), 'orderCancelled')).toMatchObject([{ player: 1, side: 'ask', reason: 'beaten' }]);
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    // And a bid can't reach the ask: buy instead.
    g.act(3, { type: 'bid', company: 0, amount: 28 });
    g.step();
    expect(of(g.drainEvents(3), 'rejected')).toHaveLength(1);
  });

  it("during the company's own sale, nobody can sell their share to its bid", () => {
    const g = running([0, 1, null, null, null]);
    g.act(2, { type: 'startSale', company: 0 });
    g.step();
    g.act(2, { type: 'bid', company: 0, amount: 20 });
    g.step();
    g.act(1, { type: 'sell', company: 0, to: 'bid' });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([0, 1, 2, null, null]); // the company's share went to the bidder
    expect(g.companies[0].treasury).toBe(20);
  });

  it("an ask goes when its owner has no share left to sell", () => {
    const g = running([0, 1, null, null, null]);
    g.act(1, { type: 'ask', company: 0, price: 30 });
    g.act(2, { type: 'bid', company: 0, amount: 10 });
    g.step();
    g.act(1, { type: 'sell', company: 0, to: 'bid' });
    g.step();
    expect(g.books[0].ask).toBeNull();
  });
});

describe('the company buys back', () => {
  it('at half its value per share, only while its cash covers that; the share becomes its own again', () => {
    const g = running([0, 1, 1, null, null]);
    const c = g.companies[0];
    c.assets = 400;
    c.treasury = 40; // value $440: $88 a share, so it would pay $44, but has only $40
    g.step();
    expect(g.observe(1).companyBid[0]).toBeNull();
    g.act(1, { type: 'sell', company: 0, to: 'company' });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    c.treasury = 100; // value $500: pays $50
    g.act(1, { type: 'sell', company: 0, to: 'company' });
    g.step();
    expect(c.shares).toEqual([0, null, 1, null, null]);
    expect(c.treasury).toBe(50);
    expect(g.players[1].cash).toBe(g.cfg.startingCash + 50);
    // Its value dropped by what it paid, so the next one is a little cheaper: $450 / 5 / 2 = $45.
    expect(g.observe(1).companyBid[0]).toBe(45);
  });

  it('dividends on shares the company owns go into its treasury', () => {
    const g = running([0, 0, null, null, null]);
    g.companies[0].pot = 50;
    const before = g.companies[0].treasury;
    stepFor(g, g.cfg.money.payoutEverySec);
    expect(g.players[0].cash).toBe(g.cfg.startingCash + 20);
    expect(g.companies[0].treasury - before).toBeGreaterThanOrEqual(30); // 3 of 5 parts (plus any deliveries)
  });
});

describe('determinism with the market', () => {
  it('replays an opening round with bids exactly', () => {
    const cfg = makeGameConfig({ seed: 11, durationSec: 60 });
    const g = new Game(cfg);
    g.step();
    g.act(1, { type: 'bid', company: 0, amount: 20 });
    g.act(2, { type: 'bid', company: 0, amount: 24 });
    stepFor(g, 40);
    g.act(3, { type: 'bid', company: 1, amount: 5 });
    g.runToEnd(200);
    const r = replay(cfg, g.actionLog);
    // Replay runs to the end; compare against the original run to the end too.
    g.runToEnd();
    expect(r.stateHash()).toBe(g.stateHash());
    void newGame;
  });
});
