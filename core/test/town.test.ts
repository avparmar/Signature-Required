import { describe, expect, it } from 'vitest';
import { distancesFrom, generateTown, isConnected, makeTownConfig, renderTown, shortestPath } from '../src/index.js';

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
    for (let s = 1; s <= 6; s++) {
      const t = town(s);
      const g = t.graph;
      expect(isConnected(g.nodes.length, g.edges.map((e) => [e.a, e.b]))).toBe(true);
      const d = distancesFrom(g, t.locations[0].node);
      for (const l of t.locations) expect(d[l.node]).toBeLessThan(Infinity);
    }
  }, SLOW);

  it('places the configured numbers of each kind of location', () => {
    for (let s = 1; s <= 6; s++) {
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
    for (let s = 1; s <= 8; s++) {
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
    // Driving is never shorter than a straight line (to a building: to its kerb, half a block short).
    for (const n of g.nodes) {
      const straight = Math.hypot(n.x - g.nodes[0].x, n.y - g.nodes[0].y) - (g.terminal[n.id] ? 0.5 : 0);
      expect(d[n.id]).toBeGreaterThanOrEqual(straight - 1e-9);
    }
  });
});

describe('rivers', () => {
  it('one by default; none when turned off', () => {
    expect(town(3).river.length).toBeGreaterThan(0);
    expect(town(3).bridges.length).toBeGreaterThan(0);
    const t = town(3, { rivers: 0 });
    expect(t.river).toEqual([]);
    expect(t.bridges).toEqual([]);
  });

  it(
    'cut every street across the water except the bridges, and the town stays connected',
    () => {
      for (const [seed, rivers] of [[1, 1], [2, 1], [3, 1], [5, 2], [6, 2]]) {
        const t = town(seed, { rivers });
        const W = t.cfg.blocksX;
        expect(t.river.length).toBeGreaterThanOrEqual(t.cfg.blocksY);
        expect(t.bridges.length).toBeGreaterThanOrEqual(rivers * t.cfg.bridgesPerRiver[0] - 2 * (rivers - 1)); // crossing rivers can share or lose a bridge
        expect(t.bridges.length).toBeLessThanOrEqual(rivers * t.cfg.bridgesPerRiver[1]);
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

describe('suburb layout', () => {
  it(
    'keeps the town connected, with dead ends, and works with rivers',
    () => {
      for (const [seed, rivers] of [[1, 0], [2, 1], [3, 2]]) {
        const t = town(seed, { layout: 'suburb', rivers });
        const { nodes, edges } = t.graph;
        expect(isConnected(nodes.length, edges.map((e) => [e.a, e.b]))).toBe(true);
        const degree = new Array(nodes.length).fill(0);
        for (const e of edges) {
          degree[e.a]++;
          degree[e.b]++;
        }
        // Dead ends at grid intersections (lot nodes always have degree 2).
        const deadEnds = degree.filter((d, n) => d === 1 && Number.isInteger(nodes[n].x) && Number.isInteger(nodes[n].y)).length;
        expect(deadEnds).toBeGreaterThan(10);
      }
    },
    SLOW,
  );
});

describe('snowflake layout', () => {
  it(
    'is connected, has no ring roads, and keeps every street on the grid or a diagonal',
    () => {
      for (const seed of [1, 2, 3]) {
        const t = town(seed, { layout: 'snowflake', rivers: 0 });
        const { nodes, edges } = t.graph;
        expect(isConnected(nodes.length, edges.map((e) => [e.a, e.b]))).toBe(true);
        for (const e of edges) {
          const dx = Math.abs(nodes[e.a].x - nodes[e.b].x);
          const dy = Math.abs(nodes[e.a].y - nodes[e.b].y);
          expect(dx === 0 || dy === 0 || Math.abs(dx - dy) < 1e-9).toBe(true);
        }
        // Outside the city, neighbourhoods only meet via the avenues: removing the city cuts the
        // outskirts into several separate pieces.
        const c = t.cfg.blocksX / 2;
        const outside = (n: number) => Math.hypot(nodes[n].x - c, nodes[n].y - c) > t.cfg.cityRadius + 0.5;
        const ids = new Map<number, number>();
        nodes.forEach((_, n) => outside(n) && ids.set(n, ids.size));
        const outer = edges.filter((e) => outside(e.a) && outside(e.b)).map((e) => [ids.get(e.a)!, ids.get(e.b)!] as [number, number]);
        expect(isConnected(ids.size, outer)).toBe(false);
        expect(t.locations.length).toBeGreaterThan(40);
      }
    },
    SLOW,
  );
});

describe('buildings in blocks', () => {
  it('puts every building in the middle of its own block, with a driveway to each street around it', () => {
    const t = town(4);
    const { nodes, adj } = t.graph;
    const seen = new Set<string>();
    for (const l of t.locations) {
      expect(l.x % 1).toBeCloseTo(0.5);
      expect(l.y % 1).toBeCloseTo(0.5);
      const key = `${l.x},${l.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(t.graph.terminal[l.node]).toBe(true);
      // Driveways lead to street midpoints half a block away (and cost nothing to drive).
      expect(adj[l.node].length).toBeGreaterThanOrEqual(1);
      for (const { to } of adj[l.node]) {
        expect(Math.hypot(nodes[to].x - l.x, nodes[to].y - l.y)).toBeCloseTo(0.5);
        expect(t.graph.terminal[to]).toBe(false);
      }
    }
  });

  it("never routes through a building (no cutting across a block)", () => {
    const t = town(4);
    for (const l of t.locations.slice(0, 20)) {
      const ends = t.graph.adj[l.node].map((x) => x.to);
      if (ends.length < 2) continue;
      const path = shortestPath(t.graph, ends[0], ends[1])!;
      expect(path.slice(1, -1)).not.toContain(l.node);
    }
    // And no route between two other places passes through any building.
    const a = t.locations[0].node;
    for (const l of t.locations.slice(1)) {
      const path = shortestPath(t.graph, a, l.node)!;
      for (const n of path.slice(1, -1)) expect(t.graph.terminal[n]).toBe(false);
    }
  });
});

describe('trading partners apart', () => {
  it('never puts a producer within pairGap blocks of a consumer of the same good', () => {
    for (const seed of [1, 2, 3]) {
      const t = town(seed);
      const ps = t.locations.filter((l) => l.kind === 'producer');
      const cs = t.locations.filter((l) => l.kind === 'consumer');
      for (const p of ps)
        for (const c of cs) if (p.good === c.good) expect(Math.abs(p.x - c.x) + Math.abs(p.y - c.y)).toBeGreaterThanOrEqual(t.cfg.pairGap);
    }
  });
});
