/** Treasury flow at each dividend, and who owns the shares, over bot games. Run: npm run treasury -- [games] */
import { Game, makeGameConfig } from '@sr/core';
import { runGame } from './runner.js';

const games = Number(process.argv[2] ?? 20);
const MARKS = 5;
type Acc = Record<string, number[]>;
const acc: Acc = {};
let gameRows: { c: number; k: string; i: number; v: number }[] = [];
const addRaw = (k: string, i: number, v: number) => ((acc[k] ??= new Array(MARKS + 1).fill(0))[i] += v);
let curCo = -1;
const add = (k: string, i: number, v: number) => { addRaw(k, i, v); gameRows.push({ c: curCo, k, i, v }); };
const z16 = () => new Array(16).fill(0);
const salesByMin = { bank: z16(), resale: z16(), bankPrice: z16(), resalePrice: z16(), buyback: z16(), buybackPrice: z16() };
let companyGames = 0;
let outsiderBuys = 0;
let runningSales = 0;
let firstFullControl: number[] = [];

let current: { income: number[]; auction: number[]; buyback: number[]; trucks: number[]; depots: number[]; truckSpend: number[]; depotSpend: number[] } | null = null;
const proto = Game.prototype as unknown as { emit: (to: unknown, e: any) => void };
const orig = proto.emit;
proto.emit = function (this: Game, to, e) {
  if (current && to === 'all') {
    if (e.type === 'delivered') current.income[e.company] += e.price * this.cfg.money.deliveryToTreasury;
    if (e.type === 'trade') {
      const m = Math.min(15, Math.floor(this.elapsed / 60));
      if (e.buyer === 'company') { current.buyback[e.company] += e.price; salesByMin.buyback[m]++; salesByMin.buybackPrice[m] += e.price; }
      else { salesByMin.resale[m]++; salesByMin.resalePrice[m] += e.price; }
    }
    if (e.type === 'saleWon') {
      current.auction[e.company] += e.amount;
      const m = Math.min(15, Math.floor(this.elapsed / 60));
      if (this.phase === 'running') {
        // Was the winner already leading before this share? (They've just been given it.)
        const sh = [...this.companies[e.company].shares];
        sh.splice(sh.lastIndexOf(e.player), 1);
        const cnt = new Map<number, number>();
        for (const o of sh) if (o !== null) cnt.set(o, (cnt.get(o) ?? 0) + 1);
        const lead = Math.max(0, ...cnt.values());
        if ((cnt.get(e.player) ?? 0) < lead || lead === 0) outsiderBuys++;
        runningSales++;
        salesByMin.bank[m]++;
        salesByMin.bankPrice[m] += e.amount;
      }
    }
    if (e.type === 'boughtTruck') { current.trucks[e.company]++; current.truckSpend[e.company] += e.price; }
    if (e.type === 'boughtDepot') { current.depots[e.company]++; current.depotSpend[e.company] += e.price; }
  }
  return orig.call(this, to, e);
};

for (let s = 0; s < games; s++) {
  const cfg = makeGameConfig({ seed: 1000 + s });
  const n = cfg.companies;
  const z = () => new Array(n).fill(0);
  current = { income: z(), auction: z(), buyback: z(), trucks: z(), depots: z(), truckSpend: z(), depotSpend: z() };
  const payTicks = Math.round(cfg.money.payoutEverySec / cfg.tickSec);
  let mark = 0;
  const fullAt = new Array(n).fill(-1);
  const sample = (g: Game, i: number) => {
    const c0 = current!;
    for (const c of g.companies) {
      curCo = c.id;
      const counts = new Map<number, number>();
      for (const o of c.shares) if (o !== null) counts.set(o, (counts.get(o) ?? 0) + 1);
      const top = Math.max(0, ...counts.values());
      const bank = c.shares.filter((x) => x === null).length;
      const prices = g.town.locations.filter((l) => l.kind === 'depot' && !g.depotOwner.has(l.id)).map((l) => g.depotPriceFor(c.id, l.id));
      add('treasury', i, c.treasury);
      add('pot', i, c.pot);
      add('income', i, c0.income[c.id]);
      add('auction', i, c0.auction[c.id]);
      add('buyback', i, c0.buyback[c.id]);
      add('truckSpend', i, c0.truckSpend[c.id]);
      add('depotSpend', i, c0.depotSpend[c.id]);
      add('truckBuys', i, c0.trucks[c.id]);
      add('depotBuys', i, c0.depots[c.id]);
      add('trucksOwned', i, g.trucks.trucks.filter((t) => t.company === c.id).length);
      add('depotsOwned', i, [...g.depotOwner.values()].filter((o) => o === c.id).length);
      add('bank', i, bank);
      add('top', i, top);
      add('holders', i, counts.size);
      add('freeSites', i, prices.length);
      add('cheapest', i, prices.length ? Math.min(...prices) : 0);
      add('canAfford', i, prices.length && c.treasury >= Math.min(...prices) ? 1 : 0);
      add('ownedOutright', i, top === c.shares.length ? 1 : 0);
      add('alive', i, c.shares.some((x) => x !== null) ? 1 : 0);
    }
    add('playerCash', i, g.players.reduce((a, p) => a + p.cash, 0) / g.players.length * g.companies.length / g.players.length);
    add('playerCashMax', i, Math.max(...g.players.map((p) => p.cash)) * g.companies.length / g.players.length);
    for (const k of Object.keys(c0) as (keyof typeof c0)[]) c0[k] = z();
  };
  let last: Game | null = null;
  runGame({ seed: 1000 + s }, [], (g) => {
    last = g;
    if (g.phase !== 'running') return;
    for (const c of g.companies) if (fullAt[c.id] < 0 && c.shares.every((x) => x !== null)) fullAt[c.id] = g.elapsed / 60;
    if (g.tick % payTicks === 0 && mark < MARKS) sample(g, mark++);
  });
  if (mark < MARKS && last) sample(last, mark++);
  const total = new Array(n).fill(0);
  for (const r of gameRows) if (r.k === 'income') total[r.c] += r.v;
  const order = [...total.keys()].sort((a, b) => total[b] - total[a]);
  for (const r of gameRows) if (r.c >= 0) addRaw(`r${order.indexOf(r.c)}:${r.k}`, r.i, r.v);
  gameRows = [];
  companyGames += n;
  firstFullControl.push(...fullAt);
}

const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
const row = (label: string, k: string, per = companyGames) => console.log(`| ${label} | ${acc[k].slice(0, MARKS).map((v) => f(v / per)).join(' | ')} |`);
console.log(`${games} games, ${companyGames} companies. Per company, at each dividend (minute 3, 6, 9, 12, 15):`);
console.log('| | 3 | 6 | 9 | 12 | 15 |\n|---|---|---|---|---|---|');
row('Treasury at the mark ($)', 'treasury');
row('Earned from deliveries since the last mark ($)', 'income');
row('Raised from share sales since the last mark ($)', 'auction');
row('Paid buying shares back since the last mark ($)', 'buyback');
row('Spent on trucks ($)', 'truckSpend');
row('Spent on factories ($)', 'depotSpend');
row('Trucks bought', 'truckBuys');
row('Factories bought', 'depotBuys');
row('Trucks owned', 'trucksOwned');
row('Factories owned', 'depotsOwned');
row('Unclaimed factory sites in town', 'freeSites');
row('Cheapest site for this company ($)', 'cheapest');
row('Share that could afford a site (%)', 'canAfford', companyGames / 100);
row('Shares the company owns', 'bank');
row('Shares held by the biggest holder', 'top');
row('Different shareholders', 'holders');
row('Owned outright by one player (%)', 'ownedOutright', companyGames / 100);
row('Average player cash ($)', 'playerCash', games * makeGameConfig({}).companies / makeGameConfig({}).players);
row('Richest player cash ($)', 'playerCashMax', games * makeGameConfig({}).companies / makeGameConfig({}).players);
console.log('\nShares changing hands by minute (all games): company sales / between players / bought back by the company, with average price');
for (let m = 0; m < 15; m++)
  console.log(`min ${m}: sold by companies ${salesByMin.bank[m]} @ $${f(salesByMin.bankPrice[m] / Math.max(1, salesByMin.bank[m]))}, between players ${salesByMin.resale[m]} @ $${f(salesByMin.resalePrice[m] / Math.max(1, salesByMin.resale[m]))}, bought back ${salesByMin.buyback[m]} @ $${f(salesByMin.buybackPrice[m] / Math.max(1, salesByMin.buyback[m]))}`);
const sold = firstFullControl.filter((x) => x >= 0).sort((a, b) => a - b);
console.log(`\nIn-game share sales: ${(runningSales / games).toFixed(1)} a game; won by someone who wasn't leading that company: ${(outsiderBuys / games).toFixed(1)} a game`);
console.log(`\nCompanies whose shares all left the bank: ${sold.length}/${companyGames}; median minute ${f(sold[Math.floor(sold.length / 2)] ?? NaN)}`);

console.log('\nBy company rank (total delivery income over the game): treasury / earned since last mark / spent since last mark / biggest holder / bank-held');
for (let r = 0; r < 5; r++) {
  const g = (k: string) => acc[`r${r}:${k}`].slice(0, MARKS).map((v) => v / games);
  const t = g('treasury'), inc = g('income'), sp = g('truckSpend').map((v, i) => v + g('depotSpend')[i]), top = g('top'), bank = g('bank'), fac = g('depotsOwned'), tr = g('trucksOwned');
  console.log(`#${r + 1}: ` + t.map((_, i) => `m${(i + 1) * 3} $${f(t[i])}/+${f(inc[i])}/-${f(sp[i])} own ${f(top[i])} bank ${f(bank[i])} ${f(tr[i])}T ${f(fac[i])}F`).join('  '));
}
