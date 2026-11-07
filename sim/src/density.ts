/**
 * Economy experiment: cheaper trucks, bigger factories, denser towns. Run:
 *   npx tsx sim/src/density.ts [games]
 * Per variant (bots playing, automatic routes): how many different shops each factory's trucks
 * serve, deliveries, trucks, money paid out, and how many closure warnings are up at once.
 */
import { type Game, type GameConfigOverrides } from '@sr/core';
import { runGame } from './runner.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const games = Number(process.argv[2] ?? 20);

function variant(label: string, extra: GameConfigOverrides) {
  const shopsPerFactory: number[] = [];
  const shopsServed: number[] = [];
  const warnings: number[] = [];
  const maxWarnings: number[] = [];
  const deliveries: number[] = [];
  const trucks: number[] = [];
  const factories: number[] = [];
  const paid: number[] = [];
  const closed: number[] = [];
  const cash: number[] = [];
  const businesses: number[] = [];
  for (let i = 0; i < games; i++) {
    let warnSum = 0;
    let warnN = 0;
    let warnMax = 0;
    const perFactory: number[] = [];
    const served: number[] = [];
    let lastSample = -1;
    let liveBiz = 0;
    const r = runGame({ ...extra, seed: 1 + i }, [], (g: Game) => {
      const t = Math.floor(g.t);
      if (t === lastSample || t % 15 !== 0 || g.phase !== 'running') return;
      lastSample = t;
      const open = g.locations.filter((s) => !s.closed);
      const w = open.filter((s) => s.closingIn !== null).length;
      warnSum += w;
      warnN++;
      warnMax = Math.max(warnMax, w);
      liveBiz = open.length;
      // From minute 5 on (once fleets have grown): different shops served, per factory with trucks out.
      if (g.t < 300) return;
      const routes = g.observe(0).routes;
      const byDepot = new Map<number, Set<number>>();
      for (const rt of routes) {
        const k = rt.company * 10000 + rt.depot;
        const set = byDepot.get(k) ?? new Set<number>();
        set.add(rt.consumer);
        byDepot.set(k, set);
      }
      for (const set of byDepot.values()) perFactory.push(set.size);
      served.push(new Set(routes.map((rt) => rt.consumer)).size);
    });
    shopsPerFactory.push(avg(perFactory));
    shopsServed.push(avg(served));
    warnings.push(warnN ? warnSum / warnN : 0);
    maxWarnings.push(warnMax);
    deliveries.push(r.companies.reduce((s, c) => s + c.deliveries, 0));
    trucks.push(r.companies.reduce((s, c) => s + c.trucks, 0));
    factories.push(r.companies.reduce((s, c) => s + c.depots, 0));
    paid.push(r.payouts.reduce((a, b) => a + b, 0));
    closed.push(r.closed);
    cash.push(avg(r.cash));
    businesses.push(liveBiz);
  }
  console.log(
    `| ${label} | ${avg(shopsPerFactory).toFixed(2)} | ${avg(shopsServed).toFixed(1)} | ${Math.round(avg(deliveries))} | ${avg(trucks).toFixed(0)} | ${avg(factories).toFixed(1)} | $${Math.round(avg(paid))} | $${Math.round(avg(cash))} | ${avg(businesses).toFixed(0)} | ${avg(warnings).toFixed(1)} (max ${avg(maxWarnings).toFixed(1)}) | ${avg(closed).toFixed(1)} |`,
  );
}

const dense = { producersPerGood: [6, 8] as [number, number], consumersPerGood: [11, 16] as [number, number] };
console.log(`\nDensity experiment (${games} games per variant, bots, automatic routes)\n`);
console.log('| Variant | Shops per factory | Shops served (all cos.) | Deliveries | Trucks (all cos.) | Factories | Dividends paid | Avg final cash | Businesses at end | Closure warnings up (avg, max) | Closed |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
const which = process.argv[3] ?? 'economy';
const none = { startingTrucks: 0 };
const all3 = { depots: { truckPrice: 6, capacity: 16 }, town: dense };
// Businesses that never grow, shrink or close: fixed at one level (and investment can't raise them).
const fixed = (level: number) => ({ startLevel: level, maxLevel: level, growAbove: 2, shrinkBelow: -1 });
if (which === 'economy') {
  variant('Today (no starting truck)', none);
  variant('Start with 1 truck', {});
  variant('Trucks half price ($6)', { ...none, depots: { truckPrice: 6 } });
  variant('16 trucks per factory', { ...none, depots: { capacity: 16 } });
  variant('Denser town (1.5×)', { ...none, town: dense });
  variant('Half price + 16 per factory', { ...none, depots: { truckPrice: 6, capacity: 16 } });
  variant('All three', { ...none, depots: { truckPrice: 6, capacity: 16 }, town: dense });
  variant('All three + 1 starting truck', { depots: { truckPrice: 6, capacity: 16 }, town: dense });
} else if (which === 'fixed') {
  variant('All three + 1 starting truck', all3);
  variant('Fixed level 3 (today otherwise)', { cycles: fixed(3) });
  variant('Fixed level 3 + all three', { ...all3, cycles: fixed(3) });
  variant('Fixed level 2 + all three', { ...all3, cycles: fixed(2) });
} else if (which === 'dense2') {
  const dense2 = { producersPerGood: [8, 10] as [number, number], consumersPerGood: [14, 22] as [number, number] };
  variant('Fixed level 2 + cheap/big fleets + 2× density', { depots: { truckPrice: 6, capacity: 16 }, town: dense2, cycles: fixed(2) });
}
