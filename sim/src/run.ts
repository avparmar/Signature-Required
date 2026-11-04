/**
 * Headless runner. For now it generates and prints towns:
 *   npm run sim -- town [seed]           print one town
 *   npm run sim -- towns [count]         fairness stats over many seeds
 *   npm run sim -- game [seed]           run one (empty, for now) 15-minute game headless
 */
import { generateTown, makeTownConfig, newGame, renderTown } from '@sr/core';

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
} else {
  console.log('usage: npm run sim -- town [seed] | towns [count] | game [seed]');
}
