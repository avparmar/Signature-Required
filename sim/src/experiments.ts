/**
 * Balance experiments with bots. Run: npm run experiments -- final|income [games]
 *
 * Final payout: compare the asset-based bonus at different shares with an earnings-based bonus
 * at different multiples. What we want (from the design discussion):
 * - the final payout shouldn't dwarf the others or refund investment in a poorly run company;
 * - a well-run company's shares should clearly beat a poorly run company's;
 * - shares should keep selling (ideally sold out by mid-game).
 */
import type { GameConfigOverrides, MoneyConfig } from '@sr/core';
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
    cycles: { produceBase: 6, demandBase: [4, 8] },
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
    cycles: { produceBase: 6, demandBase: [4, 8] },
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
    cycles: { produceBase: 6, demandBase: [4, 8] },
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
    cycles: { produceBase: 6, demandBase: [4, 8] },
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
} else {
  console.log('usage: npm run experiments -- final|income|shortlist|scale|map|split|sar [games]');
}
