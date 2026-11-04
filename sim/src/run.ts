/**
 * Headless runner. For now it generates and prints towns:
 *   npm run sim -- town [seed]           print one town
 *   npm run sim -- towns [count]         fairness stats over many seeds
 *   npm run sim -- game [seed]           run one (empty, for now) 15-minute game headless
 *   npm run sim -- trucks [seed] [n]     each company runs n trucks on its nearest route (demo)
 */
import { distancesFrom, generateTown, makeTownConfig, newGame, renderTown } from '@sr/core';

const [cmd = 'town', arg] = process.argv.slice(2);

if (cmd === 'town') {
  const seed = Number(arg ?? 1);
  const t = generateTown(makeTownConfig({ seed }));
  const count = (k: string) => t.locations.filter((l) => l.kind === k).length;
  console.log(renderTown(t));
  console.log(
    `\nseed ${seed}: ${t.graph.nodes.length} nodes, ${t.graph.edges.length} streets, ` +
      `${count('producer')} producers, ${count('consumer')} consumers, ${count('depot')} depot sites ` +
      `(attempt ${t.attempts}${t.fair ? '' : ', NOT fair'})`,
  );
  for (const f of t.fairness)
    console.log(`  company ${f.company}: ${f.nearby} nearby, ${f.pairs} complete goods, score ${f.score.toFixed(1)}`);
  console.log('\nKey: M/B/F producer, m/b/f consumer (milk, bread, fuel), # depot site, 0-4 starting depots');
} else if (cmd === 'towns') {
  const n = Number(arg ?? 200);
  let unfair = 0;
  let attempts = 0;
  let worst = 1;
  for (let s = 1; s <= n; s++) {
    const t = generateTown(makeTownConfig({ seed: s }));
    if (!t.fair) unfair++;
    attempts += t.attempts;
    const sc = t.fairness.map((f) => f.score);
    worst = Math.min(worst, Math.min(...sc) / Math.max(...sc));
  }
  console.log(`${n} towns: ${unfair} not fair, avg attempts ${(attempts / n).toFixed(1)}, worst start ratio ${worst.toFixed(2)}`);
} else if (cmd === 'game') {
  const seed = Number(arg ?? 1);
  const t0 = performance.now();
  const g = newGame({ seed });
  const t1 = performance.now();
  g.runToEnd();
  const t2 = performance.now();
  console.log(
    `seed ${seed}: ${g.cfg.players} players, ${g.cfg.companies} companies, ${g.totalTicks} ticks ` +
      `(${g.cfg.durationSec}s game). Town ${(t1 - t0).toFixed(0)} ms, play ${(t2 - t1).toFixed(0)} ms. State ${g.stateHash()}.`,
  );
} else if (cmd === 'trucks') {
  const seed = Number(arg ?? 1);
  const perCompany = Number(process.argv[4] ?? 3);
  // Skips the opening auctions: shares are handed out directly below (bots arrive in #8).
  const g = newGame({ seed, auctions: { openingRound: false } });
  // No auctions or bots yet: make each player president of their own company and send its trucks
  // round the nearest producer -> consumer pair.
  for (let c = 0; c < g.cfg.players; c++) {
    g.companies[c].shares[0] = c;
    const depot = g.town.locations.find((l) => l.startCompany === c)!;
    const d = distancesFrom(g.town.graph, depot.node);
    const near = (kind: string, good?: number) =>
      g.town.locations.filter((l) => l.kind === kind && (good === undefined || l.good === good)).sort((a, b) => d[a.node] - d[b.node])[0];
    const p = near('producer');
    const q = near('consumer', p.good!);
    for (let i = 0; i < perCompany; i++) {
      const t = g.addTruck(c);
      g.act(c, { type: 'setOrders', truck: t.id, stops: [{ location: p.id, action: 'load' }, { location: q.id, action: 'unload' }] });
    }
  }
  const delivered = new Array(g.cfg.companies).fill(0);
  const t0 = performance.now();
  while (!g.done) {
    g.step();
    for (const e of g.drainEvents(0)) if (e.type === 'delivered') delivered[e.company]++;
  }
  const ms = performance.now() - t0;
  const grown = g.locations.filter((l) => l.growth > 0).length;
  const shrunk = g.locations.filter((l) => l.growth < 0).length;
  console.log(`seed ${seed}, ${perCompany} trucks per company, 15 minutes (${ms.toFixed(0)} ms):`);
  delivered.slice(0, g.cfg.players).forEach((n, c) =>
    console.log(
      `  company ${c}: ${n} pallets delivered (${(n / perCompany / 15).toFixed(2)} per truck per minute), ` +
        `treasury $${g.companies[c].treasury.toFixed(0)}; player ${c} (1 share) ends with $${g.players[c].cash.toFixed(2)}`,
    ),
  );
  console.log(`  locations grown: ${grown}, shrunk: ${shrunk}, unchanged: ${g.locations.length - grown - shrunk}`);
} else {
  console.log('usage: npm run sim -- town [seed] | towns [count] | game [seed] | trucks [seed] [n]');
}
