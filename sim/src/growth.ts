/**
 * Demand that grows to a hidden, random level: does each game turn out differently, and when do
 * fleets saturate? Run: npx tsx sim/src/growth.ts [games]
 * Per game (bots): how far demand grew, the minute idle trucks first passed 15%, trucks at the end,
 * trucks bought after saturating, deliveries and dividends.
 */
import { type Game, type GameConfigOverrides } from '@sr/core';
import { runGame } from './runner.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const games = Number(process.argv[2] ?? 12);

function setup(label: string, extra: GameConfigOverrides) {
  console.log(`\n### ${label}\n`);
  console.log('| Game | Demand grew to | Saturated at (idle > 15%) | Trucks at end | Bought after saturating | Deliveries | Dividends |');
  console.log('|---|---|---|---|---|---|---|');
  const sat: number[] = [];
  for (let i = 0; i < games; i++) {
    let growth = 1;
    let saturated = -1;
    let after = 0;
    let trucks = 0;
    const idle: number[] = [];
    const r = runGame({ ...extra, seed: 1 + i }, [], (g: Game) => {
      if (g.phase !== 'running') return;
      for (const e of g.peekEvents(0)) if (e.type === 'boughtTruck' && saturated >= 0) after++;
      if (Math.abs(g.t % 10) < 0.05) {
        const all = g.trucks.trucks;
        idle.push(all.filter((t) => t.orders.length === 0 && t.cargo === null).length / Math.max(1, all.length));
        // Idle over 15% across the last minute.
        if (saturated < 0 && idle.length >= 6 && avg(idle.slice(-6)) > 0.15) saturated = g.t / 60;
      }
      growth = g.demandGrowth();
      trucks = g.trucks.trucks.length;
    });
    if (saturated >= 0) sat.push(saturated);
    const base = (extra.orders?.bandDemand ?? [12, 22, 30]).reduce((a, b) => a + b, 0);
    console.log(
      `| ${i + 1} | ${Math.round(growth * base)} pallets | ${saturated < 0 ? 'never' : `minute ${saturated.toFixed(1)}`} | ${trucks} | ${after} | ${r.companies.reduce((s, c) => s + c.deliveries, 0)} | $${Math.round(r.payouts.reduce((a, b) => a + b, 0))} |`,
    );
  }
  console.log(`\nSaturated in ${sat.length}/${games} games, at minute ${avg(sat).toFixed(1)} on average (range ${Math.min(...sat).toFixed(1)}-${Math.max(...sat).toFixed(1)}).`);
}

setup('Fixed demand (no growth)', { orders: { growTo: [0, 0] } });
setup('Demand grows to a random level (80-130) by minute 12, at uneven paces', {});
