/**
 * Truck-spam against saving for an inward factory. Run:
 *   npx tsx sim/src/strategies.ts [games] [low|medium|high]
 * Spammer: buys a truck whenever it has room and money, and a factory (the cheapest) only when out of
 * room. Saver: keeps a small fleet and saves for a factory in the middle or centre of town, then grows
 * from there. Same games each way; "the company" rotates through the five seats.
 */
import { type Game, type GameConfigOverrides } from '@sr/core';
import { Bot } from './bot.js';
import { runGame } from './runner.js';

type Policy = 'greedy' | 'saver' | 'default';
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const games = Number(process.argv[2] ?? 10);
const level = process.argv[3] ?? 'low';
const growTo: [number, number] = level === 'high' ? [130, 130] : level === 'medium' ? [95, 95] : [0, 0];
const base: GameConfigOverrides = { orders: { growTo } };

function trial(label: string, policy: (company: number, focus: number) => Policy) {
  const rows: number[][] = [];
  for (let i = 0; i < games; i++) {
    const focus = i % 5;
    Bot.truckPolicy = (c) => policy(c, focus);
    let inward = 0;
    let firstInward = 15;
    const r = runGame({ ...base, seed: 1 + i }, [], (g: Game) => {
      for (const e of g.peekEvents(0)) if (e.type === 'boughtDepot' && e.company === focus && g.bandOf(e.site) <= 1) firstInward = Math.min(firstInward, g.t / 60);
      if (g.t > 899) inward = g.depotsOf(focus).filter((s) => g.bandOf(s) <= 1).length;
    });
    const c = r.companies[focus];
    const others = r.companies.filter((_, k) => k !== focus);
    rows.push([c.paidPerShare - c.bonusPerShare, c.treasury, c.trucks, c.depots, inward, firstInward, c.deliveries, avg(others.map((o) => o.paidPerShare - o.bonusPerShare))]);
  }
  Bot.truckPolicy = null;
  const a = (k: number) => avg(rows.map((r) => r[k]));
  const moved = rows.filter((r) => r[5] < 15).map((r) => r[5]);
  console.log(
    `| ${label} | $${a(0).toFixed(1)} | $${a(1).toFixed(0)} | ${a(2).toFixed(0)} | ${a(3).toFixed(1)} (${a(4).toFixed(1)} inward) | ${moved.length ? `min ${avg(moved).toFixed(1)}` : 'never'} | ${a(6).toFixed(0)} | $${a(7).toFixed(1)} |`,
  );
}

console.log(`\n### ${level} demand (${level === 'low' ? 'stays at 64 pallets' : `grows to ${growTo[0]} by minute 12`}), ${games} games each\n`);
console.log('| Setup | The company: dividends per share | End treasury | Trucks | Factories | First inward factory | Deliveries | Rivals: dividends per share |');
console.log('|---|---|---|---|---|---|---|---|');
trial('Everyone spams', () => 'greedy');
trial('The company saves, rivals spam', (c, f) => (c === f ? 'saver' : 'greedy'));
trial('The company spams, rivals save', (c, f) => (c === f ? 'greedy' : 'saver'));
trial('Everyone saves', () => 'saver');
trial('The company saves, rivals lean', (c, f) => (c === f ? 'saver' : 'default'));
