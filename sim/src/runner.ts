/** Play whole games headless with bots in every seat, and summarise them. */
import { Game, makeGameConfig, Rng, type GameConfigOverrides } from '@sr/core';
import { Bot, PERSONALITIES, type BotPersonality } from './bot.js';

export interface GameResult {
  seed: number;
  /** Final cash per player. */
  cash: number[];
  winner: number;
  /** Per company: deliveries, trucks, depots, treasury, shares sold. */
  companies: { deliveries: number; trucks: number; depots: number; treasury: number; sharesSold: number; owners: (number | null)[] }[];
  /** Winning bids, in order. */
  auctions: { t: number; company: number; amount: number; opening: boolean }[];
  /** Dividends paid in total, per payout (5 entries for a 15-minute game). */
  payouts: number[];
  /** Minute by which all 25 shares had been sold, or null. */
  soldOutAt: number | null;
  locationsGrown: number;
  locationsShrunk: number;
}

export function runGame(overrides: GameConfigOverrides, personalities: BotPersonality[] = []): GameResult {
  const cfg = makeGameConfig(overrides);
  const g = new Game(cfg);
  const bots = Array.from({ length: cfg.players }, (_, p) => new Bot(p, g.town, cfg, personalities[p] ?? PERSONALITIES.balanced));
  const deliveries = new Array(cfg.companies).fill(0);
  const auctions: GameResult['auctions'] = [];
  const payouts: number[] = [];
  let soldOutAt: number | null = null;
  let payoutRound = -1;
  let lastPayoutT = -1;

  const pending: Map<number, ReturnType<Game['drainEvents']>> = new Map(bots.map((b) => [b.me, []]));
  const thinkSteps = Math.max(1, Math.round(1 / cfg.tickSec));
  const orderRng = new Rng(cfg.seed * 31 + 7);
  while (!g.done) {
    // Shuffle who acts first each step, so no seat systematically wins ties (e.g. two bots bidding
    // the same minimum in the same step).
    const order = orderRng.shuffle([...bots]);
    // Bots answer auctions every step; otherwise they look once a second (much faster).
    const look = g.auction !== null || g.steps % thinkSteps === 0;
    for (const bot of order) {
      pending.get(bot.me)!.push(...g.drainEvents(bot.me));
      if (!look) continue;
      const events = pending.get(bot.me)!;
      pending.set(bot.me, []);
      if (bot.me === 0) {
        for (const e of events) {
          if (e.type === 'delivered') deliveries[e.company]++;
          if (e.type === 'auctionWon') auctions.push({ t: e.t, company: e.company, amount: e.amount, opening: g.phase === 'opening' || e.t === 0 });
          if (e.type === 'payout') {
            if (e.t !== lastPayoutT) {
              payoutRound++;
              lastPayoutT = e.t;
              payouts.push(0);
            }
            payouts[payoutRound] += Object.values(e.paid).reduce((a, b) => a + b, 0);
          }
        }
      }
      for (const a of bot.decide(g.observe(bot.me), events)) g.act(bot.me, a);
    }
    g.step();
    if (soldOutAt === null && g.companies.every((c) => c.shares.every((s) => s !== null))) soldOutAt = g.t / 60;
  }
  // Events from the final step (last payout).
  for (const e of g.drainEvents(0)) {
    if (e.type === 'payout') {
      if (e.t !== lastPayoutT) {
        payoutRound++;
        lastPayoutT = e.t;
        payouts.push(0);
      }
      payouts[payoutRound] += Object.values(e.paid).reduce((a, b) => a + b, 0);
    }
  }
  const cash = g.players.map((p) => p.cash);
  return {
    seed: cfg.seed,
    cash,
    winner: cash.indexOf(Math.max(...cash)),
    companies: g.companies.map((c) => ({
      deliveries: deliveries[c.id],
      trucks: g.trucks.trucks.filter((t) => t.company === c.id).length,
      depots: g.depotsOf(c.id).length,
      treasury: c.treasury,
      sharesSold: c.shares.filter((s) => s !== null).length,
      owners: [...c.shares],
    })),
    auctions,
    payouts,
    soldOutAt,
    locationsGrown: g.locations.filter((l) => l.growth > 0).length,
    locationsShrunk: g.locations.filter((l) => l.growth < 0).length,
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Run a batch and print a summary. */
export function runBatch(label: string, games: number, overrides: GameConfigOverrides = {}, personalities: BotPersonality[] = [], baseSeed = 1) {
  const results: GameResult[] = [];
  for (let i = 0; i < games; i++) results.push(runGame({ ...overrides, seed: baseSeed + i }, personalities));
  const n = results[0].cash.length;
  const wins = new Array(n).fill(0);
  for (const r of results) wins[r.winner]++;
  const opening = results.flatMap((r) => r.auctions.filter((a) => a.opening).map((a) => a.amount));
  const later = results.flatMap((r) => r.auctions.filter((a) => !a.opening).map((a) => a.amount));
  const sold = results.map((r) => r.companies.reduce((s, c) => s + c.sharesSold, 0));
  const soldOut = results.filter((r) => r.soldOutAt !== null).map((r) => r.soldOutAt!);
  console.log(`\n== ${label} (${games} games) ==`);
  console.log(`final cash per seat: ${Array.from({ length: n }, (_, p) => `$${avg(results.map((r) => r.cash[p])).toFixed(0)}`).join('  ')}   (started with $${makeGameConfig(overrides).startingCash})`);
  console.log(`wins per seat: ${wins.join(' / ')}`);
  console.log(`shares sold: ${avg(sold).toFixed(1)} of 25; all sold in ${soldOut.length}/${games} games${soldOut.length ? `, by minute ${avg(soldOut).toFixed(1)} on average` : ''}`);
  console.log(`winning bids: opening round avg $${avg(opening).toFixed(0)} (${opening.length} sold), in-game avg $${avg(later).toFixed(0)} (${later.length} sold)`);
  const payouts = Array.from({ length: 5 }, (_, k) => avg(results.map((r) => r.payouts[k] ?? 0)));
  console.log(`dividends paid per payout (all players): ${payouts.map((x) => `$${x.toFixed(0)}`).join(' -> ')}`);
  const fleets = results.flatMap((r) => r.companies.map((c) => c.trucks));
  const depots = results.flatMap((r) => r.companies.map((c) => c.depots));
  const deliveries = results.flatMap((r) => r.companies.map((c) => c.deliveries));
  console.log(`per company: ${avg(fleets).toFixed(1)} trucks, ${avg(depots).toFixed(1)} depots, ${avg(deliveries).toFixed(0)} deliveries; max fleet ${Math.max(...fleets)}`);
  console.log(`locations grown ${avg(results.map((r) => r.locationsGrown)).toFixed(1)}, shrunk ${avg(results.map((r) => r.locationsShrunk)).toFixed(1)}`);
  return results;
}
