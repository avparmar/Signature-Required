/**
 * Does holding back on trucks beat buying greedily when demand is low? Run:
 *   npx tsx sim/src/restraint.ts [games]
 * Same games, three ways: everyone greedy; one company restrained (buys only when none of its trucks
 * is idle and a truck pays for itself) against greedy rivals; everyone restrained. For the company
 * in question (rotating through the seats), its dividends per share, end treasury and trucks.
 */
import { type GameConfigOverrides } from '@sr/core';
import { Bot } from './bot.js';
import { runGame } from './runner.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const games = Number(process.argv[2] ?? 10);
const low: GameConfigOverrides = { orders: { growTo: [0, 0] } }; // demand stays at its starting 64 pallets

function trial(label: string, policy: (company: number, focus: number) => 'greedy' | 'default', extra: GameConfigOverrides = {}) {
  const rows: number[][] = [];
  for (let i = 0; i < games; i++) {
    const focus = i % 5;
    Bot.truckPolicy = (c) => policy(c, focus);
    const r = runGame({ ...low, ...extra, depots: { ...extra.depots }, seed: 1 + i });
    const c = r.companies[focus];
    const others = r.companies.filter((_, k) => k !== focus);
    rows.push([c.paidPerShare - c.bonusPerShare, c.treasury, c.trucks, c.deliveries, avg(others.map((o) => o.paidPerShare - o.bonusPerShare))]);
  }
  Bot.truckPolicy = null;
  const a = (k: number) => avg(rows.map((r) => r[k]));
  console.log(`| ${label} | $${a(0).toFixed(1)} | $${a(1).toFixed(0)} | ${a(2).toFixed(0)} | ${a(3).toFixed(0)} | $${a(4).toFixed(1)} |`);
}

console.log(`\nLow demand (fixed at 64 pallets), ${games} games each; "the company" rotates through the five seats.\n`);
console.log('| Setup | The company: dividends per share | End treasury | Trucks | Deliveries | Rivals: dividends per share |');
console.log('|---|---|---|---|---|---|');
const which = process.argv[3] ?? 'treasury';
const extra: GameConfigOverrides = which === 'pot' ? { depots: { upkeepFrom: 'pot', upkeepPerMin: Number(process.argv[4] ?? 0.4) } } : {};
console.log(`Running cost: $${extra.depots?.upkeepPerMin ?? 0.4}/min per truck, from the ${which === 'pot' ? 'dividend pot' : 'treasury'}.\n`);
trial('Everyone greedy', () => 'greedy', extra);
trial('The company restrained, rivals greedy', (c, f) => (c === f ? 'default' : 'greedy'), extra);
trial('The company greedy, rivals restrained', (c, f) => (c === f ? 'greedy' : 'default'), extra);
trial('Everyone restrained', () => 'default', extra);
