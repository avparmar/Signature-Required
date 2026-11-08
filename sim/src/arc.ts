/**
 * The game's arc: early local growth, a push for the middle, a saturated end. Run:
 *   npx tsx sim/src/arc.ts [games]
 * Per setup (bots), in two-minute windows: trucks and how many stood idle, earnings per truck, trucks
 * bought, where deliveries went (centre / middle / outer band), and the average treasury.
 */
import { type Game, type GameConfigOverrides } from '@sr/core';
import { runGame } from './runner.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const games = Number(process.argv[2] ?? 8);

function setup(label: string, extra: GameConfigOverrides) {
  const W = 120;
  const rows = new Map<number, { trucks: number[]; idle: number[]; earned: number[]; bought: number[]; band: number[][]; treasury: number[]; capacity: number[]; budget: number[][] }>();
  const inward: number[] = [];
  const totals = { deliveries: [] as number[], paid: [] as number[], cash: [] as number[] };
  for (let i = 0; i < games; i++) {
    const win = new Map<number, { idle: number[]; earned: number; bought: number; band: number[] }>();
    const at = (t: number) => {
      const k = Math.floor(t / W);
      return win.get(k) ?? win.set(k, { idle: [], earned: 0, bought: 0, band: [0, 0, 0] }).get(k)!;
    };
    const firstIn = new Map<number, number>();
    const r = runGame({ ...extra, seed: 1 + i }, [], (g: Game) => {
      if (g.phase !== 'running') return;
      const w = at(g.t);
      for (const e of g.peekEvents(0)) {
        if (e.type === 'delivered') {
          w.earned += e.price;
          w.band[g.bandOf(e.location)]++;
        }
        if (e.type === 'boughtTruck') w.bought++;
        if (e.type === 'boughtDepot' && g.bandOf(e.site) < 2 && !firstIn.has(e.company)) firstIn.set(e.company, g.t / 60);
      }
      if (Math.abs(g.t % 10) < 0.05) {
        const all = g.trucks.trucks;
        w.idle.push(all.filter((t) => t.orders.length === 0 && t.cargo === null).length / Math.max(1, all.length));
      }
      if (Math.abs((g.t % W) - (W - 1)) < 0.05) {
        const k = Math.floor(g.t / W);
        const row = rows.get(k) ?? rows.set(k, { trucks: [], idle: [], earned: [], bought: [], band: [], treasury: [], capacity: [], budget: [] }).get(k)!;
        row.budget.push([...g.bandBudget]);
        const n = g.trucks.trucks.length;
        row.trucks.push(n);
        row.idle.push(avg(w.idle));
        row.earned.push(n ? w.earned / n / (W / 60) : 0);
        row.bought.push(w.bought);
        const tot = w.band.reduce((a, b) => a + b, 0) || 1;
        row.band.push(w.band.map((x) => x / tot));
        row.treasury.push(avg(g.companies.map((c) => c.treasury)));
        row.capacity.push(g.companies.reduce((a, c) => a + g.depotsOf(c.id).length * g.cfg.depots.capacity, 0));
      }
    });
    for (let c = 0; c < 5; c++) inward.push(firstIn.get(c) ?? 15);
    totals.deliveries.push(r.companies.reduce((s, c) => s + c.deliveries, 0));
    totals.paid.push(r.payouts.reduce((a, b) => a + b, 0));
    totals.cash.push(avg(r.cash));
  }
  console.log(`\n### ${label}\n`);
  console.log('| Minutes | Trucks (room for) | Idle | Earned per truck per min | Trucks bought | Deliveries: centre / middle / outer | Open demand: centre / middle / outer | Avg treasury |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [k, x] of [...rows].sort((a, b) => a[0] - b[0])) {
    const band = [0, 1, 2].map((b) => `${(100 * avg(x.band.map((v) => v[b]))).toFixed(0)}%`).join(' / ');
    const budget = x.budget.length && x.budget[0].length ? [0, 1, 2].map((b) => avg(x.budget.map((v) => v[b])).toFixed(0)).join(' / ') : '-';
    console.log(`| ${k * 2}-${k * 2 + 2} | ${avg(x.trucks).toFixed(0)} (${avg(x.capacity).toFixed(0)}) | ${(100 * avg(x.idle)).toFixed(0)}% | $${avg(x.earned).toFixed(2)} | ${avg(x.bought).toFixed(1)} | ${band} | ${budget} | $${avg(x.treasury).toFixed(0)} |`);
  }
  const moved = inward.filter((m) => m < 15);
  console.log(`\nFirst factory in the middle or centre: ${moved.length}/${inward.length} companies, at minute ${avg(moved).toFixed(1)} on average.`);
  console.log(`Deliveries ${Math.round(avg(totals.deliveries))}, dividends $${Math.round(avg(totals.paid))}, avg final cash $${Math.round(avg(totals.cash))}.`);
}

const which = process.argv[3] ?? 'all';
if (which === 'migrate') {
  setup('Demand moves inward as served (0.12 a pallet)', {});
  setup('Gentler: 0.06 a pallet', { orders: { migratePerPallet: 0.06 } });
  setup('0.12 a pallet, with $0.40/min per truck', { depots: { upkeepPerMin: 0.4 } });
}
if (which === 'all' || which === 'fleet') setup('Demand follows the fleet (no bands)', { orders: { demand: 'fleet' } });
if (which === 'all' || which === 'bands') setup('Bands, fixed demand, no running cost', {});
if (which === 'all' || which === 'ramp') setup('Bands, centre and middle build up over 7 and 4 minutes', { orders: { bandRampSec: [420, 240, 0] } });
if (which === 'all' || which === 'upkeep') setup('Bands, fixed demand, $0.40/min per truck', { depots: { upkeepPerMin: 0.4 } });
