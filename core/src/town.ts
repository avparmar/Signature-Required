/**
 * The town: a street grid with gaps and a few diagonals, plus producers, consumers and depot
 * sites on lots along the streets. Generated from a seed; the same seed always gives the same town.
 */
import { buildGraph, dist, distancesFrom, isConnected, type RoadGraph, type Vec } from './graph.js';
import { Rng } from './rng.js';

/** `lot` is an empty lot: a place where a producer or consumer may open during the game. */
export type LocationKind = 'producer' | 'consumer' | 'depot' | 'lot';

export interface Location {
  id: number;
  kind: LocationKind;
  /** Index into TownConfig.goods (producers and consumers only). */
  good: number | null;
  /** Road node the location sits on (its driveway). */
  node: number;
  x: number;
  y: number;
  level: number;
  /** Trucks that can load/unload at once (producers and consumers). */
  bays: number;
  /** For starting depots: the company that starts here. */
  startCompany: number | null;
}

export interface TownConfig {
  seed: number;
  /** Blocks across and down. Intersections sit at integer coordinates 0..blocksX, 0..blocksY. */
  blocksX: number;
  blocksY: number;
  /** Share of grid streets removed (never disconnecting the town). */
  removeFrac: number;
  /** Share of blocks that get a diagonal street. */
  diagonalFrac: number;
  goods: string[];
  producersPerGood: [number, number];
  consumersPerGood: [number, number];
  bays: number;
  /** Number of delivery companies (N players + 1). Each gets a starting depot. */
  companies: number;
  extraDepotSites: [number, number];
  /** Empty lots where locations can open during the game. */
  emptyLots: [number, number];
  /** Rivers across the town (0 = none). Streets crossing a river are removed except for a few bridges. */
  rivers: number;
  /** Bridges per river. */
  bridgesPerRiver: [number, number];
  /** Minimum straight-line distance between any two locations, in blocks. */
  minSpacing: number;
  /** Drive distance (blocks) that counts as "near" a starting depot for the fairness check. */
  fairRadius: number;
  /** Weakest start's score must be at least this fraction of the strongest's. */
  fairMinRatio: number;
  maxRerolls: number;
}

export const DEFAULT_TOWN: TownConfig = {
  seed: 1,
  blocksX: 16,
  blocksY: 16,
  removeFrac: 0.12,
  diagonalFrac: 0.04,
  goods: ['milk', 'bread', 'fuel'],
  producersPerGood: [4, 5],
  consumersPerGood: [7, 11],
  bays: 2,
  companies: 5,
  extraDepotSites: [18, 27],
  emptyLots: [20, 30],
  rivers: 0,
  bridgesPerRiver: [2, 3],
  minSpacing: 1.2,
  fairRadius: 6,
  fairMinRatio: 0.6,
  maxRerolls: 60,
};

export function makeTownConfig(overrides: Partial<TownConfig> = {}): TownConfig {
  return { ...DEFAULT_TOWN, ...overrides };
}

export interface StartFairness {
  company: number;
  /** Producers and consumers within fairRadius (drive distance). */
  nearby: number;
  /** Goods with both a producer and a consumer within fairRadius. */
  pairs: number;
  score: number;
}

export interface Town {
  cfg: TownConfig;
  graph: RoadGraph;
  /** Blocks a river runs through (block i, j spans x i..i+1, y j..j+1), for drawing. */
  river: { i: number; j: number }[];
  /** Streets that are bridges over a river (pairs of node ids). */
  bridges: [number, number][];
  locations: Location[];
  fairness: StartFairness[];
  /** Attempts the generator needed (1 = first try). */
  attempts: number;
  /** False if no attempt met the fairness bar and the best one was used. */
  fair: boolean;
}

/** Generate a town. Rerolls (deterministically) until every start is reasonably fair. */
export function generateTown(cfg: TownConfig): Town {
  let best: Town | null = null;
  for (let attempt = 1; attempt <= cfg.maxRerolls; attempt++) {
    const rng = new Rng(cfg.seed * 1000003 + attempt * 7919);
    const town = tryGenerate(cfg, rng, attempt);
    if (town.fair) return town;
    if (!best || worstRatio(town) > worstRatio(best)) best = town;
  }
  return best!;
}

function worstRatio(t: Town) {
  const scores = t.fairness.map((f) => f.score);
  const max = Math.max(...scores);
  return max > 0 ? Math.min(...scores) / max : 0;
}

function tryGenerate(cfg: TownConfig, rng: Rng, attempt: number): Town {
  const { blocksX: W, blocksY: H } = cfg;
  const id = (i: number, j: number) => j * (W + 1) + i;
  const nodes: Vec[] = [];
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) nodes.push({ x: i, y: j });

  // Full grid, then knock out streets as long as the town stays connected.
  let edges: [number, number][] = [];
  for (let j = 0; j <= H; j++)
    for (let i = 0; i <= W; i++) {
      if (i < W) edges.push([id(i, j), id(i + 1, j)]);
      if (j < H) edges.push([id(i, j), id(i, j + 1)]);
    }
  // Rivers: a meandering band of blocks across the town. Streets crossing it are cut, except a
  // few bridges, which are protected from the random removals below.
  const riverBlocks = new Set<string>();
  const bridges: [number, number][] = [];
  const protectedEdges = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let r = 0; r < cfg.rivers; r++) {
    const vertical = rng.next() < 0.5;
    const len = vertical ? H : W; // blocks along the river's course
    const across = vertical ? W : H;
    const block = (k: number, c: number) => (vertical ? `${c},${k}` : `${k},${c}`);
    // Course: one step along per block, drifting at most one block sideways (and never straight
    // back), so the river reads as one band. A sideways step floods both blocks in that column.
    let pos = rng.int(Math.floor(across * 0.3), Math.ceil(across * 0.7) - 1);
    let lastDrift = 0;
    for (let k = 0; k < len; k++) {
      riverBlocks.add(block(k, pos));
      const roll = rng.next();
      let drift = roll < 0.2 ? -1 : roll > 0.8 ? 1 : 0;
      if (drift === -lastDrift || pos + drift < 2 || pos + drift > across - 3) drift = 0;
      if (drift !== 0 && k < len - 1) {
        pos += drift;
        riverBlocks.add(block(k, pos));
      }
      if (drift !== 0) lastDrift = drift;
    }
  }
  // Every street with water on both sides crosses a river. Keep a few per river as bridges,
  // spread out along it; cut the rest.
  const blockAt = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && riverBlocks.has(`${i},${j}`);
  const crossings: { e: [number, number] }[] = [];
  for (const e of edges) {
    const [a, b] = e;
    const ai = a % (W + 1), aj = Math.floor(a / (W + 1));
    const bi = b % (W + 1), bj = Math.floor(b / (W + 1));
    const wet =
      aj === bj
        ? blockAt(Math.min(ai, bi), aj - 1) && blockAt(Math.min(ai, bi), aj)
        : blockAt(ai - 1, Math.min(aj, bj)) && blockAt(ai, Math.min(aj, bj));
    if (wet) crossings.push({ e });
  }
  if (crossings.length > 0) {
    // Order along the dominant direction of the crossings and pick evenly spaced bridges.
    const xs = crossings.map((c) => c.e[0] % (W + 1));
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const ys = crossings.map((c) => Math.floor(c.e[0] / (W + 1)));
    const spreadY = Math.max(...ys) - Math.min(...ys);
    crossings.sort((p, q) =>
      spreadX >= spreadY ? p.e[0] % (W + 1) - q.e[0] % (W + 1) : Math.floor(p.e[0] / (W + 1)) - Math.floor(q.e[0] / (W + 1)),
    );
    const nb = cfg.rivers * rng.int(...cfg.bridgesPerRiver);
    const keep = new Set<number>();
    for (let q = 0; q < nb; q++) keep.add(Math.min(crossings.length - 1, Math.floor(((q + 0.5) / nb) * crossings.length)));
    const cut = new Set<string>();
    crossings.forEach(({ e: [a, b] }, idx) => {
      if (keep.has(idx)) {
        bridges.push([a, b]);
        protectedEdges.add(ekey(a, b));
      } else cut.add(ekey(a, b));
    });
    edges = edges.filter(([a, b]) => !cut.has(ekey(a, b)));
  }
  if (!isConnected(nodes.length, edges)) {
    // A river with too few bridges can split the town; reroll this attempt.
    return { cfg, graph: buildGraph([], []), river: [], bridges: [], locations: [], fairness: [], attempts: attempt, fair: false };
  }

  const target = Math.round(edges.length * cfg.removeFrac);
  let removed = 0;
  for (const e of rng.shuffle([...edges])) {
    if (removed >= target) break;
    if (protectedEdges.has(ekey(e[0], e[1]))) continue;
    const without = edges.filter((x) => x !== e);
    if (isConnected(nodes.length, without)) {
      edges = without;
      removed++;
    }
  }

  // A few diagonal shortcuts across blocks.
  const diagonals: [number, number][] = [];
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      if (rng.next() >= cfg.diagonalFrac) continue;
      if (riverBlocks.has(`${i},${j}`)) continue; // no diagonals across a river
      diagonals.push(rng.next() < 0.5 ? [id(i, j), id(i + 1, j + 1)] : [id(i + 1, j), id(i, j + 1)]);
    }

  // Lots sit at the middle of a straight street segment; placing one splits the segment.
  // Bridges never carry a lot, so they stay a single street end to end.
  const streets = edges.map(([a, b]) => ({ a, b, used: false, bridge: protectedEdges.has(ekey(a, b)) }));
  const locations: Omit<Location, 'node'>[] = [];
  const lotOf: number[] = []; // location index -> street index

  const free = (p: Vec) => locations.every((l) => dist(l, p) >= cfg.minSpacing);
  const mid = (s: { a: number; b: number }): Vec => ({
    x: (nodes[s.a].x + nodes[s.b].x) / 2,
    y: (nodes[s.a].y + nodes[s.b].y) / 2,
  });
  const place = (loc: Omit<Location, 'node' | 'x' | 'y' | 'id'>, near?: Vec): boolean => {
    let candidates = streets.map((s, i) => ({ s, i })).filter(({ s }) => !s.used && !s.bridge && free(mid(s)));
    if (candidates.length === 0) return false;
    let pick;
    if (near) {
      candidates.sort((p, q) => dist(mid(p.s), near) - dist(mid(q.s), near));
      pick = candidates[Math.min(candidates.length - 1, rng.int(0, 2))];
    } else pick = rng.pick(candidates);
    pick.s.used = true;
    const p = mid(pick.s);
    locations.push({ ...loc, id: locations.length, x: p.x, y: p.y });
    lotOf.push(pick.i);
    return true;
  };

  // Starting depots, spread on an ellipse inset from the edges (corners first for 4).
  const cx = W / 2;
  const cy = H / 2;
  const offset = rng.next() * ((2 * Math.PI) / cfg.companies);
  for (let c = 0; c < cfg.companies; c++) {
    const a = offset + (c * 2 * Math.PI) / cfg.companies + Math.PI / 4;
    const p = { x: cx + Math.cos(a) * (cx - 1.5), y: cy + Math.sin(a) * (cy - 1.5) };
    place({ kind: 'depot', good: null, level: 1, bays: 0, startCompany: c }, p);
  }
  cfg.goods.forEach((_, g) => {
    const np = rng.int(...cfg.producersPerGood);
    for (let k = 0; k < np; k++) place({ kind: 'producer', good: g, level: 1, bays: cfg.bays, startCompany: null });
    const nc = rng.int(...cfg.consumersPerGood);
    for (let k = 0; k < nc; k++) place({ kind: 'consumer', good: g, level: 1, bays: cfg.bays, startCompany: null });
  });
  const nd = rng.int(...cfg.extraDepotSites);
  for (let k = 0; k < nd; k++) place({ kind: 'depot', good: null, level: 1, bays: 0, startCompany: null });
  const nl = rng.int(...cfg.emptyLots);
  for (let k = 0; k < nl; k++) place({ kind: 'lot', good: null, level: 0, bays: cfg.bays, startCompany: null });

  // Split each used street at its midpoint with a lot node.
  const allNodes = [...nodes];
  const finalEdges: [number, number][] = [];
  const lotNode = new Map<number, number>(); // street index -> node
  streets.forEach((s, i) => {
    if (!s.used) {
      finalEdges.push([s.a, s.b]);
      return;
    }
    const n = allNodes.length;
    allNodes.push(mid(s));
    lotNode.set(i, n);
    finalEdges.push([s.a, n], [n, s.b]);
  });
  finalEdges.push(...diagonals);
  const graph = buildGraph(allNodes, finalEdges);
  const locs: Location[] = locations.map((l, i) => ({ ...l, node: lotNode.get(lotOf[i])! }));

  const fairness = scoreStarts(graph, locs, cfg);
  const scores = fairness.map((f) => f.score);
  const fair =
    fairness.every((f) => f.pairs >= 1) && Math.min(...scores) >= cfg.fairMinRatio * Math.max(...scores);
  const river = [...riverBlocks].map((k) => {
    const [i, j] = k.split(',').map(Number);
    return { i, j };
  });
  return { cfg, graph, river, bridges, locations: locs, fairness, attempts: attempt, fair };
}

/**
 * Open a producer or consumer on an empty lot (mutates the town). Returns the updated location.
 */
export function openOnLot(town: Town, lotId: number, kind: 'producer' | 'consumer', good: number): Location {
  const l = town.locations[lotId];
  if (!l || l.kind !== 'lot') throw new Error(`location ${lotId} is not an empty lot`);
  l.kind = kind;
  l.good = good;
  l.level = 1;
  return l;
}

/** Turn a closed producer or consumer back into an empty lot (mutates the town). */
export function clearToLot(town: Town, id: number): Location {
  const l = town.locations[id];
  if (!l || (l.kind !== 'producer' && l.kind !== 'consumer')) throw new Error(`location ${id} is not a producer or consumer`);
  l.kind = 'lot';
  l.good = null;
  l.level = 0;
  return l;
}

/** How good each starting depot's neighbourhood is. */
export function scoreStarts(graph: RoadGraph, locs: Location[], cfg: TownConfig): StartFairness[] {
  return locs
    .filter((l) => l.startCompany !== null)
    .sort((a, b) => a.startCompany! - b.startCompany!)
    .map((start) => {
      const d = distancesFrom(graph, start.node);
      const near = locs.filter((l) => (l.kind === 'producer' || l.kind === 'consumer') && d[l.node] <= cfg.fairRadius);
      let pairs = 0;
      cfg.goods.forEach((_, g) => {
        if (near.some((l) => l.kind === 'producer' && l.good === g) && near.some((l) => l.kind === 'consumer' && l.good === g))
          pairs++;
      });
      // Closer locations count for more; a full producer/consumer pair is worth a bonus.
      const score =
        near.reduce((s, l) => s + (1 - d[l.node] / (cfg.fairRadius + 1)), 0) + 2 * pairs;
      return { company: start.startCompany!, nearby: near.length, pairs, score };
    });
}
