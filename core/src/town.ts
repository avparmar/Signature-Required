/**
 * The town: a street grid with gaps and a few diagonals, plus producers, consumers and depot
 * sites, one per block, reached from any street around their block. Generated from a seed; the same seed always gives the same town.
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
  /** The building's road node, in the middle of its block (driveways lead to each street around it). */
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
  /**
   * Street layout. 'grid': a full grid with a share of streets removed. 'suburb': main roads every
   * few blocks, with tree-like neighbourhood streets (dead ends, one or two ways out) between them.
   * 'snowflake': a big round city grid (with gaps) in the middle, eight avenues leaving it, and
   * tree-like neighbourhoods growing off each avenue. No ring roads: you go through the city.
   */
  layout: 'grid' | 'suburb' | 'snowflake';
  /** Share of grid streets removed (never disconnecting the town). Grid layout only. */
  removeFrac: number;
  /** Snowflake layout: radius of the city in the middle, in blocks. */
  cityRadius: number;
  /** Suburb layout: blocks between main roads. */
  mainRoadEvery: number;
  /** Suburb layout: ways out of each neighbourhood onto the main roads. */
  suburbExits: [number, number];
  /** Suburb layout: share of extra neighbourhood streets added back to make loops. */
  suburbLoops: number;
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
  /** A producer and a consumer of the same good are at least this many blocks apart (across + down). */
  pairGap: number;
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
  layout: 'grid',
  removeFrac: 0.12,
  mainRoadEvery: 4,
  cityRadius: 5,
  suburbExits: [1, 2],
  suburbLoops: 0.08,
  diagonalFrac: 0.04,
  goods: ['milk', 'bread', 'fuel'],
  producersPerGood: [4, 5],
  consumersPerGood: [7, 11],
  bays: 2,
  companies: 5,
  extraDepotSites: [6, 9],
  emptyLots: [20, 30],
  rivers: 0,
  bridgesPerRiver: [2, 3],
  minSpacing: 1,
  pairGap: 3,
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
  // Snowflake towns keep only the city, the avenues and their neighbourhoods; the other
  // intersections are left unused (and dropped from the final graph).
  if (cfg.layout === 'snowflake') edges = snowflakeStreets(W, H, cfg, rng);

  // Rivers: a meandering band of blocks across the town. Streets crossing it are cut, except a
  // few bridges, which are protected from the random removals below.
  const riverBlocks = new Set<string>();
  const bridges: [number, number][] = [];
  const protectedEdges = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const cut = new Set<string>();
  for (let r = 0; r < cfg.rivers; r++) {
    const vertical = rng.next() < 0.5;
    const len = vertical ? H : W; // blocks along the river's course
    const across = vertical ? W : H;
    const block = (k: number, c: number) => (vertical ? `${c},${k}` : `${k},${c}`);
    const mine = new Set<string>();
    // Course: one step along per block, drifting at most one block sideways (and never straight
    // back), so the river reads as one band. A sideways step floods both blocks in that column.
    let pos = rng.int(Math.floor(across * 0.3), Math.ceil(across * 0.7) - 1);
    let lastDrift = 0;
    for (let k = 0; k < len; k++) {
      mine.add(block(k, pos));
      const roll = rng.next();
      let drift = roll < 0.2 ? -1 : roll > 0.8 ? 1 : 0;
      if (drift === -lastDrift || pos + drift < 2 || pos + drift > across - 3) drift = 0;
      if (drift !== 0 && k < len - 1) {
        pos += drift;
        mine.add(block(k, pos));
      }
      if (drift !== 0) lastDrift = drift;
    }
    for (const b of mine) riverBlocks.add(b);
    // Every street with this river's water on both sides crosses it. Keep a few as bridges,
    // spread out along the river; cut the rest.
    const wetAt = (i: number, j: number) => mine.has(`${i},${j}`);
    const crossings: { e: [number, number]; along: number }[] = [];
    for (const e of edges) {
      const [a, b] = e;
      const ai = a % (W + 1), aj = Math.floor(a / (W + 1));
      const bi = b % (W + 1), bj = Math.floor(b / (W + 1));
      const wet =
        aj === bj
          ? wetAt(Math.min(ai, bi), aj - 1) && wetAt(Math.min(ai, bi), aj)
          : wetAt(ai - 1, Math.min(aj, bj)) && wetAt(ai, Math.min(aj, bj));
      if (wet) crossings.push({ e, along: vertical ? Math.min(aj, bj) : Math.min(ai, bi) });
    }
    crossings.sort((p, q) => p.along - q.along);
    const nb = rng.int(...cfg.bridgesPerRiver);
    const keep = new Set<number>();
    for (let q = 0; q < nb; q++) keep.add(Math.min(crossings.length - 1, Math.floor(((q + 0.5) / nb) * crossings.length)));
    crossings.forEach(({ e: [a, b] }, idx) => {
      const k = ekey(a, b);
      if (keep.has(idx) && !protectedEdges.has(k) && !cut.has(k)) {
        bridges.push([a, b]);
        protectedEdges.add(k);
      } else if (!protectedEdges.has(k)) cut.add(k);
    });
  }
  // Where two rivers meet, a street can have one river on each side: that's water too.
  for (const [a, b] of edges) {
    const ai = a % (W + 1), aj = Math.floor(a / (W + 1));
    const bi = b % (W + 1), bj = Math.floor(b / (W + 1));
    const wetAt = (i: number, j: number) => riverBlocks.has(`${i},${j}`);
    const wet =
      aj === bj
        ? wetAt(Math.min(ai, bi), aj - 1) && wetAt(Math.min(ai, bi), aj)
        : wetAt(ai - 1, Math.min(aj, bj)) && wetAt(ai, Math.min(aj, bj));
    // A diagonal street through a river block is underwater too.
    const diagWet = ai !== bi && aj !== bj && wetAt(Math.min(ai, bi), Math.min(aj, bj));
    if ((wet || diagWet) && !protectedEdges.has(ekey(a, b))) cut.add(ekey(a, b));
  }
  edges = edges.filter(([a, b]) => !cut.has(ekey(a, b)));
  if (cfg.layout === 'suburb') edges = suburbStreets(edges, W, H, cfg, rng, protectedEdges);

  if (!connectedIgnoringUnused(nodes.length, edges)) {
    // A river with too few bridges can split the town; reroll this attempt.
    return { cfg, graph: buildGraph([], []), river: [], bridges: [], locations: [], fairness: [], attempts: attempt, fair: false };
  }

  const target = cfg.layout === 'grid' ? Math.round(edges.length * cfg.removeFrac) : 0;
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
      // Suburbs get fewer diagonals, so they don't undo the neighbourhood structure; snowflakes
      // have their diagonal avenues already.
      if (cfg.layout === 'snowflake' || rng.next() >= cfg.diagonalFrac * (cfg.layout === 'suburb' ? 0.3 : 1)) continue;
      if (riverBlocks.has(`${i},${j}`)) continue; // no diagonals across a river
      diagonals.push(rng.next() < 0.5 ? [id(i, j), id(i + 1, j + 1)] : [id(i + 1, j), id(i, j + 1)]);
    }


  // Buildings sit in blocks, one per block, and are reached from every street around the block:
  // each of those streets gets a pull-in point halfway along, joined to the building by a short
  // driveway. Buildings are dead ends for routing, so nobody cuts across a block. Blocks with a
  // diagonal street or water stay empty.
  const streetSet = new Set(edges.map(([a, b]) => ekey(a, b)));
  const diagonalBlocks = new Set(
    diagonals.map(([a, b]) => `${Math.min(a % (W + 1), b % (W + 1))},${Math.min(Math.floor(a / (W + 1)), Math.floor(b / (W + 1)))}`),
  );
  const sidesOf = (i: number, j: number): [number, number][] =>
    (
      [
        [id(i, j), id(i + 1, j)],
        [id(i, j + 1), id(i + 1, j + 1)],
        [id(i, j), id(i, j + 1)],
        [id(i + 1, j), id(i + 1, j + 1)],
      ] as [number, number][]
    ).filter(([a, b]) => streetSet.has(ekey(a, b)));
  const blocks: { i: number; j: number; sides: [number, number][]; used: boolean }[] = [];
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      if (riverBlocks.has(`${i},${j}`) || diagonalBlocks.has(`${i},${j}`)) continue;
      const sides = sidesOf(i, j);
      if (sides.length) blocks.push({ i, j, sides, used: false });
    }
  const locations: Omit<Location, 'node'>[] = [];
  const blockOf: number[] = []; // location index -> block index

  const free = (p: Vec) => locations.every((l) => dist(l, p) >= cfg.minSpacing);
  const centre = (b: { i: number; j: number }): Vec => ({ x: b.i + 0.5, y: b.j + 0.5 });
  // Snowflake towns put businesses at the ends of their cul-de-sacs, and depots on through streets.
  const degree = new Map<number, number>();
  for (const [a, b] of [...edges, ...diagonals]) for (const n of [a, b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  const deadEnd = (b: { sides: [number, number][] }) => b.sides.some(([p, q]) => degree.get(p) === 1 || degree.get(q) === 1);
  const place = (loc: Omit<Location, 'node' | 'x' | 'y' | 'id'>, near?: Vec): boolean => {
    let candidates = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => !b.used && free(centre(b)) && pairOk(locations, loc.kind, loc.good, centre(b), cfg.pairGap));
    if (candidates.length === 0) return false;
    if (cfg.layout === 'snowflake') {
      const ends = candidates.filter(({ b }) => deadEnd(b));
      const through = candidates.filter(({ b }) => !deadEnd(b));
      if (loc.kind === 'depot' && through.length > 0) candidates = through;
      else if (loc.kind !== 'depot' && ends.length > 0 && rng.next() < 0.7) candidates = ends;
    }
    let pick;
    if (near) {
      candidates.sort((p, q) => dist(centre(p.b), near) - dist(centre(q.b), near));
      pick = candidates[Math.min(candidates.length - 1, rng.int(0, 2))];
    } else pick = rng.pick(candidates);
    pick.b.used = true;
    const p = centre(pick.b);
    locations.push({ ...loc, id: locations.length, x: p.x, y: p.y });
    blockOf.push(pick.i);
    return true;
  };

  // Starting depots, spread on an ellipse inset from the edges (corners first for 4).
  const cx = W / 2;
  const cy = H / 2;
  const offset = rng.next() * ((2 * Math.PI) / cfg.companies);
  for (let c = 0; c < cfg.companies; c++) {
    const a = offset + (c * 2 * Math.PI) / cfg.companies + Math.PI / 4;
    // Snowflake towns start everyone near the edge of the city, facing their own outskirts.
    const rad = cfg.layout === 'snowflake' ? 0.7 : 1;
    const p = { x: cx + Math.cos(a) * (cx - 1.5) * rad, y: cy + Math.sin(a) * (cy - 1.5) * rad };
    place({ kind: 'depot', good: null, level: 1, bays: 0, startCompany: c }, p);
  }
  cfg.goods.forEach((_, g) => {
    const np = rng.int(...cfg.producersPerGood);
    for (let k = 0; k < np; k++) place({ kind: 'producer', good: g, level: 1, bays: cfg.bays, startCompany: null });
    const nc = rng.int(...cfg.consumersPerGood);
    for (let k = 0; k < nc; k++) place({ kind: 'consumer', good: g, level: 1, bays: cfg.bays, startCompany: null });
  });
  const nd = rng.int(...cfg.extraDepotSites);
  // Spread spare depot sites out: each goes near the best of a few random spots, the one furthest
  // from every depot placed so far (so with only a handful of sites they don't bunch up).
  for (let k = 0; k < nd; k++) {
    const depots = locations.filter((l) => l.kind === 'depot');
    let best: Vec | null = null;
    let bestD = -1;
    for (let tries = 0; tries < 16; tries++) {
      const p = { x: 0.5 + rng.next() * (W - 1), y: 0.5 + rng.next() * (H - 1) };
      const d = Math.min(...depots.map((l) => Math.hypot(l.x - p.x, l.y - p.y)));
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    place({ kind: 'depot', good: null, level: 1, bays: 0, startCompany: null }, best ?? undefined);
  }
  const nl = rng.int(...cfg.emptyLots);
  for (let k = 0; k < nl; k++) place({ kind: 'lot', good: null, level: 0, bays: cfg.bays, startCompany: null });

  // Split each street that a building faces at its midpoint, and add the driveways.
  const allNodes: Vec[] = [...nodes];
  const midOf = new Map<string, number>(); // street key -> midpoint node
  for (const bi of blockOf)
    for (const [a, b] of blocks[bi].sides) {
      const k = ekey(a, b);
      if (midOf.has(k)) continue;
      midOf.set(k, allNodes.length);
      allNodes.push({ x: (nodes[a].x + nodes[b].x) / 2, y: (nodes[a].y + nodes[b].y) / 2 });
    }
  const finalEdges: [number, number][] = [];
  for (const [a, b] of edges) {
    const m = midOf.get(ekey(a, b));
    if (m === undefined) finalEdges.push([a, b]);
    else finalEdges.push([a, m], [m, b]);
  }
  finalEdges.push(...diagonals);
  const buildingNode: number[] = [];
  locations.forEach((l, li) => {
    const n = allNodes.length;
    allNodes.push({ x: l.x, y: l.y });
    buildingNode.push(n);
    for (const [a, b] of blocks[blockOf[li]].sides) finalEdges.push([n, midOf.get(ekey(a, b))!]);
  });
  // Bridges keep their ends; a bridge split by a building on its bank keeps its first half.
  for (const br of bridges) {
    const m = midOf.get(ekey(br[0], br[1]));
    if (m !== undefined) br[1] = m;
  }
  // Drop intersections no street uses (snowflake towns leave many), renumbering the rest.
  const live = new Map<number, number>();
  for (const [a, b] of finalEdges) for (const n of [a, b]) if (!live.has(n)) live.set(n, live.size);
  const keptNodes = [...live.keys()].sort((p, q) => p - q);
  keptNodes.forEach((n, k) => live.set(n, k));
  const graph = buildGraph(
    keptNodes.map((n) => allNodes[n]),
    finalEdges.map(([a, b]) => [live.get(a)!, live.get(b)!] as [number, number]),
    buildingNode.map((n) => live.get(n)!),
  );
  for (const br of bridges) {
    br[0] = live.get(br[0])!;
    br[1] = live.get(br[1])!;
  }
  const locs: Location[] = locations.map((l, i) => ({ ...l, node: live.get(buildingNode[i])! }));

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

/**
 * Suburb streets: keep the main roads (every `mainRoadEvery` grid lines) whole, and inside each
 * neighbourhood between them keep a random spanning tree of the local streets, a few ways out onto
 * the main roads, and a few extra streets for loops. Bridges are always kept.
 */
function suburbStreets(
  edges: [number, number][],
  W: number,
  H: number,
  cfg: TownConfig,
  rng: Rng,
  keepAlways: Set<string>,
): [number, number][] {
  const A = cfg.mainRoadEvery;
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const xy = (n: number) => ({ i: n % (W + 1), j: Math.floor(n / (W + 1)) });
  const onMainX = (i: number) => i % A === 0 || i === W; // a vertical main road runs along x = i
  const onMainY = (j: number) => j % A === 0 || j === H;
  const isMain = (n: number) => {
    const { i, j } = xy(n);
    return onMainX(i) || onMainY(j);
  };
  const mainEdge = ([a, b]: [number, number]) => {
    const p = xy(a);
    const q = xy(b);
    return (p.i === q.i && onMainX(p.i)) || (p.j === q.j && onMainY(p.j));
  };
  const cellOf = (n: number) => {
    const { i, j } = xy(n);
    return `${Math.floor(i / A)},${Math.floor(j / A)}`;
  };

  const kept: [number, number][] = [];
  const cells = new Map<string, { inner: [number, number][]; exits: [number, number][] }>();
  for (const e of edges) {
    if (mainEdge(e) || keepAlways.has(ekey(e[0], e[1]))) {
      kept.push(e);
      continue;
    }
    // A local street: inside one neighbourhood (both ends off the main roads), or an exit.
    const [a, b] = e;
    const inner = isMain(a) ? b : a;
    const key = cellOf(inner);
    if (!cells.has(key)) cells.set(key, { inner: [], exits: [] });
    const c = cells.get(key)!;
    if (isMain(a) || isMain(b)) c.exits.push(e);
    else c.inner.push(e);
  }

  // Union-find over road nodes for the spanning trees.
  const parent = new Map<number, number>();
  const find = (n: number): number => {
    let r = n;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(n, r);
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent.set(ra, rb);
    return true;
  };

  for (const { inner, exits } of [...cells.values()]) {
    const spare: [number, number][] = [];
    for (const e of rng.shuffle([...inner])) {
      if (union(e[0], e[1])) kept.push(e);
      else spare.push(e);
    }
    // Ways out: at least one per separate piece of the neighbourhood (a river can split one).
    const shuffled = rng.shuffle([...exits]);
    const want = rng.int(...cfg.suburbExits);
    const served = new Set<number>();
    let used = 0;
    const leftover: [number, number][] = [];
    for (const e of shuffled) {
      const inside = isMain(e[0]) ? e[1] : e[0];
      const piece = find(inside);
      if (!served.has(piece)) {
        served.add(piece);
        kept.push(e);
        used++;
      } else leftover.push(e);
    }
    for (const e of leftover) {
      if (used >= want) break;
      kept.push(e);
      used++;
    }
    for (const e of spare) if (rng.next() < cfg.suburbLoops) kept.push(e);
  }
  return kept;
}

/**
 * Snowflake streets on the grid: a big round city (grid with gaps) in the middle, eight avenues
 * leaving it (four along the grid, four diagonal), and neighbourhood streets branching off each
 * avenue along the grid and branching again. There are no ring roads: getting from one
 * neighbourhood to the next means going back through the city.
 * Returns the street list (grid street edges and diagonal avenue edges) over grid node ids.
 */
function snowflakeStreets(W: number, H: number, cfg: TownConfig, rng: Rng): [number, number][] {
  const id = (i: number, j: number) => j * (W + 1) + i;
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  const ok = (i: number, j: number) => i >= 0 && j >= 0 && i <= W && j <= H;
  const used = new Map<number, number>(); // node -> owner (-1 = city, k = avenue k's neighbourhood)
  const edges: [number, number][] = [];
  const have = new Set<string>();
  const ekey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const link = (a: number, b: number) => {
    if (have.has(ekey(a, b))) return;
    have.add(ekey(a, b));
    edges.push([a, b]);
  };

  // City: every grid street between nodes within cityRadius of the centre, then some knocked out.
  const Rc = cfg.cityRadius;
  const inCity = (i: number, j: number) => Math.hypot(i - cx, j - cy) <= Rc;
  const city: [number, number][] = [];
  for (let j = 0; j <= H; j++)
    for (let i = 0; i <= W; i++) {
      if (!inCity(i, j)) continue;
      used.set(id(i, j), -1);
      if (i < W && inCity(i + 1, j)) city.push([id(i, j), id(i + 1, j)]);
      if (j < H && inCity(i, j + 1)) city.push([id(i, j), id(i, j + 1)]);
    }
  const cityNodes = [...used.keys()];
  const remap = new Map(cityNodes.map((n, k) => [n, k]));
  const local = (es: [number, number][]) => es.map(([a, b]) => [remap.get(a)!, remap.get(b)!] as [number, number]);
  let removed = 0;
  const target = Math.round(city.length * cfg.removeFrac);
  for (const e of rng.shuffle([...city])) {
    if (removed >= target) break;
    const without = city.filter((x) => x !== e);
    if (isConnected(cityNodes.length, local(without))) {
      city.splice(city.indexOf(e), 1);
      removed++;
    }
  }
  for (const [a, b] of city) link(a, b);

  // Avenues: four along the grid and four diagonal, from the city's edge to the town's edge.
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  const avenues: { path: [number, number][]; d: [number, number] }[] = [];
  dirs.forEach((d, k) => {
    let [i, j] = [cx, cy];
    while (inCity(i + d[0], j + d[1])) [i, j] = [i + d[0], j + d[1]];
    const path: [number, number][] = [[i, j]];
    while (ok(i + d[0], j + d[1])) {
      const [ni, nj] = [i + d[0], j + d[1]];
      link(id(i, j), id(ni, nj));
      used.set(id(ni, nj), k);
      path.push([ni, nj]);
      [i, j] = [ni, nj];
    }
    avenues.push({ path, d });
  });

  // Neighbourhoods: streets grow along the grid from avenue nodes, turning and branching, onto
  // free intersections only, so neighbouring neighbourhoods never join up.
  const free = (i: number, j: number) => ok(i, j) && !used.has(id(i, j));
  const grow = (i: number, j: number, d: [number, number], len: number, owner: number) => {
    for (let s = 0; s < len; s++) {
      const [ni, nj] = [i + d[0], j + d[1]];
      if (!free(ni, nj)) return;
      link(id(i, j), id(ni, nj));
      used.set(id(ni, nj), owner);
      [i, j] = [ni, nj];
      if (rng.next() < 0.3) {
        const side: [number, number] = rng.next() < 0.5 ? [d[1], -d[0]] : [-d[1], d[0]];
        grow(i, j, side, rng.int(1, 3), owner);
      }
    }
  };
  avenues.forEach(({ path, d }, k) => {
    const diagonal = d[0] !== 0 && d[1] !== 0;
    // Side streets leave an axis avenue at right angles; a diagonal avenue sheds streets along both axes.
    const sides: [number, number][] = diagonal ? [[d[0], 0], [0, d[1]], [-d[0], 0], [0, -d[1]]] : [[d[1], -d[0]], [-d[1], d[0]]];
    for (let s = 1; s < path.length; s++)
      for (const side of rng.shuffle([...sides])) {
        if (rng.next() < 0.35) continue;
        grow(path[s][0], path[s][1], side, rng.int(2, 5), k);
      }
  });
  // Fill: grow more streets from any neighbourhood street end into space that's still empty.
  for (let pass = 0; pass < 2; pass++)
    for (const [n, owner] of rng.shuffle([...used.entries()])) {
      if (owner < 0 || rng.next() < 0.5) continue;
      const i = n % (W + 1);
      const j = Math.floor(n / (W + 1));
      const d = rng.pick<[number, number]>([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      grow(i, j, d, rng.int(1, 3), owner);
    }
  // A few small loops inside a neighbourhood: join two of its intersections that sit side by side.
  for (const [n, owner] of used) {
    if (owner < 0) continue;
    const i = n % (W + 1);
    const j = Math.floor(n / (W + 1));
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const m = id(i + di, j + dj);
      if (ok(i + di, j + dj) && used.get(m) === owner && !have.has(ekey(n, m)) && rng.next() < cfg.suburbLoops) link(n, m);
    }
  }
  return edges;
}

/** Like isConnected, but intersections no street touches don't count. */
function connectedIgnoringUnused(nodeCount: number, edges: [number, number][]): boolean {
  const ids = new Map<number, number>();
  for (const [a, b] of edges) for (const n of [a, b]) if (!ids.has(n)) ids.set(n, ids.size);
  void nodeCount;
  return isConnected(ids.size, edges.map(([a, b]) => [ids.get(a)!, ids.get(b)!] as [number, number]));
}

/**
 * Whether a producer or consumer of `good` may go at `p`: no consumer (for a producer) or producer
 * (for a consumer) of the same good within `gap` blocks across + down, so no trivially short routes.
 */
export function pairOk(
  locs: { kind: LocationKind; good: number | null; x: number; y: number }[],
  kind: LocationKind,
  good: number | null,
  p: Vec,
  gap: number,
): boolean {
  if (kind !== 'producer' && kind !== 'consumer') return true;
  const other = kind === 'producer' ? 'consumer' : 'producer';
  return locs.every((l) => l.kind !== other || l.good !== good || Math.abs(l.x - p.x) + Math.abs(l.y - p.y) >= gap);
}
