export class TruckMotion {
    r;
    drawn = new Map();
    speed = 0.35;
    frame = 0;
    lastT = -Infinity;
    constructor(r) {
        this.r = r;
    }
    reset() {
        this.drawn.clear();
    }
    /**
     * Where to draw every truck now. `ahead`: how far game time has run on since the observation
     * (seconds); `step`: how far a truck moves along a line this frame (blocks); `speed`: trucks' speed.
     */
    update(obs, ahead, step, speed) {
        const r = this.r;
        const g = r.town.graph;
        this.speed = speed;
        // A jump in game time (the tab was hidden, or a fast-forward): nothing to ease from.
        if (Math.abs(obs.t - this.lastT) > 1)
            this.frame += 2;
        this.lastT = obs.t;
        const out = new Map();
        const live = new Set();
        for (const t of obs.trucks) {
            live.add(t.id);
            let d = this.drawn.get(t.id);
            if (!d) {
                d = { line: null, lag: 0, trail: [], node: t.node, path: [...t.path], arrived: null };
                this.drawn.set(t.id, d);
            }
            if (t.node !== d.node) {
                // Moved on to the next node: the one it left joins the trail behind it (not a building).
                // Pulled in at a building: by the street its route came in on (the kerb next to it; the
                // driveway is so short it often reaches the kerb and the building in the same tick).
                if (g.terminal[t.node]) {
                    const from = [d.node, ...d.path].slice(0, Math.max(1, d.path.indexOf(t.node) + 1)).filter((n) => !g.terminal[n]).pop();
                    const kerb = d.heading?.node === t.node ? d.heading.kerb : from !== undefined && g.adj[t.node].some((e) => e.to === from) ? from : undefined;
                    d.arrived = kerb !== undefined ? { node: t.node, kerb } : null;
                }
                // The nodes it went through: the one it left, and any it passed in the same tick (a short
                // street, or a kerb on its way into a building), as its route had them.
                const passed = [d.node];
                const k = d.path.indexOf(t.node);
                if (k > 0)
                    passed.push(...d.path.slice(0, k));
                for (const n of passed) {
                    if (g.terminal[n])
                        continue;
                    this.link(d, n, false);
                    const p = g.nodes[n];
                    const last = d.trail[d.trail.length - 1];
                    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6)
                        d.trail.push({ x: p.x, y: p.y });
                }
                d.node = t.node;
                d.bridged = undefined;
                this.trimTrail(d);
            }
            d.path = [...t.path];
            // Heading for a building: remember which street it'll pull in from.
            const dest = t.path[t.path.length - 1];
            if (t.state === 'driving' && dest !== undefined && g.terminal[dest])
                d.heading = { node: dest, kerb: t.path.length >= 2 ? t.path[t.path.length - 2] : t.node };
        }
        const targets = r.truckTargets(obs, (id, node) => {
            const d = this.drawn.get(id);
            return d?.arrived?.node === node ? d.arrived.kerb : undefined;
        });
        for (const t of obs.trucks) {
            const d = this.drawn.get(t.id);
            const target = targets.get(t.id);
            // At (or stopping for) a building: in its line.
            // Waiting to pull out, already drawn on the road (it never got into the line): stays there.
            const leaving = t.state === 'driving' && t.path.length > 0 && !d.line;
            if (target?.parked && target.q && !leaving) {
                if (!d.line || d.line.node !== target.q.node || d.line.kerb !== target.q.kerb) {
                    // Still drawn behind on the road (it pulled out of somewhere close by): drive on up to
                    // the kerb first, then into the line.
                    if (!d.line && d.lag > 0)
                        d.lag = Math.max(0, d.lag - step * 1.5);
                    // From another building's line (next door): from where it's drawn there, or, if that's
                    // not on this street, out of that line and round to this one.
                    let here = (d.line && linePoint(r, d.line)) || this.roadPose(t, d, ahead);
                    let p = here ? r.queueProject(target.q.node, here.x, here.y, target.q.kerb) : null;
                    if (d.line && !(p && p.off < 0.2)) {
                        const line = d.line;
                        d.line = null;
                        this.leave(d, t, line, target.q.kerb, true, ahead);
                        here = this.roadPose(t, d, ahead);
                        p = here ? r.queueProject(target.q.node, here.x, here.y, target.q.kerb) : null;
                    }
                    if (!d.line && here && !(p && p.off < 0.2)) {
                        // Drawn on another street (it came in another way than it's drawn): on round to this one.
                        const end = d.trail[d.trail.length - 1];
                        const from = end ? this.nodeAt(end) : -1;
                        const kerb = target.q.kerb;
                        if (from >= 0 && kerb !== undefined && from !== kerb) {
                            let prev = end;
                            for (const n of roadPath(g, from, kerb).slice(1)) {
                                d.trail.push(g.nodes[n]);
                                d.lag += Math.hypot(g.nodes[n].x - prev.x, g.nodes[n].y - prev.y);
                                prev = g.nodes[n];
                            }
                            here = this.roadPose(t, d, ahead);
                            p = here ? r.queueProject(target.q.node, here.x, here.y, target.q.kerb) : null;
                        }
                    }
                    if (!d.line && d.lag > 0 && here && !(p && p.off < 0.2 && p.s <= target.q.s + 1e-6)) {
                        out.set(t.id, here);
                        continue;
                    }
                    d.line = p && p.off < 0.2 ? { node: target.q.node, kerb: target.q.kerb, s: p.s, side: p.side } : { ...target.q };
                    d.ease = true; // into the line from wherever it was drawn: ease across the gap
                }
                d.line = stepAlongLine(d.line, target.q, step, r.laneOffset);
                d.lag = 0;
                d.trail = [];
                const at = linePoint(r, d.line);
                if (at)
                    out.set(t.id, at);
                continue;
            }
            if (d.line) {
                // Pulling out: along the line to the kerb, then on along its route, drawn behind the
                // game's position and catching up.
                const line = d.line;
                d.line = null;
                this.leave(d, t, line, g.terminal[t.node] ? t.path[0] : t.node, false, ahead);
            }
            this.bridge(d, t);
            if (d.lag > 0)
                d.lag = Math.max(0, d.lag - step * 0.5);
            const pose = this.roadPose(t, d, ahead);
            if (pose)
                out.set(t.id, pose);
            else if (target)
                out.set(t.id, target);
        }
        for (const id of [...this.drawn.keys()])
            if (!live.has(id))
                this.drawn.delete(id);
        // Easing: where a truck changes from road to line, it's drawn from where it was, closing the gap quickly.
        this.frame++;
        const fade = Math.exp(-Math.max(0, step) / Math.max(1e-6, speed) / 0.15);
        for (const [id, sp] of out) {
            const d = this.drawn.get(id);
            if (d.ease && d.last && d.lastFrame === this.frame - 1)
                d.nudge = { x: d.last.x - sp.x, y: d.last.y - sp.y };
            d.ease = false;
            if (d.nudge) {
                if (Math.hypot(d.nudge.x, d.nudge.y) > 1.5)
                    d.nudge = undefined; // too far to slide: just be there
                else {
                    sp.x += d.nudge.x;
                    sp.y += d.nudge.y;
                    d.nudge = { x: d.nudge.x * fade, y: d.nudge.y * fade };
                    if (Math.hypot(d.nudge.x, d.nudge.y) < 1e-3)
                        d.nudge = undefined;
                }
            }
            d.last = { x: sp.x, y: sp.y };
            d.lastFrame = this.frame;
        }
        return out;
    }
    /**
     * Out of a building's line: its trail becomes the street from its place back to the kerb, then
     * round the block to the kerb it leaves by (`out`, a road node; included in the trail when
     * `withOut`, i.e. when the truck isn't on the road there yet), and it's drawn that far behind.
     */
    leave(d, t, line, out, withOut, ahead) {
        const r = this.r;
        const g = r.town.graph;
        const q = r.queueLine(line.node, line.kerb);
        if (!q)
            return;
        const pts = [];
        const from = r.queuePoint(line.node, line.s, 'near', line.kerb);
        // The street from its place back to the kerb, on the centre line.
        let k = q.cum.findIndex((c) => c >= line.s);
        if (k < 0)
            k = q.cum.length - 1;
        if (from) {
            const lane = r.laneOffset;
            pts.push({ x: from.x - -from.dy * lane, y: from.y - from.dx * lane });
        }
        for (let i = k - 1; i >= 1; i--)
            pts.push(q.pts[i]);
        pts.push(q.pts[0]);
        d.trail = pts;
        // Leaving by another street round the block: round the block to it, on the road.
        const waitedAt = line.kerb ?? r.defaultKerb(line.node);
        if (out !== undefined && waitedAt !== undefined && out !== waitedAt) {
            const way = roadPath(g, waitedAt, out).slice(1);
            if (!withOut)
                way.pop();
            for (const n of way)
                d.trail.push(g.nodes[n]);
        }
        // Drawn at its place: as far behind as the game has it from there.
        d.lag = this.trailLength(d, t) + (g.terminal[t.node] ? 0 : this.distAlong(t, ahead));
        d.bridged = this.route(t)[0];
    }
    /**
     * A truck still drawn on its way into a building when the game already has it pulling out (by
     * whichever street): the way on from where its trail ends to that street, added to the trail and
     * to how far behind it's drawn, so it carries on from where it is.
     */
    bridge(d, t) {
        const g = this.r.town.graph;
        const first = this.route(t)[0];
        if (first === undefined || !d.trail.length)
            return;
        // Pulling out of a building it hadn't been drawn reaching: the whole way on counts as behind.
        const whole = g.terminal[t.node] && d.bridged !== first;
        if (g.terminal[t.node])
            d.bridged = first;
        this.link(d, first, whole);
    }
    /**
     * No tunnelling: the trail's last point and `node` (next on the way) must be neighbours on the
     * road. If they aren't (the game cut through a building's driveways, or several streets went by
     * in one tick), the trail goes the long way round by the streets, and the truck is drawn further
     * behind by the extra distance (`whole`: by all of it), so it never jumps.
     */
    link(d, node, whole) {
        const g = this.r.town.graph;
        const end = d.trail[d.trail.length - 1];
        if (!end)
            return;
        const from = this.nodeAt(end);
        const N = g.nodes[node];
        const direct = Math.hypot(N.x - end.x, N.y - end.y);
        if (from < 0 || from === node) {
            if (whole)
                d.lag += direct;
            return;
        }
        if (!whole && g.adj[from].some((e) => e.to === node))
            return;
        const way = roadPath(g, from, node);
        let len = 0;
        let prev = end;
        for (const n of way.slice(1)) {
            if (n !== node)
                d.trail.push(g.nodes[n]);
            len += Math.hypot(g.nodes[n].x - prev.x, g.nodes[n].y - prev.y);
            prev = g.nodes[n];
        }
        d.lag += whole ? len : Math.max(0, len - direct);
    }
    /** The road node at a point (-1 if it isn't one). */
    nodeAt(p) {
        const g = this.r.town.graph;
        if (!this.nodeIndex || this.nodeIndexFor !== g) {
            this.nodeIndexFor = g;
            this.nodeIndex = new Map();
            g.nodes.forEach((n, i) => {
                if (!g.terminal[i])
                    this.nodeIndex.set(`${n.x},${n.y}`, i);
            });
        }
        return this.nodeIndex.get(`${p.x},${p.y}`) ?? -1;
    }
    nodeIndex;
    nodeIndexFor;
    /** How far a truck is along its current street (plus how far it has run on since the tick). */
    distAlong(t, ahead) {
        return t.state === 'driving' && t.path.length ? t.progress + ahead * this.speed : t.progress;
    }
    /** Length of the trail behind the truck, up to its current node. */
    trailLength(d, t) {
        const first = this.route(t)[0];
        const pts = first === undefined ? [...d.trail] : [...d.trail, this.r.town.graph.nodes[first]];
        let len = 0;
        for (let i = 1; i < pts.length; i++)
            len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return len;
    }
    /** Keep just enough trail: what it's still drawn on (its lag), plus the last junction to turn through. */
    trimTrail(d) {
        while (d.trail.length > 1) {
            let len = 0;
            for (let i = 2; i < d.trail.length; i++)
                len += Math.hypot(d.trail[i].x - d.trail[i - 1].x, d.trail[i].y - d.trail[i - 1].y);
            if (len < d.lag + 0.5)
                break;
            d.trail.shift();
        }
    }
    /** The road nodes a truck is at and will drive through, leaving out buildings (they sit off the road). */
    route(t) {
        const term = this.r.town.graph.terminal;
        return [t.node, ...(t.state === 'driving' ? t.path : [])].filter((n) => !term[n]);
    }
    /** A truck on the road: its trail, the node it's at and the rest of its route, and how far along that it's drawn. */
    roadPose(t, d, ahead) {
        const g = this.r.town.graph;
        const nodes = [];
        const push = (p) => {
            const last = nodes[nodes.length - 1];
            if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-6)
                nodes.push(p);
        };
        for (const p of d.trail)
            push(p);
        // Where the node it's at falls in the list (the trail may already end there).
        let here = nodes.length - 1;
        this.route(t).forEach((n, i) => {
            push(g.nodes[n]);
            if (i === 0)
                here = nodes.length - 1;
        });
        if (!nodes.length)
            return null;
        let before = 0;
        for (let i = 1; i <= here; i++)
            before += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].y - nodes[i - 1].y);
        // On a building's zero-length driveway the game has it at the building: that's the kerb.
        const along = g.terminal[t.node] ? 0 : this.distAlong(t, ahead);
        return poseAlong(nodes, Math.max(0, before + along - d.lag), this.r.laneOffset);
    }
}
/** Where a truck is `dist` along a line of road points, in the right-hand lane, rounding the corners. */
export function poseAlong(nodes, dist, lane) {
    if (nodes.length === 1)
        return { x: nodes[0].x, y: nodes[0].y, dx: 1, dy: 0 };
    const segs = [];
    let at = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i];
        const b = nodes[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1e-9)
            continue;
        segs.push({ a, b, u: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, len, at });
        at += len;
    }
    if (!segs.length)
        return { x: nodes[0].x, y: nodes[0].y, dx: 1, dy: 0 };
    dist = Math.min(dist, at);
    const right = (u) => ({ x: -u.y, y: u.x });
    // A corner: how far either side of each junction the turn takes.
    const R = (i) => Math.min(0.2, segs[i].len / 2, segs[i + 1].len / 2);
    for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        const n = segs[i + 1];
        const dot = s.u.x * n.u.x + s.u.y * n.u.y;
        if (dot > 0.999)
            continue; // straight on
        const rc = R(i);
        const j = s.at + s.len;
        if (dist < j - rc || dist > j + rc)
            continue;
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
/** Move a truck in a waiting line towards `goal` (same lane: along the street; the other lane: along, then a U-turn). */
export function stepAlongLine(q, goal, budget, lane) {
    const out = { ...q };
    const ds = goal.s - out.s;
    // The near lane runs towards the building (s going down), the far lane away from it (s going up).
    // Changing lanes the way it faces: drive there, then U-turn; the other way: U-turn first, then drive.
    const turnFirst = out.side !== goal.side && (out.side === 'near' ? ds > 1e-6 : ds < -1e-6);
    if (turnFirst || out.turn) {
        out.turn = Math.min(1, (out.turn ?? 0) + budget / (Math.PI * lane));
        if (out.turn < 1)
            return out;
        return stepAlongLine({ node: out.node, kerb: out.kerb, s: out.s, side: out.side === 'near' ? 'far' : 'near' }, goal, 0, lane);
    }
    const mv = Math.sign(ds) * Math.min(Math.abs(ds), budget);
    out.s += mv;
    budget -= Math.abs(mv);
    if (out.side !== goal.side && Math.abs(goal.s - out.s) < 1e-6 && budget > 0)
        return stepAlongLine({ ...out, turn: 1e-6 }, goal, budget, lane);
    return out;
}
/** Where a truck in a waiting line is drawn: in its lane, or partway through a U-turn to the other one. */
export function linePoint(r, q) {
    if (!q.turn)
        return r.queuePoint(q.node, q.s, q.side, q.kerb);
    const from = r.queuePoint(q.node, q.s, q.side, q.kerb);
    const to = r.queuePoint(q.node, q.s, q.side === 'near' ? 'far' : 'near', q.kerb);
    if (!from || !to)
        return from;
    const lane = r.laneOffset;
    const th = q.turn * Math.PI;
    // Half a circle across the road, bulging the way it was going.
    const cx = (from.x + to.x) / 2;
    const cy = (from.y + to.y) / 2;
    const rx = (from.x - cx) / lane;
    const ry = (from.y - cy) / lane;
    return {
        x: cx + rx * lane * Math.cos(th) + from.dx * lane * Math.sin(th),
        y: cy + ry * lane * Math.cos(th) + from.dy * lane * Math.sin(th),
        dx: -rx * Math.sin(th) + from.dx * Math.cos(th),
        dy: -ry * Math.sin(th) + from.dy * Math.cos(th),
        parked: true,
        q,
    };
}
/** Shortest way along the streets from one road node to another (buildings aren't streets), nodes from a to b. */
function roadPath(g, a, b) {
    const prev = new Map([[a, -1]]);
    const todo = [a];
    while (todo.length) {
        const n = todo.shift();
        if (n === b)
            break;
        for (const e of g.adj[n]) {
            if (g.terminal[e.to] || prev.has(e.to))
                continue;
            prev.set(e.to, n);
            todo.push(e.to);
        }
    }
    if (!prev.has(b))
        return [a, b];
    const path = [b];
    while (path[0] !== a)
        path.unshift(prev.get(path[0]));
    return path;
}
