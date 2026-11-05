import { describe, expect, it } from 'vitest';
import { newGame } from '@sr/core';
import { Bot, PERSONALITIES, runGame } from '../src/index.js';

describe('bots', () => {
  it('play a whole game: buy shares, buy trucks, deliver, and earn dividends', () => {
    const r = runGame({ seed: 2 });
    expect(r.auctions.length).toBeGreaterThan(5);
    expect(r.companies.some((c) => c.trucks > 0)).toBe(true);
    expect(r.companies.reduce((s, c) => s + c.deliveries, 0)).toBeGreaterThan(50);
    expect(r.payouts).toHaveLength(5);
    expect(Math.max(...r.cash)).toBeGreaterThan(100);
  });

  it('are deterministic: same seed, same game', () => {
    const a = runGame({ seed: 4, durationSec: 240 });
    const b = runGame({ seed: 4, durationSec: 240 });
    expect(a).toEqual(b);
  });

  it('value a share above the opening bid at the start, so the opening round sells', () => {
    const g = newGame({ seed: 1 });
    g.step();
    const bot = new Bot(0, g.town, g.cfg, PERSONALITIES.balanced);
    const v = bot.shareValue(g.observe(0), 0, g.cfg.auctions.openingBid);
    expect(v * PERSONALITIES.balanced.greed).toBeGreaterThanOrEqual(g.cfg.auctions.openingBid);
  });

  it('only bid what they can afford and never on shares they are selling', () => {
    const g = newGame({ seed: 1 });
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
