/**
 * Waiting lines at buildings ("berths").
 *
 * A building sits off the road, joined by a driveway to the kerb node mid-way along each street
 * round its block. Trucks don't drive into it: they stop on the street outside, in the lane next
 * to it (the near lane), facing the way that lane's traffic goes. Each street round a building has
 * its own line, running upstream from the kerb node (back the way traffic comes from, round corners
 * if it gets long). Positions on a line are `s`, distance upstream from the kerb node; the street
 * also runs on downstream past the kerb (negative `s`, down to `-back`) to the next junction,
 * `exit`, which is where trucks pull out to.
 *
 * Spots: the building's loading bays come first, either side of the driveway (bay 0 just past it,
 * so the next truck can stop just before it and both bays are used), then the queue behind.
 *
 * A truck in a line moves along it at truck speed; changing lanes, it U-turns across the road (a
 * half circle of radius `lane`). All of this is game state, so the client draws exactly what's here.
 */
import type { RoadGraph } from './graph.js';

export interface KerbLine {
  building: number;
  kerb: number;
  /** Road nodes from the kerb upstream. */
  pts: number[];
  /** Distance along the line to each of `pts`. */
  cum: number[];
  /** How far the street runs on downstream past the kerb, to `exit` (0 if it doesn't). */
  back: number;
  /** Where trucks pull out to: the next node downstream (the kerb itself if there's none). */
  exit: number;
}

/** A truck stopped in (or driving along) a building's line. */
export interface Berth {
  /** The street (kerb node) its line is on. The building is the truck's `node`. */
  kerb: number;
  /** Distance upstream from the kerb node. */
  s: number;
  /** Lane: next to the building (facing downstream) or the other one (facing upstream). */
  side: 'near' | 'far';
  /** Partway through a U-turn from `side` to the other lane (0 to 1), or 0. */
  turn: number;
  /** Its spot in the line (0, 1, ...: bays first, then the queue). */
  spot: number;
  /** Pulling out: driving to the exit, then on along its route. */
  leaving: boolean;
  /** Joining order, for keeping places in the line. */
  seq: number;
}

/** Line geometry: spots are `spacing` apart; lanes are `lane` either side of the centre line. */
export interface LineConfig {
  spacing: number;
  lane: number;
}

export const DEFAULT_LINES: LineConfig = { spacing: 0.575, lane: 0.0775 };

/** The first kerb of a building (for trucks that start there, like new ones at a depot). */
export function defaultKerb(g: RoadGraph, building: number): number | undefined {
  return g.adj[building].find((e) => !g.terminal[e.to])?.to;
}

export function kerbLine(g: RoadGraph, building: number, kerb: number): KerbLine | null {
  const B = g.nodes[building];
  const K = g.nodes[kerb];
  if (!B || !K) return null;
  const nl = Math.hypot(B.x - K.x, B.y - K.y) || 1;
  const n = { x: (B.x - K.x) / nl, y: (B.y - K.y) / nl };
  // Keep right: the near lane's traffic goes (n.y, -n.x); the line runs the other way, upstream.
  let dir = { x: -n.y, y: n.x };
  const pts = [kerb];
  const cum = [0];
  let cur = kerb;
  let prev = building;
  while (cum[cum.length - 1] < 8) {
    let best = -1;
    let bestDot = 0.3;
    for (const e of g.adj[cur]) {
      if (e.to === prev || g.terminal[e.to]) continue;
      const v = { x: g.nodes[e.to].x - g.nodes[cur].x, y: g.nodes[e.to].y - g.nodes[cur].y };
      const len = Math.hypot(v.x, v.y) || 1;
      const dot = (v.x * dir.x + v.y * dir.y) / len;
      if (dot > bestDot) {
        bestDot = dot;
        best = e.to;
      }
    }
    if (best < 0) break;
    const a = g.nodes[cur];
    const b = g.nodes[best];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    pts.push(best);
    cum.push(cum[cum.length - 1] + len);
    prev = cur;
    cur = best;
  }
  if (pts.length < 2) return null;
  // Downstream: the street on past the kerb, the other way from the line's first stretch.
  const u = unit(g, pts[0], pts[1]);
  let back = 0;
  let exit = kerb;
  for (const e of g.adj[kerb]) {
    if (g.terminal[e.to] || e.to === pts[1]) continue;
    const v = unit(g, kerb, e.to);
    const len = Math.hypot(g.nodes[e.to].x - K.x, g.nodes[e.to].y - K.y);
    if (v.x * u.x + v.y * u.y < -0.7 && len > back) {
      back = len;
      exit = e.to;
    }
  }
  return { building, kerb, pts, cum, back, exit };
}

function unit(g: RoadGraph, a: number, b: number) {
  const A = g.nodes[a];
  const B = g.nodes[b];
  const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  return { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
}

/** Where spot `i` is on a line. Bay 0 is just past the driveway (as far as the street allows). */
export function spotS(line: KerbLine, i: number, cfg: LineConfig): number {
  const first = Math.max(-cfg.spacing / 2, -line.back);
  return Math.min(line.cum[line.cum.length - 1], first + i * cfg.spacing);
}

/** Where a truck in a line is heading: its spot, or, pulling out, halfway to the junction (where it's back on the road, before any corner there). */
export function berthGoal(line: KerbLine, b: Pick<Berth, 'spot' | 'leaving'>, cfg: LineConfig): { s: number; side: 'near' | 'far' } {
  return b.leaving ? { s: -line.back / 2, side: 'near' } : { s: spotS(line, b.spot, cfg), side: 'near' };
}

/** The point `s` along a line's centre, and the upstream direction there. */
export function linePoint(g: RoadGraph, line: KerbLine, s: number): { x: number; y: number; ux: number; uy: number } {
  s = Math.max(-line.back, Math.min(line.cum[line.cum.length - 1], s));
  let i = 0;
  while (i < line.pts.length - 2 && line.cum[i + 1] < s) i++;
  const a = g.nodes[line.pts[i]];
  const b = g.nodes[line.pts[i + 1]];
  const len = line.cum[i + 1] - line.cum[i] || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const t = s - line.cum[i];
  return { x: a.x + ux * t, y: a.y + uy * t, ux, uy };
}

/**
 * Move a truck along its line towards `goal` by up to `budget` (same lane: along the street; the
 * other lane: along, then a U-turn). The near lane runs downstream (s going down), the far lane
 * upstream. Changing lanes the way it faces: drive there, then U-turn; the other way: U-turn first.
 */
export function stepBerth<B extends Pick<Berth, 's' | 'side' | 'turn'>>(b: B, goal: { s: number; side: 'near' | 'far' }, budget: number, lane: number): B {
  const out = { ...b };
  for (let guard = 0; guard < 4 && budget > 1e-12; guard++) {
    const ds = goal.s - out.s;
    const turnFirst = out.side !== goal.side && (out.side === 'near' ? ds > 1e-9 : ds < -1e-9);
    if (turnFirst || out.turn > 0) {
      const need = (1 - out.turn) * Math.PI * lane;
      if (budget < need) {
        out.turn += budget / (Math.PI * lane);
        return out;
      }
      budget -= need;
      out.turn = 0;
      out.side = out.side === 'near' ? 'far' : 'near';
      continue;
    }
    const mv = Math.sign(ds) * Math.min(Math.abs(ds), budget);
    out.s += mv;
    budget -= Math.abs(mv);
    if (out.side !== goal.side && Math.abs(goal.s - out.s) < 1e-9 && budget > 1e-12) {
      out.turn = 1e-9; // there: U-turn into the other lane
      continue;
    }
    break;
  }
  return out;
}

/** Whether a truck in a line is at its goal (in the lane, not turning). */
export function atGoal(b: Pick<Berth, 's' | 'side' | 'turn'>, goal: { s: number; side: 'near' | 'far' }): boolean {
  return b.turn === 0 && b.side === goal.side && Math.abs(b.s - goal.s) < 1e-6;
}
