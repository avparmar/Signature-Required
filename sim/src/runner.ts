/** Play whole games headless with bots in every seat, and summarise them. */
import { Game, distancesFrom, makeGameConfig, Rng, type GameConfigOverrides } from '@sr/core';
import { Bot, PERSONALITIES, type BotPersonality } from './bot.js';

export interface GameResult {
  seed: number;
  /** Final cash per player. */
  cash: number[];
  winner: number;
  /** Per company: deliveries, trucks, depots, treasury, shares sold. */
  companies: {
    deliveries: number;
    trucks: number;
    depots: number;
    treasury: number;
    sharesSold: number;
    owners: (number | null)[];
    /** Everything one share of this company paid out over the game (dividends + final bonus). */
    paidPerShare: number;
    /** Of which, the final bonus. */
    bonusPerShare: number;
    /** Average winning bid for this company's shares. */
    avgPrice: number;
  }[];
  /** Winning bids, in order. */
  auctions: { t: number; company: number; amount: number; opening: boolean }[];
  /** Dividends paid in total, per payout (5 entries for a 15-minute game). */
  payouts: number[];
  /** Minute by which all 25 shares had been sold, or null. */
  soldOutAt: number | null;
  locationsGrown: number;
  locationsShrunk: number;
  opened: number;
  closed: number;
  /** Territory: how contested locations were, sampled once a minute. */
  territory: {
    /** Of locations served at all, the share served by more than one company. */
    contestedShare: number;
    /** How often a location's main server changed between consecutive minutes (per location-minute). */
    handoverRate: number;
    /** Average drive distance (blocks) from a route's depot to its producer, over all routes. */
    avgReach: number;
  };
  /** Loading bays: average trucks waiting (queued, not loading) per busy building, and max queue seen. */
  bays: { avgWaiting: number; maxQueue: number; waitingShare: number };
  /**
   * Shared producers: of producers loaded by two or more companies, how evenly the top two split
   * the pallets (smaller ÷ (both)), averaged; 0.5 is an even split. Plus how many such producers.
   */
  sharing: { split: number; producers: number };
  /** Pallets delivered, all companies. */
  delivered: number;
  /** Trucks and depots bought in the last 3 minutes of the game, and $ spent on them. */
  lateBuys: { count: number; spent: number };
  /** Depot sites bought during the game: how many, average price, and how many below full price. */
  depotBuys: { count: number; avgPrice: number; discounted: number };
  /** Location investment: level-ups bought, and $ spent, across all players. */
  invested: { count: number; spent: number };
}

/**
 * Default table: one speculator and the rest balanced investors. With no minimum bid, a table
 * of only cautious investors never funds a company (see the #22 experiments); one bold player
 * is enough to get the economy going, which is what we expect of humans too.
 */
export function defaultTable(players: number): BotPersonality[] {
  return Array.from({ length: players }, (_, p) => (p === 0 ? PERSONALITIES.speculator : p === 1 ? PERSONALITIES.controller : PERSONALITIES.balanced));
}

export function runGame(overrides: GameConfigOverrides, personalities: BotPersonality[] = [], onStep?: (g: Game) => void): GameResult {
  const cfg = makeGameConfig(overrides);
  const g = new Game(cfg);
  const table = personalities.length ? personalities : defaultTable(cfg.players);
  const bots = Array.from({ length: cfg.players }, (_, p) => new Bot(p, g.town, cfg, table[p] ?? PERSONALITIES.balanced));
  const deliveries = new Array(cfg.companies).fill(0);
  const paidPerShare = new Array(cfg.companies).fill(0);
  let opened = 0;
  let closed = 0;
  let investCount = 0;
  let investSpent = 0;
  // Territory samples: per minute, for each location, the company with most trucks routed to it.
  const mainServer: Map<number, number>[] = [];
  let contested = 0;
  let servedAny = 0;
  let reachSum = 0;
  let reachN = 0;
  // Bays: sample queues every 5 seconds.
  let waitingSum = 0;
  let waitingSamples = 0;
  let maxQueue = 0;
  let waitingTrucks = 0;
  let sampledTrucks = 0;
  const bonusPerShare = new Array(cfg.companies).fill(0);
  const auctions: GameResult['auctions'] = [];
  const payouts: number[] = [];
  let soldOutAt: number | null = null;
  let payoutRound = -1;
  let lastPayoutT = -1;

  const buys: number[] = [];
  const late = { count: 0, spent: 0 };
  const loadsAt = new Map<number, Map<number, number>>();
  const record = (events: ReturnType<Game['drainEvents']>, phase: string) => {
    for (const e of events) {
      if (e.type === 'loaded') {
        const m = loadsAt.get(e.location) ?? new Map<number, number>();
        m.set(e.company, (m.get(e.company) ?? 0) + 1);
        loadsAt.set(e.location, m);
      }
      if (e.type === 'boughtDepot') buys.push(e.price);
      if ((e.type === 'boughtDepot' || e.type === 'boughtTruck') && e.t > g.cfg.durationSec - 180) {
        late.count++;
        late.spent += e.price;
      }
      if (e.type === 'delivered') deliveries[e.company]++;
      if (e.type === 'opened') opened++;
      if (e.type === 'invested') {
        investCount++;
        investSpent += e.price;
      }
      if (e.type === 'closed') closed++;
      if (e.type === 'auctionWon') auctions.push({ t: e.t, company: e.company, amount: e.amount, opening: phase === 'opening' });
      if (e.type === 'payout') {
        if (e.t !== lastPayoutT) {
          payoutRound++;
          lastPayoutT = e.t;
          payouts.push(0);
        }
        payouts[payoutRound] += Object.values(e.paid).reduce((a, b) => a + b, 0);
        paidPerShare[e.company] += e.perShare + e.bonusPerShare;
        bonusPerShare[e.company] += e.bonusPerShare;
      }
    }
  };

  const pending: Map<number, ReturnType<Game['drainEvents']>> = new Map(bots.map((b) => [b.me, []]));
  const thinkSteps = Math.max(1, Math.round(1 / cfg.tickSec));
  const orderRng = new Rng(cfg.seed * 31 + 7);
  let phase: string = g.phase;
  while (!g.done) {
    // Shuffle who acts first each step, so no seat systematically wins ties (e.g. two bots bidding
    // the same minimum in the same step).
    const order = orderRng.shuffle([...bots]);
    // Bots answer auctions every step; otherwise they look once a second (much faster).
    const look = g.auction !== null || g.steps % thinkSteps === 0;
    for (const bot of order) {
      const fresh = g.drainEvents(bot.me);
      if (bot.me === 0) record(fresh, phase); // stats come from one player's (public) events
      pending.get(bot.me)!.push(...fresh);
      if (!look) continue;
      const events = pending.get(bot.me)!;
      pending.set(bot.me, []);
      for (const a of bot.decide(g.observe(bot.me), events)) g.act(bot.me, a);
    }
    phase = g.phase;
    g.step();
    onStep?.(g);
    if (g.phase === 'running' && g.tick % 50 === 0) {
      // Bays: trucks queued (waiting for a bay, stock or demand) per building with a queue.
      for (const q of g.trucks.queues.values()) {
        const waiting = q.filter((id) => g.trucks.trucks[id].state === 'queued').length;
        if (q.length === 0) continue;
        waitingSum += waiting;
        waitingSamples++;
        maxQueue = Math.max(maxQueue, waiting);
      }
      waitingTrucks += g.trucks.trucks.filter((t) => t.state === 'queued').length;
      sampledTrucks += g.trucks.trucks.length;
    }
    if (g.phase === 'running' && g.tick % 600 === 0) {
      // Territory: who serves each location this minute.
      const byLoc = new Map<number, Map<number, number>>();
      for (const r of g.routes()) {
        for (const loc of [r.producer, r.consumer]) {
          const m = byLoc.get(loc) ?? new Map();
          m.set(r.company, (m.get(r.company) ?? 0) + r.trucks);
          byLoc.set(loc, m);
        }
        const depotNode = g.town.locations[r.depot].node;
        reachSum += distancesFrom(g.town.graph, depotNode)[g.town.locations[r.producer].node];
        reachN++;
      }
      const main = new Map<number, number>();
      for (const [loc, m] of byLoc) {
        servedAny++;
        if (m.size > 1) contested++;
        main.set(loc, [...m].sort((a, b) => b[1] - a[1])[0][0]);
      }
      mainServer.push(main);
    }
    if (soldOutAt === null && g.companies.every((c) => c.shares.every((s) => s !== null))) soldOutAt = g.t / 60;
  }
  record(g.drainEvents(0), phase); // the final step (last payout)
  const cash = g.players.map((p) => p.cash);
  return {
    seed: cfg.seed,
    cash,
    winner: cash.indexOf(Math.max(...cash)),
    companies: g.companies.map((c) => ({
      deliveries: deliveries[c.id],
      paidPerShare: paidPerShare[c.id],
      bonusPerShare: bonusPerShare[c.id],
      avgPrice: (() => {
        const xs = auctions.filter((a) => a.company === c.id).map((a) => a.amount);
        return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0;
      })(),
      trucks: g.trucks.trucks.filter((t) => t.company === c.id).length,
      depots: g.depotsOf(c.id).length,
      treasury: c.treasury,
      sharesSold: c.shares.filter((s) => s !== null).length,
      owners: [...c.shares],
    })),
    auctions,
    payouts,
    soldOutAt,
    locationsGrown: g.locations.filter((l) => l.level > cfg.cycles.startLevel).length,
    locationsShrunk: g.locations.filter((l) => l.level < cfg.cycles.startLevel).length,
    opened,
    closed,
    territory: (() => {
      let handovers = 0;
      let pairs = 0;
      for (let i = 1; i < mainServer.length; i++) {
        for (const [loc, who] of mainServer[i]) {
          const prev = mainServer[i - 1].get(loc);
          if (prev === undefined) continue;
          pairs++;
          if (prev !== who) handovers++;
        }
      }
      return {
        contestedShare: servedAny ? contested / servedAny : 0,
        handoverRate: pairs ? handovers / pairs : 0,
        avgReach: reachN ? reachSum / reachN : 0,
      };
    })(),
    sharing: (() => {
      let sum = 0;
      let n = 0;
      for (const m of loadsAt.values()) {
        if (m.size < 2) continue;
        const [a, b] = [...m.values()].sort((x, y) => y - x);
        sum += b / (a + b);
        n++;
      }
      return { split: n ? sum / n : 0, producers: n };
    })(),
    delivered: deliveries.reduce((a, b) => a + b, 0),
    lateBuys: late,
    depotBuys: {
      count: buys.length,
      avgPrice: buys.length ? buys.reduce((a, b) => a + b, 0) / buys.length : 0,
      discounted: cfg.depots.pricing === 'subsidy' ? buys.filter((p) => p < cfg.depots.depotBase).length : 0,
    },
    bays: {
      avgWaiting: waitingSamples ? waitingSum / waitingSamples : 0,
      maxQueue,
      waitingShare: sampledTrucks ? waitingTrucks / sampledTrucks : 0,
    },
    invested: { count: investCount, spent: investSpent },
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
  console.log(
    `locations: ${avg(results.map((r) => r.locationsGrown)).toFixed(1)} above start level, ${avg(results.map((r) => r.locationsShrunk)).toFixed(1)} below; ${avg(results.map((r) => r.opened)).toFixed(1)} opened, ${avg(results.map((r) => r.closed)).toFixed(1)} closed per game`,
  );
  return results;
}
