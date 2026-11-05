import { describe, expect, it } from 'vitest';
import { distancesFrom, generateTown, isConnected, makeTownConfig, renderTown } from '../src/index.js';

// 16x16 towns take a few hundred ms each to generate, so the multi-seed tests get more time.
const SLOW = 60_000;

const town = (seed: number, o = {}) => generateTown(makeTownConfig({ seed, ...o }));

describe('generateTown', () => {
  it('is deterministic: same seed, same town', () => {
    const a = town(5);
    const b = town(5);
    expect(renderTown(a)).toEqual(renderTown(b));
    expect(a.locations).toEqual(b.locations);
  });

  it('gives different towns for different seeds', () => {
    expect(renderTown(town(1))).not.toEqual(renderTown(town(2)));
  });

  it('keeps the road network connected, so every location is reachable', () => {
    for (let s = 1; s <= 12; s++) {
      const t = town(s);
      const g = t.graph;
      expect(isConnected(g.nodes.length, g.edges.map((e) => [e.a, e.b]))).toBe(true);
      const d = distancesFrom(g, t.locations[0].node);
      for (const l of t.locations) expect(d[l.node]).toBeLessThan(Infinity);
    }
  }, SLOW);

  it('places the configured numbers of each kind of location', () => {
    for (let s = 1; s <= 12; s++) {
      const t = town(s);
      const { goods, producersPerGood: [p0, p1], consumersPerGood: [c0, c1], companies, extraDepotSites: [d0, d1] } = t.cfg;
      goods.forEach((_, g) => {
        const p = t.locations.filter((l) => l.kind === 'producer' && l.good === g).length;
        const c = t.locations.filter((l) => l.kind === 'consumer' && l.good === g).length;
        expect(p).toBeGreaterThanOrEqual(p0);
        expect(p).toBeLessThanOrEqual(p1);
        expect(c).toBeGreaterThanOrEqual(c0);
        expect(c).toBeLessThanOrEqual(c1);
      });
      const starts = t.locations.filter((l) => l.startCompany !== null).map((l) => l.startCompany).sort();
      expect(starts).toEqual(Array.from({ length: companies }, (_, i) => i));
      const extra = t.locations.filter((l) => l.kind === 'depot' && l.startCompany === null).length;
      expect(extra).toBeGreaterThanOrEqual(d0);
      expect(extra).toBeLessThanOrEqual(d1);
    }
  }, SLOW);

  it('keeps locations apart and gives producers/consumers their bays', () => {
    const t = town(3);
    for (const a of t.locations)
      for (const b of t.locations)
        if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(t.cfg.minSpacing - 1e-9);
    for (const l of t.locations) if (l.kind !== 'depot') expect(l.bays).toBe(t.cfg.bays);
  });

  it('gives every start a fair neighbourhood', () => {
    for (let s = 1; s <= 20; s++) {
      const t = town(s);
      expect(t.fair).toBe(true);
      for (const f of t.fairness) expect(f.pairs).toBeGreaterThanOrEqual(1);
      const scores = t.fairness.map((f) => f.score);
      expect(Math.min(...scores)).toBeGreaterThanOrEqual(t.cfg.fairMinRatio * Math.max(...scores));
    }
  }, SLOW);

  it('respects other sizes and company counts', () => {
    const t = town(9, { blocksX: 8, blocksY: 6, companies: 3, fairRadius: 5 });
    expect(t.locations.filter((l) => l.startCompany !== null)).toHaveLength(3);
    for (const n of t.graph.nodes) {
      expect(n.x).toBeLessThanOrEqual(8);
      expect(n.y).toBeLessThanOrEqual(6);
    }
  });
});

describe('distancesFrom', () => {
  it('measures driving distance along streets', () => {
    const t = town(4);
    const g = t.graph;
    const d = distancesFrom(g, 0);
    expect(d[0]).toBe(0);
    // Driving is never shorter than a straight line.
    for (const n of g.nodes) expect(d[n.id]).toBeGreaterThanOrEqual(Math.hypot(n.x - g.nodes[0].x, n.y - g.nodes[0].y) - 1e-9);
  });
});

describe('rivers', () => {
  it('are off by default', () => {
    const t = town(3);
    expect(t.river).toEqual([]);
    expect(t.bridges).toEqual([]);
  });

  it(
    'cut every street across the water except the bridges, and the town stays connected',
    () => {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const t = town(seed, { rivers: 1 });
        const W = t.cfg.blocksX;
        expect(t.river.length).toBeGreaterThanOrEqual(t.cfg.blocksY);
        expect(t.bridges.length).toBeGreaterThanOrEqual(t.cfg.bridgesPerRiver[0]);
        expect(t.bridges.length).toBeLessThanOrEqual(t.cfg.bridgesPerRiver[1]);
        const wet = new Set(t.river.map((b) => `${b.i},${b.j}`));
        const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;
        const bridges = new Set(t.bridges.map(([a, b]) => key(a, b)));
        const { nodes, edges } = t.graph;
        let crossings = 0;
        for (const e of edges) {
          const a = nodes[e.a];
          const b = nodes[e.b];
          const water =
            a.y === b.y && Number.isInteger(a.y)
              ? wet.has(`${Math.floor(Math.min(a.x, b.x))},${a.y - 1}`) && wet.has(`${Math.floor(Math.min(a.x, b.x))},${a.y}`)
              : a.x === b.x && Number.isInteger(a.x)
                ? wet.has(`${a.x - 1},${Math.floor(Math.min(a.y, b.y))}`) && wet.has(`${a.x},${Math.floor(Math.min(a.y, b.y))}`)
                : wet.has(`${Math.floor(Math.min(a.x, b.x))},${Math.floor(Math.min(a.y, b.y))}`); // diagonal inside a block
          if (!water) continue;
          crossings++;
          // Only an unsplit bridge street may cross water.
          expect(bridges.has(key(e.a, e.b))).toBe(true);
          expect(e.a < (W + 1) * (t.cfg.blocksY + 1) && e.b < (W + 1) * (t.cfg.blocksY + 1)).toBe(true);
        }
        expect(crossings).toBe(t.bridges.length);
        expect(isConnected(nodes.length, edges.map((e) => [e.a, e.b]))).toBe(true);
        expect(renderTown(t)).toContain('~');
      }
    },
    SLOW,
  );
});
