/**
 * Balance experiments with bots. Run: npm run experiments -- final|income [games]
 *
 * Final payout: compare the asset-based bonus at different shares with an earnings-based bonus
 * at different multiples. What we want (from the design discussion):
 * - the final payout shouldn't dwarf the others or refund investment in a poorly run company;
 * - a well-run company's shares should clearly beat a poorly run company's;
 * - shares should keep selling (ideally sold out by mid-game).
 */
import { generateTown, makeGameConfig, type GameConfigOverrides, type MoneyConfig } from '@sr/core';
import { PERSONALITIES, type BotPersonality } from './bot.js';
import { runGame, type GameResult } from './runner.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Row {
  label: string;
  finalShare: number;
  bonusShare: number;
  bestPerShare: number;
  worstPerShare: number;
  worstVsPrice: number;
  sharesSold: number;
  soldOutGames: number;
  soldOutMinute: number | null;
  avgPrice: number;
  trucks: number;
  depots: number;
  cash: number;
}

function summarise(label: string, results: GameResult[]): Row {
  const finalShare = avg(results.map((r) => r.payouts[r.payouts.length - 1] / Math.max(1e-9, r.payouts.reduce((a, b) => a + b, 0))));
  const bonusShare = avg(
    results.map((r) => {
      const paid = r.companies.reduce((s, c) => s + c.paidPerShare * c.sharesSold, 0);
      const bonus = r.companies.reduce((s, c) => s + c.bonusPerShare * c.sharesSold, 0);
      return paid > 0 ? bonus / paid : 0;
    }),
  );
  // Among companies that sold at least one share: best and worst by deliveries.
  const best: number[] = [];
  const worst: number[] = [];
  const worstRatio: number[] = [];
  for (const r of results) {
    const owned = r.companies.filter((c) => c.sharesSold > 0).sort((a, b) => b.deliveries - a.deliveries);
    if (owned.length < 2) continue;
    best.push(owned[0].paidPerShare);
    const w = owned[owned.length - 1];
    worst.push(w.paidPerShare);
    if (w.avgPrice > 0) worstRatio.push(w.paidPerShare / w.avgPrice);
  }
  const soldOut = results.filter((r) => r.soldOutAt !== null).map((r) => r.soldOutAt!);
  return {
    label,
    finalShare,
    bonusShare,
    bestPerShare: avg(best),
    worstPerShare: avg(worst),
    worstVsPrice: avg(worstRatio),
    sharesSold: avg(results.map((r) => r.companies.reduce((s, c) => s + c.sharesSold, 0))),
    soldOutGames: soldOut.length,
    soldOutMinute: soldOut.length ? avg(soldOut) : null,
    avgPrice: avg(results.flatMap((r) => r.auctions.map((a) => a.amount))),
    trucks: avg(results.flatMap((r) => r.companies.map((c) => c.trucks))),
    depots: avg(results.flatMap((r) => r.companies.map((c) => c.depots))),
    cash: avg(results.flatMap((r) => r.cash)),
  };
}

function run(label: string, money: Partial<MoneyConfig>, games: number, extra: GameConfigOverrides = {}): Row {
  const results: GameResult[] = [];
  for (let i = 0; i < games; i++) results.push(runGame({ ...extra, money: { ...extra.money, ...money }, seed: 1 + i }));
  return summarise(label, results);
}

function print(rows: Row[], games: number) {
  console.log(`\n${which} experiment (${games} games per variant, 4 balanced bots)\n`);
  console.log(
    '| Variant | Final payout, % of all dividends | of which the bonus | Best company, paid per share | Worst company, paid per share | Worst: paid ÷ price paid | Shares sold (of 25) | Sold out | Avg share price | Trucks per company | Depots per company | Final cash per player |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${(100 * r.finalShare).toFixed(0)}% | ${(100 * r.bonusShare).toFixed(0)}% | $${r.bestPerShare.toFixed(0)} | $${r.worstPerShare.toFixed(0)} | ${r.worstVsPrice.toFixed(2)}× | ${r.sharesSold.toFixed(1)} | ${r.soldOutGames}/${games}${r.soldOutMinute !== null ? ` (min ${r.soldOutMinute.toFixed(1)})` : ''} | $${r.avgPrice.toFixed(0)} | ${r.trucks.toFixed(1)} | ${r.depots.toFixed(1)} | $${r.cash.toFixed(0)} |`,
    );
  }
}

/** The #23 measures: territory, bays, investment, churn. */
function printWorld(label: string, results: GameResult[]) {
  const t = results.map((r) => r.territory);
  const b = results.map((r) => r.bays);
  const inv = results.map((r) => r.invested);
  const sold = avg(results.map((r) => r.companies.reduce((s, c) => s + c.sharesSold, 0)));
  const worst = avg(results.map((r) => Math.min(...r.companies.filter((c) => c.sharesSold > 0).map((c) => c.paidPerShare))));
  const best = avg(results.map((r) => Math.max(...r.companies.map((c) => c.paidPerShare))));
  console.log(
    `| ${label} | ${(100 * avg(t.map((x) => x.contestedShare))).toFixed(0)}% | ${(100 * avg(t.map((x) => x.handoverRate))).toFixed(1)}% | ${avg(t.map((x) => x.avgReach)).toFixed(1)} | ${avg(b.map((x) => x.avgWaiting)).toFixed(2)} | ${Math.round(avg(b.map((x) => x.maxQueue)))} | ${(100 * avg(b.map((x) => x.waitingShare))).toFixed(0)}% | ${avg(inv.map((x) => x.count)).toFixed(1)} ($${avg(inv.map((x) => x.spent)).toFixed(0)}) | ${avg(results.map((r) => r.opened)).toFixed(1)} / ${avg(results.map((r) => r.closed)).toFixed(1)} | ${avg(results.map((r) => r.locationsGrown)).toFixed(1)} / ${avg(results.map((r) => r.locationsShrunk)).toFixed(1)} | ${sold.toFixed(1)} | ${avg(results.flatMap((r) => r.companies.map((c) => c.trucks))).toFixed(1)} | $${best.toFixed(0)} / $${worst.toFixed(0)} |`,
  );
}
function worldHeader(games: number) {
  console.log(`\n${which} experiment (${games} games per variant)\n`);
  console.log(
    '| Variant | Contested locations | Handovers per location-minute | Avg reach (blocks) | Trucks waiting per busy building | Max queue | Trucks waiting (share of all) | Level-ups bought ($) | Opened / closed | Above / below start level | Shares sold | Trucks per co. | Best / worst paid per share |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
}
function runWorld(label: string, games: number, extra: GameConfigOverrides = {}) {
  const results: GameResult[] = [];
  for (let i = 0; i < games; i++) results.push(runGame({ ...extra, seed: 1 + i }));
  printWorld(label, results);
}

const which = process.argv[2] ?? 'final';
const games = Number(process.argv[3] ?? 20);
if (which === 'final') {
  print(
    [
      run('A: 50% of assets (today)', { finalBonus: 'assets', finalAssetShare: 0.5 }, games),
      run('B: 20% of assets', { finalBonus: 'assets', finalAssetShare: 0.2 }, games),
      run('C: 10% of assets', { finalBonus: 'assets', finalAssetShare: 0.1 }, games),
      run('D: 1× last 3 min earnings', { finalBonus: 'earnings', finalEarningsMultiple: 1 }, games),
      run('E: 2× last 3 min earnings', { finalBonus: 'earnings', finalEarningsMultiple: 2 }, games),
      run('F: 3× last 3 min earnings', { finalBonus: 'earnings', finalEarningsMultiple: 3 }, games),
    ],
    games,
  );
} else if (which === 'income') {
  // Bigger regular income (pricier pallets and/or faster trucks), with a smaller final bonus.
  const fast = { trucks: { speed: 0.35 } };
  print(
    [
      run('G: $3/$4 pallets, 20% of assets', { palletPrice: 3, premiumPrice: 4, finalBonus: 'assets', finalAssetShare: 0.2 }, games),
      run('H: $3/$4 pallets, 1× earnings', { palletPrice: 3, premiumPrice: 4, finalBonus: 'earnings', finalEarningsMultiple: 1 }, games),
      run('I: faster trucks, 20% of assets', { finalBonus: 'assets', finalAssetShare: 0.2 }, games, fast),
      run('J: faster trucks + $3/$4, 1× earnings', { palletPrice: 3, premiumPrice: 4, finalBonus: 'earnings', finalEarningsMultiple: 1 }, games, fast),
      run('K: faster trucks + $3/$4, 10% of assets', { palletPrice: 3, premiumPrice: 4, finalBonus: 'assets', finalAssetShare: 0.1 }, games, fast),
      run('L: faster trucks + $3/$4, 20% of assets', { palletPrice: 3, premiumPrice: 4, finalBonus: 'assets', finalAssetShare: 0.2 }, games, fast),
    ],
    games,
  );
} else if (which === 'shortlist') {
  const fast = { trucks: { speed: 0.35 } };
  const rich = { palletPrice: 3, premiumPrice: 4 };
  print(
    [
      run('A: today (50% of assets)', { finalBonus: 'assets', finalAssetShare: 0.5 }, games),
      run('E: 2× earnings', { finalBonus: 'earnings', finalEarningsMultiple: 2 }, games),
      run('K: faster + $3/$4, 10% of assets', { ...rich, finalBonus: 'assets', finalAssetShare: 0.1 }, games, fast),
      run('L: faster + $3/$4, 20% of assets', { ...rich, finalBonus: 'assets', finalAssetShare: 0.2 }, games, fast),
      run('J: faster + $3/$4, 1× earnings', { ...rich, finalBonus: 'earnings', finalEarningsMultiple: 1 }, games, fast),
    ],
    games,
  );
} else if (which === 'scale') {
  // Adi's "more trucks" variant: half-price trucks, faster, twice the goods, depots hold twice as many.
  const scale: GameConfigOverrides = {
    trucks: { speed: 0.35 },
    depots: { truckPrice: 15, capacity: 6 },
  };
  const rich = { palletPrice: 3, premiumPrice: 4 };
  print(
    [
      run('A: today (50% of assets)', { finalBonus: 'assets', finalAssetShare: 0.5 }, games),
      run('K: faster + $3/$4, 10% of assets', { ...rich, finalBonus: 'assets', finalAssetShare: 0.1 }, games, { trucks: { speed: 0.35 } }),
      run('S1: scaled up, $2/$3, 50% of assets', { finalBonus: 'assets', finalAssetShare: 0.5 }, games, scale),
      run('S2: scaled up, $2/$3, 20% of assets', { finalBonus: 'assets', finalAssetShare: 0.2 }, games, scale),
      run('S3: scaled up, $2/$3, 10% of assets', { finalBonus: 'assets', finalAssetShare: 0.1 }, games, scale),
      run('S4: scaled up, $3/$4, 10% of assets', { ...rich, finalBonus: 'assets', finalAssetShare: 0.1 }, games, scale),
    ],
    games,
  );
} else if (which === 'map') {
  // Bigger towns with the same density of producers, consumers and depot sites, on the scaled-up
  // settings with a 10% bonus.
  const scale: GameConfigOverrides = {
    trucks: { speed: 0.35 },
    depots: { truckPrice: 15, capacity: 6 },
  };
  const money = { finalBonus: 'assets' as const, finalAssetShare: 0.1 };
  const size = (n: number, p: [number, number], c: [number, number], d: [number, number]): GameConfigOverrides => ({
    ...scale,
    town: { blocksX: n, blocksY: n, producersPerGood: p, consumersPerGood: c, extraDepotSites: d },
  });
  print(
    [
      run('12×12 (today)', money, games, size(12, [2, 3], [4, 6], [10, 15])),
      run('16×16', money, games, size(16, [4, 5], [7, 11], [18, 27])),
      run('20×20', money, games, size(20, [6, 8], [11, 17], [28, 42])),
    ],
    games,
  );
} else if (which === 'split') {
  // Where delivery income goes: both (today), split, or dividends only (SAR-style: companies
  // grow only from share auctions). 16x16 town, scaled-up trucks, 10% bonus.
  const base: GameConfigOverrides = {
    trucks: { speed: 0.35 },
    depots: { truckPrice: 15, capacity: 6 },
    town: { blocksX: 16, blocksY: 16, producersPerGood: [4, 5], consumersPerGood: [7, 11], extraDepotSites: [18, 27] },
  };
  const bonus = { finalBonus: 'assets' as const, finalAssetShare: 0.1 };
  print(
    [
      run('Both get the full price (today)', { ...bonus, deliveryToTreasury: 1, deliveryToPot: 1 }, games, base),
      run('Split: half to company, half to shareholders', { ...bonus, deliveryToTreasury: 0.5, deliveryToPot: 0.5 }, games, base),
      run('SAR: all to shareholders, company gets nothing', { ...bonus, deliveryToTreasury: 0, deliveryToPot: 1 }, games, base),
      run('SAR, $30 trucks', { ...bonus, deliveryToTreasury: 0, deliveryToPot: 1 }, games, { ...base, depots: { truckPrice: 30, capacity: 6 } }),
    ],
    games,
  );
} else if (which === 'sar') {
  // Dividends-only (SAR-style) variations: truck and depot prices.
  const base: GameConfigOverrides = {
    trucks: { speed: 0.35 },
    town: { blocksX: 16, blocksY: 16, producersPerGood: [4, 5], consumersPerGood: [7, 11], extraDepotSites: [18, 27] },
  };
  const sar = { finalBonus: 'assets' as const, finalAssetShare: 0.1, deliveryToTreasury: 0, deliveryToPot: 1 };
  const depots = (truckPrice: number, depotBase: number, depotPerBlock = 10) => ({ ...base, depots: { truckPrice, capacity: 6, depotBase, depotPerBlock } });
  print(
    [
      run('SAR, $15 trucks, $80 depots', sar, games, depots(15, 80)),
      run('SAR, $15 trucks, $40 depots', sar, games, depots(15, 40, 5)),
      run('SAR, $20 trucks, $40 depots', sar, games, depots(20, 40, 5)),
      run('SAR, $25 trucks, $40 depots', sar, games, depots(25, 40, 5)),
      run('SAR, $20 trucks, $25 depots', sar, games, depots(20, 25, 3)),
    ],
    games,
  );
} else if (which === 'depots') {
  // Small depots (3 trucks) with big industries, and no minimum bid. Base: 16x16, cheap fast
  // trucks, doubled goods, both company and shareholders paid in full, 10% bonus.
  const base = (capacity: number, openingBid: number): GameConfigOverrides => ({
    trucks: { speed: 0.35 },
    depots: { truckPrice: 15, capacity },
    town: { blocksX: 16, blocksY: 16, producersPerGood: [4, 5], consumersPerGood: [7, 11], extraDepotSites: [18, 27] },
    auctions: { openingBid },
  });
  const money = { finalBonus: 'assets' as const, finalAssetShare: 0.1 };
  const sar = { ...money, deliveryToTreasury: 0, deliveryToPot: 1 };
  print(
    [
      run('6-truck depots, $20 minimum bid (reference)', money, games, base(6, 20)),
      run('6-truck depots, no minimum bid', money, games, base(6, 0)),
      run('3-truck depots, $20 minimum bid', money, games, base(3, 20)),
      run('3-truck depots, no minimum bid', money, games, base(3, 0)),
      run('SAR, $20 trucks, 3-truck depots, $40 depots', sar, games, {
        ...base(3, 20),
        depots: { truckPrice: 20, capacity: 3, depotBase: 40, depotPerBlock: 5 },
      }),
    ],
    games,
  );
} else if (which === 'speculator') {
  // Speculator bots (go all in on one company, keep a reserve for bargains) vs the balanced
  // investor bot, with and without a minimum bid, on the proposed defaults.
  const cfg = (openingBid: number): GameConfigOverrides => ({
    trucks: { speed: 0.35 },
    depots: { truckPrice: 15, capacity: 3 },
    town: { blocksX: 16, blocksY: 16, producersPerGood: [4, 5], consumersPerGood: [7, 11], extraDepotSites: [18, 27] },
    auctions: { openingBid },
    money: { finalBonus: 'assets', finalAssetShare: 0.1 },
  });
  const S = PERSONALITIES.speculator;
  const I = PERSONALITIES.balanced;
  const variants: [string, number, BotPersonality[]][] = [
    ['$20 minimum, 4 investors', 20, [I, I, I, I]],
    ['$20 minimum, 1 speculator + 3 investors', 20, [S, I, I, I]],
    ['No minimum, 4 investors', 0, [I, I, I, I]],
    ['No minimum, 1 speculator + 3 investors', 0, [S, I, I, I]],
    ['No minimum, 2 speculators + 2 investors', 0, [S, S, I, I]],
    ['No minimum, 4 speculators', 0, [S, S, S, S]],
  ];
  console.log(`\nspeculator experiment (${games} games per variant)\n`);
  console.log('| Variant | Shares sold (of 25) | Avg share price | Trucks per company | Depots per company | Speculators: avg final cash / wins | Investors: avg final cash / wins |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [label, bid, seats] of variants) {
    const results: GameResult[] = [];
    for (let i = 0; i < games; i++) results.push(runGame({ ...cfg(bid), seed: 1 + i }, seats));
    const r = summarise(label, results);
    const side = (who: BotPersonality) => {
      const idx = seats.map((p, i) => (p === who ? i : -1)).filter((i) => i >= 0);
      if (idx.length === 0) return 'n/a';
      const cash = avg(results.flatMap((g) => idx.map((i) => g.cash[i])));
      const wins = results.filter((g) => idx.includes(g.winner)).length;
      return `$${cash.toFixed(0)} / ${wins}`;
    };
    console.log(`| ${label} | ${r.sharesSold.toFixed(1)} | $${r.avgPrice.toFixed(0)} | ${r.trucks.toFixed(1)} | ${r.depots.toFixed(1)} | ${side(S)} | ${side(I)} |`);
  }
} else if (which === 'world') {
  // #23: territories, bays, investment and churn on the defaults, and the level-speed question.
  worldHeader(games);
  runWorld('Defaults (4-cycle window, open at level 3)', games);
  runWorld('2-cycle window', games, { cycles: { window: 2 } });
  runWorld('2-cycle window, open at level 2', games, { cycles: { window: 2 }, openings: { openLevel: 2 } });
  runWorld('2-cycle window, open at level 1', games, { cycles: { window: 2 }, openings: { openLevel: 1 } });
} else if (which === 'bays') {
  worldHeader(games);
  runWorld('1 bay per building', games, { town: { bays: 1 } });
  runWorld('2 bays (default)', games);
  runWorld('3 bays', games, { town: { bays: 3 } });
} else if (which === 'depots2') {
  // Fewer, bigger depots (#51) and subsidised depot prices (#52), against the rules before.
  console.log(`\ndepots2 experiment (${games} games per variant)\n`);
  console.log('| Rules | Depots bought (per game) | Avg depot price | Bought at a subsidy | Trucks per company | Depot→producer distance (blocks) | Contested locations | Handovers | Pallets delivered | Avg paid per share | Closures |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const before: GameConfigOverrides = { town: { extraDepotSites: [18, 27] }, depots: { capacity: 3, pricing: 'distance', depotBase: 80 } };
  const variants: [string, GameConfigOverrides][] = [
    ['Before: 18–27 sites, 3 trucks, distance pricing', before],
    ['6–9 sites, 8 trucks, distance pricing ($80)', { depots: { pricing: 'distance', depotBase: 80 } }],
    ['6–9 sites, 8 trucks, subsidy ($150, up to 60% off) (new default)', {}],
    ['New default + 1 river', { town: { rivers: 1 } }],
  ];
  for (const [label, o] of variants) {
    const rs = Array.from({ length: games }, (_, i) => runGame({ ...o, seed: 1 + i }));
    const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
    const buys = rs.reduce((s, r) => s + r.depotBuys.count, 0);
    const disc = rs.reduce((s, r) => s + r.depotBuys.discounted, 0);
    const avgPrice = buys ? rs.reduce((s, r) => s + r.depotBuys.avgPrice * r.depotBuys.count, 0) / buys : 0;
    console.log(
      `| ${label} | ${(buys / games).toFixed(1)} | $${avgPrice.toFixed(0)} | ${buys ? pct(disc / buys) : '–'} | ${avg(rs.map((r) => avg(r.companies.map((c) => c.trucks)))).toFixed(1)} | ${avg(rs.map((r) => r.territory.avgReach)).toFixed(1)} | ${pct(avg(rs.map((r) => r.territory.contestedShare)))} | ${(100 * avg(rs.map((r) => r.territory.handoverRate))).toFixed(1)}% | ${avg(rs.map((r) => r.delivered)).toFixed(0)} | $${avg(rs.map((r) => avg(r.companies.map((c) => c.paidPerShare)))).toFixed(0)} | ${avg(rs.map((r) => r.closed)).toFixed(0)} |`,
    );
  }
} else if (which === 'invest') {
  worldHeader(games);
  runWorld('$60 level-up (default)', games);
  runWorld('$30 level-up', games, { money: { investBase: 30 } });
  runWorld('$15 level-up', games, { money: { investBase: 15 } });
} else if (which === 'grace') {
  // Lower starting levels and a grace period, on the recommended 2-cycle window.
  const base = (startLevel: number, openLevel: number, graceSec: number): GameConfigOverrides => ({
    cycles: { window: 2, startLevel, graceSec },
    openings: { openLevel },
  });
  worldHeader(games);
  runWorld('Start 3, open 2, no grace (recommended)', games, base(3, 2, 0));
  runWorld('Start 3, open 2, 2-min grace', games, base(3, 2, 120));
  runWorld('Start 2, open 2, no grace', games, base(2, 2, 0));
  runWorld('Start 2, open 2, 2-min grace', games, base(2, 2, 120));
  runWorld('Start 2, open 1, 2-min grace', games, base(2, 1, 120));
  runWorld('Start 1, open 1, 2-min grace', games, base(1, 1, 120));
} else if (which === 'fairness' || which === 'rivers') {
  // Looser fairness: how unequal do starts get, and what does that do to auctions and returns?
  // "rivers" runs the same comparison with and without a river through the town.
  // An optional third argument picks the river counts, e.g. `rivers 24 0,1,2`.
  const riverCounts = which === 'rivers' ? (process.argv[4] ?? '0,1,2').split(',').map(Number) : [0];
  console.log(`\n${which} experiment (${games} games per variant)\n`);
  console.log('| Town | Fairness (weakest start ≥ x × strongest) | Start score: weakest ÷ strongest | Opening price: dearest / cheapest company | Companies opening at $0 | Best / worst paid per share | Trucks per co. (best start / worst start) | Shares sold | Contested locations | Handovers per location-minute | Depot→producer distance (blocks) | Closures |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const rivers of riverCounts)
    for (const [label, ratio] of [['60% (today)', 0.6], ['30%', 0.3], ['Off', 0]] as const) {
      const ratios: number[] = [];
      const dear: number[] = [];
      const cheap: number[] = [];
      const zero: number[] = [];
      const best: number[] = [];
      const worst: number[] = [];
      const bestTrucks: number[] = [];
      const worstTrucks: number[] = [];
      const sold: number[] = [];
      const contested: number[] = [];
      const handover: number[] = [];
      const reach: number[] = [];
      const closed: number[] = [];
      for (let i = 0; i < games; i++) {
        const town = { fairMinRatio: ratio, rivers };
        const cfg = makeGameConfig({ seed: 1 + i, town });
        const t = generateTown(cfg.town);
        const scores = t.fairness.map((f) => f.score);
        ratios.push(Math.min(...scores) / Math.max(...scores));
        const r = runGame({ seed: 1 + i, town });
        const opening = r.auctions.filter((a) => a.opening);
        const prices = r.companies.map((_, c) => opening.find((a) => a.company === c)?.amount ?? 0);
        dear.push(Math.max(...prices));
        cheap.push(Math.min(...prices));
        zero.push(prices.filter((p) => p === 0).length);
        best.push(Math.max(...r.companies.map((c) => c.paidPerShare)));
        worst.push(Math.min(...r.companies.filter((c) => c.sharesSold > 0).map((c) => c.paidPerShare)));
        const order = t.fairness.slice().sort((a, b) => b.score - a.score);
        bestTrucks.push(r.companies[order[0].company].trucks);
        worstTrucks.push(r.companies[order[order.length - 1].company].trucks);
        sold.push(r.companies.reduce((s, c) => s + c.sharesSold, 0));
        contested.push(r.territory.contestedShare);
        handover.push(r.territory.handoverRate);
        reach.push(r.territory.avgReach);
        closed.push(r.closed);
      }
      const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
      console.log(
        `| ${rivers === 0 ? 'No river' : rivers === 1 ? '1 river' : `${rivers} rivers`} | ${label} | ${avg(ratios).toFixed(2)} | $${avg(dear).toFixed(0)} / $${avg(cheap).toFixed(0)} | ${avg(zero).toFixed(1)} | $${avg(best).toFixed(0)} / $${avg(worst).toFixed(0)} | ${avg(bestTrucks).toFixed(1)} / ${avg(worstTrucks).toFixed(1)} | ${avg(sold).toFixed(1)} | ${pct(avg(contested))} | ${(100 * avg(handover)).toFixed(1)}% | ${avg(reach).toFixed(1)} | ${avg(closed).toFixed(0)} |`,
      );
    }
} else {
  console.log('usage: npm run experiments -- final|income|shortlist|scale|map|split|sar|depots|speculator|world|bays|invest|grace|fairness|rivers|depots2 [games]');
}
