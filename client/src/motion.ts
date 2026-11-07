/**
 * Where trucks are drawn, frame by frame: exactly where the game has them, moving smoothly from
 * where they were at the last tick to where they are at this one (drawn a tick behind, so a truck
 * that starts or stops moving between ticks doesn't lurch). Nothing here decides where a truck goes; the game does (core trucks.ts and
 * kerbs.ts), including stopping in a building's line, moving up, U-turns and pulling out.
 *
 * - On the road: along its route in the right-hand lane, from the node it came from, rounding the
 *   corners (a half circle where it turns back the way it came).
 * - In a building's line: at its place along the street, in its lane, partway through a U-turn if
 *   it's changing lanes. A truck moving up past one that's stopped swings out into the other lane.
 */
import { berthGoal, kerbLine, linePoint, atGoal, type Berth, type KerbLine, type Observation, type TruckConfig } from '@sr/core';
import type { Renderer, Spot } from './render.js';

type Pt = { x: number; y: number };
type ObsTruck = Observation['trucks'][number];

export class TruckMotion {
  private lines = new Map<string, KerbLine | null>();
  /** Everyone's pose at the last two ticks we've seen. */
  private before = new Map<number, Spot>();
  private now = new Map<number, Spot>();
  private nowT = -Infinity;
  private gap = 0.1;

  constructor(private r: Renderer) {}

  reset() {
    this.lines.clear();
    this.before.clear();
    this.now.clear();
    this.nowT = -Infinity;
  }

  /**
   * Where to draw every truck: partway from its pose at the tick before to its pose at this one.
   * `ahead`: how far game time has run on since this tick (seconds), out of `tickSec`.
   */
  update(obs: Observation, ahead: number, cfg: TruckConfig, tickSec: number): Map<number, Spot> {
    if (obs.t !== this.nowT) {
      // A jump in time (a skip, or a new game): nothing to move from.
      // (Online, views can come a few ticks apart: move across the whole gap.)
      const gap = obs.t - this.nowT;
      this.before = gap > 0 && gap <= tickSec * 5 + 1e-9 ? this.now : new Map();
      this.gap = gap > 0 ? gap : tickSec;
      this.now = this.poses(obs, cfg);
      this.nowT = obs.t;
    }
    const f = Math.max(0, Math.min(1, ahead / Math.max(tickSec, this.gap)));
    const out = new Map<number, Spot>();
    for (const [id, b] of this.now) {
      const a = this.before.get(id);
      if (!a || Math.hypot(b.x - a.x, b.y - a.y) > 1) {
        out.set(id, b);
        continue;
      }
      // Facing: turned partway between the two.
      const la = Math.hypot(a.dx, a.dy) || 1;
      const lb = Math.hypot(b.dx, b.dy) || 1;
      out.set(id, { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dx: (a.dx / la) * (1 - f) + (b.dx / lb) * f, dy: (a.dy / la) * (1 - f) + (b.dy / lb) * f });
    }
    return out;
  }

  private line(building: number, kerb: number): KerbLine | null {
    const key = `${building}:${kerb}`;
    if (!this.lines.has(key)) this.lines.set(key, kerbLine(this.r.town.graph, building, kerb));
    return this.lines.get(key)!;
  }

  /** Where every truck is at this tick. */
  private poses(obs: Observation, cfg: TruckConfig): Map<number, Spot> {
    const out = new Map<number, Spot>();
    // Where everyone in a line is (carried on), to see who's moving past whom.
    const inLine = new Map<string, { id: number; s: number; side: string; moving: boolean }[]>();
    const berths = new Map<number, { line: KerbLine; b: Berth }>();
    for (const t of obs.trucks) {
      if (!t.berth) continue;
      const line = this.line(t.node, t.berth.kerb);
      if (!line) continue;
      const goal = berthGoal(line, t.berth, cfg);
      const b = t.berth;
      berths.set(t.id, { line, b });
      const key = `${t.node}:${t.berth.kerb}`;
      (inLine.get(key) ?? inLine.set(key, []).get(key)!).push({ id: t.id, s: b.s, side: b.side, moving: !atGoal(b, goal) });
    }
    for (const t of obs.trucks) {
      const at = berths.get(t.id);
      if (at) {
        // Swing out past a truck stopped in the same lane.
        let swing = 0;
        if (at.b.side === 'near' && at.b.turn === 0) {
          const me = inLine.get(`${t.node}:${t.berth!.kerb}`)!.find((x) => x.id === t.id)!;
          if (me.moving)
            for (const o of inLine.get(`${t.node}:${t.berth!.kerb}`)!) {
              if (o.id === t.id || o.moving || o.side !== 'near') continue;
              const f = 1 - Math.abs(o.s - me.s) / cfg.spacing;
              if (f > 0) swing = Math.max(swing, f * f * (3 - 2 * f));
            }
        }
        out.set(t.id, this.berthPose(at.line, at.b, cfg.lane, swing));
        continue;
      }
      out.set(t.id, this.roadPose(t, cfg.lane));
    }
    return out;
  }

  /** A truck in a line: in its lane at `s`, or partway through a U-turn; `swing` (0..1) out towards the other lane. */
  private berthPose(line: KerbLine, b: Pick<Berth, 's' | 'side' | 'turn'>, lane: number, swing: number): Spot {
    const g = this.r.town.graph;
    const c = linePoint(g, line, b.s);
    const lanePt = (side: 'near' | 'far') => {
      // Near lane: facing downstream (-u); far lane: facing upstream (u). Keep right.
      const h = side === 'near' ? { x: -c.ux, y: -c.uy } : { x: c.ux, y: c.uy };
      return { x: c.x - h.y * lane, y: c.y + h.x * lane, dx: h.x, dy: h.y };
    };
    const from = lanePt(b.side);
    if (!b.turn) {
      if (!swing) return from;
      const to = lanePt(b.side === 'near' ? 'far' : 'near');
      return { x: from.x + (to.x - from.x) * swing * 0.9, y: from.y + (to.y - from.y) * swing * 0.9, dx: from.dx, dy: from.dy };
    }
    // Half a circle across the road, bulging the way it was going.
    const to = lanePt(b.side === 'near' ? 'far' : 'near');
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2;
    const rx = (from.x - cx) / lane;
    const ry = (from.y - cy) / lane;
    const th = b.turn * Math.PI;
    return {
      x: cx + rx * lane * Math.cos(th) + from.dx * lane * Math.sin(th),
      y: cy + ry * lane * Math.cos(th) + from.dy * lane * Math.sin(th),
      dx: -rx * Math.sin(th) + from.dx * Math.cos(th),
      dy: -ry * Math.sin(th) + from.dy * Math.cos(th),
    };
  }

  /** A truck on the road: from the node it came from, through the node it's at, along its route. */
  private roadPose(t: ObsTruck, lane: number): Spot {
    const g = this.r.town.graph;
    const nodes: Pt[] = [];
    const push = (n: number) => {
      if (g.terminal[n]) return;
      const p = g.nodes[n];
      const last = nodes[nodes.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) nodes.push(p);
    };
    push(t.from);
    const before = nodes.length ? Math.hypot(g.nodes[t.node].x - nodes[0].x, g.nodes[t.node].y - nodes[0].y) : 0;
    push(t.node);
    if (t.state === 'driving') for (const n of t.path) push(n);
    if (!nodes.length) return { x: t.x, y: t.y, dx: 1, dy: 0 };
    return poseAlong(nodes, before + t.progress, lane);
  }
}

/** Where a truck is `dist` along a line of road points, in the right-hand lane, rounding the corners. */
export function poseAlong(nodes: Pt[], dist: number, lane: number): Spot {
  if (nodes.length === 1) return { x: nodes[0].x, y: nodes[0].y, dx: 1, dy: 0 };
  const segs: { a: Pt; b: Pt; u: Pt; len: number; at: number }[] = [];
  let at = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    segs.push({ a, b, u: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, len, at });
    at += len;
  }
  if (!segs.length) return { x: nodes[0].x, y: nodes[0].y, dx: 1, dy: 0 };
  dist = Math.max(0, Math.min(dist, at));
  const right = (u: Pt) => ({ x: -u.y, y: u.x });
  // A corner: how far either side of each junction the turn takes.
  const R = (i: number) => Math.min(0.2, segs[i].len / 2, segs[i + 1].len / 2);
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    const n = segs[i + 1];
    const dot = s.u.x * n.u.x + s.u.y * n.u.y;
    if (dot > 0.999) continue; // straight on
    const rc = R(i);
    const j = s.at + s.len;
    if (dist < j - rc || dist > j + rc) continue;
    const V = s.b;
    if (dot < -0.999) {
      // Back the way it came: half a circle across the road, just before the junction.
      const ra = right(s.u);
      const C = { x: V.x - s.u.x * rc, y: V.y - s.u.y * rc };
      const th = ((dist - (j - rc)) / (2 * rc)) * Math.PI;
      return {
        x: C.x + ra.x * lane * Math.cos(th) + s.u.x * lane * Math.sin(th),
        y: C.y + ra.y * lane * Math.cos(th) + s.u.y * lane * Math.sin(th),
        dx: -ra.x * Math.sin(th) + s.u.x * Math.cos(th),
        dy: -ra.y * Math.sin(th) + s.u.y * Math.cos(th),
      };
    }
    // A turn: a smooth curve from one lane into the other.
    const ra = right(s.u);
    const rb = right(n.u);
    const S = { x: V.x - s.u.x * rc + ra.x * lane, y: V.y - s.u.y * rc + ra.y * lane };
    const E = { x: V.x + n.u.x * rc + rb.x * lane, y: V.y + n.u.y * rc + rb.y * lane };
    const K = { x: V.x + (ra.x + rb.x) * lane, y: V.y + (ra.y + rb.y) * lane };
    const tau = (dist - (j - rc)) / (2 * rc);
    const m = 1 - tau;
    return {
      x: m * m * S.x + 2 * m * tau * K.x + tau * tau * E.x,
      y: m * m * S.y + 2 * m * tau * K.y + tau * tau * E.y,
      dx: 2 * m * (K.x - S.x) + 2 * tau * (E.x - K.x),
      dy: 2 * m * (K.y - S.y) + 2 * tau * (E.y - K.y),
    };
  }
  // On a straight stretch.
  let k = segs.length - 1;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= segs[i].at + segs[i].len) {
      k = i;
      break;
    }
  }
  const s = segs[k];
  const f = dist - s.at;
  const ra = right(s.u);
  return { x: s.a.x + s.u.x * f + ra.x * lane, y: s.a.y + s.u.y * f + ra.y * lane, dx: s.u.x, dy: s.u.y };
}
