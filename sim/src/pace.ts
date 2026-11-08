/**
 * Pacing experiment: how fast companies fill up and where their money goes. Run:
 *   npx tsx sim/src/pace.ts [games]
 * Per setup (bots): treasury, fleet against its limit, and buy-back price minute by minute; factory
 * purchases (how many, at what price, how many with a subsidy); offering prices; deliveries and money.
 */
import { type Game, type GameConfigOverrides } from '@sr/core';
import { runGame } from './runner.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const games = Number(process.argv[2] ?? 10);

function setup(label: string, extra: GameConfigOverrides) {
  const byMin = new Map<number, number[][]>();
  const results = [];
  for (let i = 0; i < games; i++) {
    results.push(
      runGame({ ...extra, seed: 1 + i }, [], (g: Game) => {
        if (g.phase !== 'running' || Math.abs(g.t % 120) > 0.05 || g.t < 1) return;
        const m = Math.round(g.t / 60);
        const cos = g.companies.map((c) => {
          const trucks = g.trucks.trucks.filter((t) => t.company === c.id).length;
          const limit = g.depotsOf(c.id).length * g.cfg.depots.capacity;
          return [c.treasury, trucks / Math.max(1, limit), g.minPrice(c.id), g.depotsOf(c.id).length];
        });
        const a = (k: number) => avg(cos.map((x) => x[k]));
        (byMin.get(m) ?? byMin.set(m, []).get(m)!).push([a(0), a(1), a(2), a(3)]);
      }),
    );
  }
  console.log(`\n### ${label}\n`);
  console.log('| Minute | Avg treasury | Fleet vs limit | Buy-back price | Factories per co. |');
  console.log('|---|---|---|---|---|');
  for (const [m, xs] of [...byMin].sort((a, b) => a[0] - b[0])) {
    const a = (k: number) => avg(xs.map((x) => x[k]));
    console.log(`| ${m} | $${a(0).toFixed(0)} | ${(100 * a(1)).toFixed(0)}% | $${a(2).toFixed(0)} | ${a(3).toFixed(1)} |`);
  }
  const buys = results.map((r) => r.depotBuys);
  const opening = results.flatMap((r) => r.auctions.filter((x) => x.opening).map((x) => x.amount));
  const later = results.flatMap((r) => r.auctions.filter((x) => !x.opening).map((x) => x.amount));
  const deliveries = avg(results.map((r) => r.companies.reduce((s, c) => s + c.deliveries, 0)));
  const trucks = avg(results.map((r) => r.companies.reduce((s, c) => s + c.trucks, 0)));
  const paid = avg(results.map((r) => r.payouts.reduce((a, b) => a + b, 0)));
  const cash = avg(results.flatMap((r) => r.cash));
  console.log(
    `\nFactories bought ${avg(buys.map((b) => b.count)).toFixed(1)} a game at avg $${avg(buys.map((b) => b.avgPrice)).toFixed(0)}, ` +
      `${(100 * avg(buys.map((b) => (b.count ? b.discounted / b.count : 0)))).toFixed(0)}% with a subsidy. ` +
      `Offerings: opening avg $${avg(opening).toFixed(0)}, in-game avg $${avg(later).toFixed(0)} (${(later.length / games).toFixed(1)} a game). ` +
      `Deliveries ${Math.round(deliveries)}, trucks ${Math.round(trucks)}, dividends $${Math.round(paid)}, avg final cash $${Math.round(cash)}.`,
  );
}

const old = { depots: { capacity: 8, truckPrice: 12 } };
setup('1. Current (#90): 16 trucks per factory at $6, $100 cash', {});
setup('2. 8 per factory at $12, $100 cash', old);
setup('3. 8 per factory at $12, $150 cash', { ...old, startingCash: 150 });
