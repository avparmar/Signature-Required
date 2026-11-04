/** Road network: intersections and lots are nodes, street segments are edges. */

export interface Vec {
  x: number;
  y: number;
}

export interface RoadNode {
  id: number;
  x: number;
  y: number;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** Length in blocks. */
  length: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** For each node, the edges leaving it and where they go. */
  adj: { to: number; edge: number }[][];
}

export function dist(p: Vec, q: Vec): number {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** Build a graph (with adjacency) from plain node and edge lists; ids are re-assigned densely. */
export function buildGraph(nodes: Vec[], edges: [number, number][]): RoadGraph {
  const ns = nodes.map((n, id) => ({ id, x: n.x, y: n.y }));
  const es = edges.map(([a, b], id) => ({ id, a, b, length: dist(ns[a], ns[b]) }));
  const adj: { to: number; edge: number }[][] = ns.map(() => []);
  for (const e of es) {
    adj[e.a].push({ to: e.b, edge: e.id });
    adj[e.b].push({ to: e.a, edge: e.id });
  }
  return { nodes: ns, edges: es, adj };
}

/** True if every node can reach every other. */
export function isConnected(nodeCount: number, edges: [number, number][]): boolean {
  if (nodeCount === 0) return true;
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const seen = new Uint8Array(nodeCount);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of adj[n]) {
      if (!seen[m]) {
        seen[m] = 1;
        count++;
        stack.push(m);
      }
    }
  }
  return count === nodeCount;
}

/** Binary min-heap keyed by priority. */
class MinHeap {
  private items: { key: number; value: number }[] = [];
  get size() {
    return this.items.length;
  }
  push(value: number, key: number) {
    const it = this.items;
    it.push({ key, value });
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (it[p].key <= it[i].key) break;
      [it[p], it[i]] = [it[i], it[p]];
      i = p;
    }
  }
  pop(): { key: number; value: number } {
    const it = this.items;
    const top = it[0];
    const last = it.pop()!;
    if (it.length) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < it.length && it[l].key < it[m].key) m = l;
        if (r < it.length && it[r].key < it[m].key) m = r;
        if (m === i) break;
        [it[m], it[i]] = [it[i], it[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Driving distance (in blocks) from one node to every node. Unreachable nodes get Infinity. */
export function distancesFrom(g: RoadGraph, from: number): Float64Array {
  const d = new Float64Array(g.nodes.length).fill(Infinity);
  d[from] = 0;
  const heap = new MinHeap();
  heap.push(from, 0);
  while (heap.size) {
    const { key, value: n } = heap.pop();
    if (key > d[n]) continue;
    for (const { to, edge } of g.adj[n]) {
      const nd = key + g.edges[edge].length;
      if (nd < d[to]) {
        d[to] = nd;
        heap.push(to, nd);
      }
    }
  }
  return d;
}

/**
 * Shortest driving route between two nodes, as the list of nodes visited (from and to included).
 * Null if unreachable. Ties are broken deterministically.
 */
export function shortestPath(g: RoadGraph, from: number, to: number): number[] | null {
  if (from === to) return [from];
  const d = new Float64Array(g.nodes.length).fill(Infinity);
  const prev = new Int32Array(g.nodes.length).fill(-1);
  d[from] = 0;
  const heap = new MinHeap();
  heap.push(from, 0);
  while (heap.size) {
    const { key, value: n } = heap.pop();
    if (key > d[n]) continue;
    if (n === to) break;
    for (const { to: m, edge } of g.adj[n]) {
      const nd = key + g.edges[edge].length;
      if (nd < d[m] - 1e-12) {
        d[m] = nd;
        prev[m] = n;
        heap.push(m, nd);
      }
    }
  }
  if (d[to] === Infinity) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(prev[path[path.length - 1]]);
  return path.reverse();
}

/** Route through a sequence of nodes (start, waypoints..., end), joined into one node list. */
export function routeVia(g: RoadGraph, nodes: number[]): number[] | null {
  let route: number[] = [nodes[0]];
  for (let i = 1; i < nodes.length; i++) {
    const leg = shortestPath(g, nodes[i - 1], nodes[i]);
    if (!leg) return null;
    route = route.concat(leg.slice(1));
  }
  return route;
}

/** Length of the street between two adjacent nodes. */
export function edgeLength(g: RoadGraph, a: number, b: number): number {
  for (const { to, edge } of g.adj[a]) if (to === b) return g.edges[edge].length;
  throw new Error(`nodes ${a} and ${b} are not adjacent`);
}
