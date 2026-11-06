import { describe, expect, it } from 'vitest';
import { Game, makeGameConfig, newGame, replay, type GameEvent } from '../src/index.js';

const of = (evs: GameEvent[], type: string) => evs.filter((e) => e.type === type);

function stepFor(g: Game, sec: number) {
  const n = Math.round(sec / g.cfg.tickSec);
  for (let i = 0; i < n && !g.done; i++) g.step();
}

/** A running game (opening round skipped) where player 0 owns shares of company 0. */
function running(shares: (number | null)[] = [0, null, null, null, null]) {
  const g = newGame({ seed: 3, auctions: { openingRound: false, openingBid: 20 } });
  g.companies[0].shares = [...shares];
  return g;
}

describe('opening round', () => {
  it('auctions one share of each company in turn, 30s each, before the game clock starts', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    expect(g.phase).toBe('opening');
    g.step();
    expect(g.auction).toMatchObject({ company: 0, opening: true, seller: null });
    stepFor(g, 30);
    expect(g.auction?.company).toBe(1);
    expect(g.tick).toBe(0); // the town hasn't started
    stepFor(g, 30 * 4);
    expect(g.phase).toBe('running');
    expect(g.tick).toBeGreaterThanOrEqual(0);
    const evs = g.drainEvents(0);
    expect(of(evs, 'auctionStart').map((e) => (e.type === 'auctionStart' ? e.company : -1))).toEqual([0, 1, 2, 3, 4]);
    expect(of(evs, 'open')).toHaveLength(1);
  });

  it('the winner gets the share and becomes president; the money funds the company', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    g.act(1, { type: 'bid', company: 0, amount: 20 });
    g.act(2, { type: 'bid', company: 0, amount: 24 });
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([2, null, null, null, null]);
    expect(g.presidents(0)).toEqual([2]);
    expect(g.companies[0].treasury).toBe(24);
    expect(g.players[2].cash).toBe(g.cfg.startingCash - 24);
    expect(g.players[1].cash).toBe(g.cfg.startingCash);
    expect(g.players[1].held).toBe(0);
  });

  it('a company nobody bids on stays with the bank', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    stepFor(g, 31);
    expect(g.companies[0].shares.every((s) => s === null)).toBe(true);
    expect(of(g.drainEvents(0), 'auctionNoBids')).toHaveLength(1);
  });
});

describe('bidding', () => {
  it('needs the opening bid first, then raises of at least $2', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    g.act(0, { type: 'bid', company: 0, amount: 19 });
    g.act(0, { type: 'bid', company: 0, amount: 20 });
    g.act(1, { type: 'bid', company: 0, amount: 21 });
    g.act(1, { type: 'bid', company: 0, amount: 22 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    expect(g.auction).toMatchObject({ highBid: 22, highBidder: 1 });
  });

  it('holds the leading bid from your cash and releases it when you are outbid', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    g.act(0, { type: 'bid', company: 0, amount: 90 });
    g.step();
    expect(g.players[0].held).toBe(90);
    // Can't spend held money elsewhere.
    const producer = g.town.locations.find((l) => l.kind === 'producer')!;
    g.act(0, { type: 'invest', location: producer.id });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    g.act(1, { type: 'bid', company: 0, amount: 92 });
    g.step();
    expect(g.players[0].held).toBe(0);
    expect(g.players[1].held).toBe(92);
  });

  it("can't bid more than you have, but can raise your own lead using it", () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    g.act(0, { type: 'bid', company: 0, amount: 101 });
    g.act(0, { type: 'bid', company: 0, amount: 60 });
    g.act(0, { type: 'bid', company: 0, amount: 100 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    expect(g.players[0].held).toBe(100);
  });

  it('soft close: a late bid resets the clock to 10s', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    stepFor(g, 25);
    g.act(0, { type: 'bid', company: 0, amount: 20 });
    g.step();
    expect(g.auction!.timeLeft).toBeCloseTo(10, 0);
    stepFor(g, 9);
    g.act(1, { type: 'bid', company: 0, amount: 22 });
    stepFor(g, 9.5);
    expect(g.auction?.company).toBe(0); // still going
    stepFor(g, 1);
    expect(g.companies[0].shares[0]).toBe(1);
  });

  it('late bids add time, but an auction never runs past 60s in all', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    let amount = 20;
    let bidder = 1;
    // Keep bidding in the last couple of seconds, forever.
    let steps = 0;
    for (; steps < 2000 && g.auction?.company === 0; steps++) {
      if (g.auction.timeLeft < 2) {
        g.act(bidder, { type: 'bid', company: 0, amount });
        amount += 2;
        bidder = 3 - bidder;
      }
      g.step();
    }
    expect(g.auction?.company).toBe(1);
    expect(steps * g.cfg.tickSec).toBeGreaterThan(40); // the bids did extend it past its 30s clock
    expect(steps * g.cfg.tickSec).toBeLessThanOrEqual(60 + g.cfg.tickSec);
    expect(g.drainEvents(0).some((e) => e.type === 'auctionWon' && e.company === 0)).toBe(true);
  });

  it('rejects bids for a company that is not being auctioned', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.step();
    g.act(0, { type: 'bid', company: 2, amount: 20 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
  });
});

describe('in-game auctions', () => {
  it('a president can auction a bank-held share; others need to open the bidding', () => {
    const g = running();
    g.act(1, { type: 'startAuction', company: 0 });
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    expect(g.auction).toMatchObject({ company: 0, seller: null, startedBy: 0, timeLeft: expect.any(Number) });
    g.act(0, { type: 'bid', company: 0, amount: 30 }); // presidents may bid too
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([0, 0, null, null, null]);
    expect(g.companies[0].treasury).toBe(30);
  });

  it('anyone can put up a bank share by opening the bidding; the president can outbid them', () => {
    const g = running();
    g.act(1, { type: 'startAuction', company: 0, bid: 10 }); // below the opening bid ($20 here)
    g.act(1, { type: 'startAuction', company: 0, bid: 25 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    expect(g.auction).toMatchObject({ company: 0, seller: null, startedBy: 1, highBid: 25, highBidder: 1 });
    expect(g.players[1].held).toBe(25);
    g.act(0, { type: 'bid', company: 0, amount: 27 });
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([0, 0, null, null, null]);
    expect(g.companies[0].treasury).toBe(27);
    expect(g.players[1].held).toBe(0);
  });

  it("a rival's opening bid wins if nobody beats it", () => {
    const g = running();
    g.act(1, { type: 'startAuction', company: 0, bid: 20 });
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([0, 1, null, null, null]);
    expect(g.presidents(0)).toEqual([0, 1]); // tied: co-presidents
  });

  it("a rival can't open with more than they have, and loses their place if they spend it while queued", () => {
    const g = running();
    for (const c of [2, 3, 4]) g.companies[c].shares = [3, 3, 3, 3, 3]; // nothing else for the bank to offer
    g.act(1, { type: 'startAuction', company: 0, bid: g.players[1].cash + 1 });
    g.step();
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
    // Company 1 is being auctioned; player 1 queues an offer for company 0, then bids its cash away.
    g.companies[1].shares = [2, null, null, null, null];
    g.act(2, { type: 'startAuction', company: 1 });
    g.step();
    g.act(1, { type: 'startAuction', company: 0, bid: 20 });
    g.act(1, { type: 'bid', company: 1, amount: g.players[1].cash });
    stepFor(g, 31);
    expect(g.auction).toBeNull();
    const evs = g.drainEvents(1);
    expect(of(evs, 'rejected').length).toBeGreaterThanOrEqual(1);
    expect(of(evs, 'auctionStart').some((e) => e.type === 'auctionStart' && e.company === 0)).toBe(false);
    expect(g.elapsed).toBeGreaterThanOrEqual(g.auctionCooldownUntil[0]); // no cooldown for company 0
  });

  it('runs one auction at a time; requests wait in line, one per company', () => {
    const g = running();
    g.companies[1].shares = [1, null, null, null, null];
    g.act(0, { type: 'startAuction', company: 0 });
    g.act(1, { type: 'startAuction', company: 1 });
    g.act(0, { type: 'startAuction', company: 0 }); // already running: refused
    g.step();
    expect(g.auction?.company).toBe(0);
    expect(g.auctionQueue.map((r) => r.company)).toContain(1);
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    stepFor(g, 31);
    expect(g.auction?.company).not.toBe(0);
  });

  it('no bids: 60s cooldown before that company can try again', () => {
    const g = running();
    g.act(0, { type: 'startAuction', company: 0 });
    stepFor(g, 31);
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    stepFor(g, 60);
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(0);
  });

  it('after a share sells, the company waits before auctioning another', () => {
    const g = running();
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    g.act(1, { type: 'bid', company: 0, amount: 30 });
    stepFor(g, 31);
    expect(g.companies[0].shares.filter((s) => s === 1)).toHaveLength(1);
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    stepFor(g, g.cfg.auctions.saleCooldownSec);
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(0);
  });

  it('the bank re-offers a company nobody owns', () => {
    const g = running([0, null, null, null, null]);
    // Companies 1-4 are unowned; the bank auctions them one after another.
    stepFor(g, 1);
    expect(g.auction?.startedBy).toBe('bank');
    expect(g.auction?.company).toBe(1);
  });

  it('once all shares are out, a shareholder can sell one of theirs; the money goes to the company', () => {
    const g = running([0, 0, 1, 2, 3]);
    for (let c = 1; c < 5; c++) g.companies[c].shares = [1, 1, 1, 1, 1]; // stop the bank auctioning others
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(g.auction).toMatchObject({ company: 0, seller: 0 });
    g.act(0, { type: 'bid', company: 0, amount: 20 }); // can't bid on your own share
    g.act(2, { type: 'bid', company: 0, amount: 26 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    stepFor(g, 31);
    expect(g.companies[0].shares).toEqual([2, 0, 1, 2, 3]);
    expect(g.companies[0].treasury).toBe(26);
    expect(g.players[0].cash).toBe(g.cfg.startingCash); // the seller gets nothing
    expect(g.presidents(0)).toEqual([2]); // selling cost player 0 the presidency
  });

  it("can't start auctions during the opening round", () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 20 } });
    g.companies[0].shares = [0, null, null, null, null];
    g.act(0, { type: 'startAuction', company: 0 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
  });
});

describe('determinism with auctions', () => {
  it('replays an opening round with bids exactly', () => {
    const cfg = makeGameConfig({ seed: 5, durationSec: 30, auctions: { openingBid: 20 } });
    const g = new Game(cfg);
    let k = 0;
    while (!g.done) {
      if (g.auction && g.steps % 40 === 0) g.act(k++ % 4, { type: 'bid', company: g.auction.company, amount: 20 + 2 * k });
      g.step();
    }
    const r = replay(cfg, g.actionLog);
    expect(r.stateHash()).toEqual(g.stateHash());
    expect(g.companies.some((c) => c.shares.some((s) => s !== null))).toBe(true);
  });
});

describe('passing', () => {
  it('ends the auction at once when everyone but the high bidder has passed', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 0 } });
    g.step();
    expect(g.auction?.company).toBe(0);
    g.act(0, { type: 'bid', company: 0, amount: 10 });
    g.act(1, { type: 'pass', company: 0 });
    g.act(2, { type: 'pass', company: 0 });
    g.step();
    expect(g.auction?.company).toBe(0); // player 3 hasn't passed yet
    g.act(3, { type: 'pass', company: 0 });
    g.step();
    g.step();
    expect(g.auction?.company).toBe(1); // sold; the next one started
    expect(g.companies[0].shares).toContain(0);
    expect(of(g.drainEvents(0), 'auctionWon')).toHaveLength(1);
  });

  it('a new bid clears the passes, so the others can answer it', () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 0 } });
    g.step();
    g.act(0, { type: 'bid', company: 0, amount: 10 });
    g.act(1, { type: 'pass', company: 0 });
    g.act(2, { type: 'pass', company: 0 });
    g.step();
    g.act(3, { type: 'bid', company: 0, amount: 12 });
    g.step();
    expect(g.auction?.passed).toEqual([]);
    g.act(1, { type: 'pass', company: 0 });
    g.act(2, { type: 'pass', company: 0 });
    g.step();
    expect(g.auction?.company).toBe(0); // player 0 may still answer
  });

  it("the high bidder can't pass, and everyone passing with no bids ends it unsold", () => {
    const g = newGame({ seed: 3, auctions: { openingBid: 0 } });
    g.step();
    g.act(0, { type: 'bid', company: 0, amount: 5 });
    g.act(0, { type: 'pass', company: 0 });
    g.step();
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    const h = newGame({ seed: 3, auctions: { openingBid: 0 } });
    h.step();
    for (let p = 0; p < h.cfg.players; p++) h.act(p, { type: 'pass', company: 0 });
    h.step();
    h.step();
    expect(of(h.drainEvents(0), 'auctionNoBids')).toHaveLength(1);
  });
});
