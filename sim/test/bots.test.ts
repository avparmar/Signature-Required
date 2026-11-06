import { describe, expect, it } from 'vitest';
import { newGame } from '@sr/core';
import { Bot, PERSONALITIES, runGame } from '../src/index.js';

// Bot games are kept short (a few minutes of game time): long enough for shares, trucks,
// deliveries and a couple of dividends, without running a whole 15 minutes.
const SLOW = 60_000;

describe('bots', () => {
  it('play a game: buy shares, buy trucks, deliver, and earn dividends', () => {
    const r = runGame({ seed: 2, durationSec: 360 });
    expect(r.auctions.length).toBeGreaterThan(5);
    expect(r.companies.some((c) => c.trucks > 0)).toBe(true);
    expect(r.companies.reduce((s, c) => s + c.deliveries, 0)).toBeGreaterThan(50);
    expect(r.payouts).toHaveLength(2);
    expect(Math.max(...r.cash)).toBeGreaterThan(100);
  }, SLOW);

  it('are deterministic: same seed, same game', () => {
    const a = runGame({ seed: 4, durationSec: 240 });
    const b = runGame({ seed: 4, durationSec: 240 });
    expect(a).toEqual(b);
  }, SLOW);

  it('value a share above the opening bid at the start, so the opening round sells', () => {
    const g = newGame({ seed: 1 });
    g.step();
    const bot = new Bot(0, g.town, g.cfg, PERSONALITIES.balanced);
    const v = bot.shareValue(g.observe(0), 0, g.cfg.auctions.openingBid);
    expect(v * PERSONALITIES.balanced.greed).toBeGreaterThanOrEqual(g.cfg.auctions.openingBid);
  });

  it('only bid what they can afford and never on shares they are selling', () => {
    const g = newGame({ seed: 1, auctions: { openingBid: 20 } });
    g.step();
    g.players[0].cash = 10;
    const bot = new Bot(0, g.town, g.cfg);
    expect(bot.decide(g.observe(0), []).filter((a) => a.type === 'bid')).toHaveLength(0);
  });

  it('find routes near their depots, shortest first', () => {
    const g = newGame({ seed: 1 });
    const bot = new Bot(0, g.town, g.cfg);
    const routes = bot.routesFor(g.observe(0), 0);
    expect(routes.length).toBeGreaterThan(0);
    for (let i = 1; i < routes.length; i++) expect(routes[i].length).toBeGreaterThanOrEqual(routes[i - 1].length);
    for (const r of routes) {
      const p = g.town.locations[r.producer];
      const c = g.town.locations[r.consumer];
      expect(p.kind).toBe('producer');
      expect(c.kind).toBe('consumer');
      expect(p.good).toBe(c.good);
    }
  });
});

describe('speculator', () => {
  it('values shares optimistically and pays real money for its own company, even with no minimum bid', () => {
    const g = newGame({ seed: 1, auctions: { openingBid: 0 } });
    g.step();
    const spec = new Bot(0, g.town, g.cfg, PERSONALITIES.speculator);
    const inv = new Bot(1, g.town, g.cfg, PERSONALITIES.balanced);
    const obs = g.observe(0);
    expect(spec.shareValue(obs, 0, 0, true)).toBeGreaterThan(inv.shareValue(obs, 0, 0));
    // Run the opening round with just the speculator bidding: its target sells for real money.
    while (g.phase === 'opening') {
      for (const a of spec.decide(g.observe(0), [])) g.act(0, a);
      g.step();
    }
    const bought = g.companies.filter((c) => c.shares.includes(0));
    expect(bought.length).toBeGreaterThan(0);
    expect(bought.some((c) => c.treasury >= PERSONALITIES.speculator.speculator!.assumedSharePrice)).toBe(true);
    // It kept its reserve.
    expect(g.players[0].cash).toBeGreaterThanOrEqual(PERSONALITIES.speculator.speculator!.reserveFrac * g.cfg.startingCash - 1e-9);
  });

  it('revives a no-minimum game: companies get funded and build fleets', () => {
    const r = runGame({ seed: 3, durationSec: 240, auctions: { openingBid: 0 } }, [PERSONALITIES.speculator, PERSONALITIES.balanced, PERSONALITIES.balanced, PERSONALITIES.balanced]);
    expect(r.companies.reduce((s, c) => s + c.trucks, 0)).toBeGreaterThan(2);
    expect(r.auctions.some((a) => a.amount > 0)).toBe(true);
  }, SLOW);
});
