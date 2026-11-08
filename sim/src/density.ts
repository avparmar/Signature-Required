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
  const ordersDone: number[] = [];
  const shared: number[] = [];
  const bumps: number[] = [];
  const idle: number[] = [];
  for (let i = 0; i < games; i++) {
    let done = 0;
    let multi = 0;
    let bumped = 0;
    let idleSum = 0;
    let idleN = 0;
    let lastPlans = 0;
    const deliveredTo = new Map<number, Set<number>>();
    const allShops = new Set<number>();
    let warnSum = 0;
    let warnN = 0;
    let warnMax = 0;
    const perFactory: number[] = [];
    const served: number[] = [];
    let lastSample = -1;
    let liveBiz = 0;
    const r = runGame({ ...extra, seed: 1 + i }, [], (g: Game) => {
      const t = Math.floor(g.t);
      for (const e of g.peekEvents(0)) {
        if (e.type === 'delivered') {
          const tr = g.trucks.trucks[e.truck];
          const k = e.company * 10000 + tr.depot;
          (deliveredTo.get(k) ?? deliveredTo.set(k, new Set()).get(k)!).add(e.location);
          allShops.add(e.location);
        }
        if (e.type === 'orderDone') {
          done++;
          if (e.delivered.filter((n) => n > 0).length > 1) multi++;
        }
      }
      lastPlans = g.plans;
      if (t === lastSample || t % 15 !== 0 || g.phase !== 'running') return;
      lastSample = t;
      const all = g.trucks.trucks;
      if (all.length) {
        idleSum += all.filter((tr) => tr.orders.length === 0 && tr.cargo === null).length / all.length;
        idleN++;
      }
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
    shopsPerFactory.push(avg([...deliveredTo.values()].map((x) => x.size)));
    shopsServed.push(allShops.size);
    warnings.push(warnN ? warnSum / warnN : 0);
    maxWarnings.push(warnMax);
    deliveries.push(r.companies.reduce((s, c) => s + c.deliveries, 0));
    trucks.push(r.companies.reduce((s, c) => s + c.trucks, 0));
    factories.push(r.companies.reduce((s, c) => s + c.depots, 0));
    paid.push(r.payouts.reduce((a, b) => a + b, 0));
    closed.push(r.closed);
    cash.push(avg(r.cash));
    businesses.push(liveBiz);
    bumped = lastPlans;
    ordersDone.push(done);
    shared.push(done ? multi / done : 0);
    bumps.push(bumped);
    idle.push(idleN ? idleSum / idleN : 0);
  }
  console.log(
    `| ${label} | ${avg(shopsPerFactory).toFixed(2)} | ${avg(shopsServed).toFixed(1)} | ${Math.round(avg(deliveries))} | ${avg(trucks).toFixed(0)} | ${avg(factories).toFixed(1)} | $${Math.round(avg(paid))} | $${Math.round(avg(cash))} | ${avg(businesses).toFixed(0)} | ${avg(warnings).toFixed(1)} (max ${avg(maxWarnings).toFixed(1)}) | ${avg(closed).toFixed(1)} | ${avg(ordersDone).toFixed(0)} (${(100 * avg(shared)).toFixed(0)}% shared) | ${avg(bumps).toFixed(1)} | ${(100 * avg(idle)).toFixed(0)}% |`,
  );
}

const dense = { producersPerGood: [6, 8] as [number, number], consumersPerGood: [11, 16] as [number, number] };
console.log(`\nDensity experiment (${games} games per variant, bots, automatic routes)\n`);
console.log('| Variant | Shops per factory (whole game) | Shops delivered to (whole game) | Deliveries | Trucks (all cos.) | Factories | Dividends paid | Avg final cash | Businesses at end | Closure warnings up (avg, max) | Closed | Orders filled | Plans made | Trucks free |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
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
} else if (which === 'tuned') {
  // The new defaults (fixed level 2, 2x density with shops matched to and placed near producers,
  // $6 trucks, 16 per factory, a starting truck), at a few pallet prices.
  for (const price of [2.4, 2, 1.7, 1.4]) variant(`New defaults, pallet $${price}`, { money: { palletPrice: price, premiumPrice: +(price * 1.5).toFixed(2) } });
} else if (which === 'demand') {
  // The new defaults, with shops wanting more of what a producer makes (0.5 = supply matches demand).
  for (const share of [0.75, 1]) variant(`New defaults, shops want ${share * 4}/cycle`, { cycles: { shopShare: share } });
} else if (which === 'orders') {
  variant('#89 defaults (shops want 2 every cycle)', { orders: { enabled: false } });
  variant('Shop orders (4-12, quiet 1-3 min)', {});
  variant('Shop orders, bonus $0.25 a pallet', { orders: { bonusPerPallet: 0.25 } });
  variant('Shop orders, replan every second', { orders: { replanSec: 1, batchSec: 0 } });
} else if (which === 'dense2') {
  const dense2 = { producersPerGood: [8, 10] as [number, number], consumersPerGood: [14, 22] as [number, number] };
  variant('Fixed level 2 + cheap/big fleets + 2× density', { depots: { truckPrice: 6, capacity: 16 }, town: dense2, cycles: fixed(2) });
}
