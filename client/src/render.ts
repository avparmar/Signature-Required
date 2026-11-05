/**
 * Drawing the town (#31) and trucks (#32) on a canvas, with pan and zoom.
 *
 * - Roads; producers (circles) and consumers (houses) coloured by good; depots in company colours
 *   (free sites dashed); empty lots faint; rivers and bridges.
 * - Level pips under each building (five small dots), collapsing to a ring tint when zoomed out;
 *   a flashing red outline while a location is closing.
 * - Routes as dashed company-coloured lines from producer to consumer, with a truck count.
 * - Trucks move smoothly between ticks, show the pallet they carry (empty = hollow), queue
 *   neatly beside a building, and show breakdowns and repairs.
 */
import type { Location, Observation, Route, Town } from '@sr/core';

export const COMPANY_COLORS = ['#c8553d', '#2a7ab0', '#d99a1e', '#3f8f5a', '#7b5ea7', '#c2477f'];
export const GOOD_COLORS = ['#f4f1ea', '#c98b4b', '#55607d', '#8fbf5a', '#b05bb0'];
const INK = '#23201b';
const ROAD = '#d9d2c3';
const WATER = '#9cc3e0';

export const companyColor = (c: number) => COMPANY_COLORS[c % COMPANY_COLORS.length];
export const goodColor = (g: number) => GOOD_COLORS[g % GOOD_COLORS.length];

export interface Highlights {
  /** Location being hovered. */
  hover: number | null;
  /** Locations picked so far for a new route. */
  picked: number[];
  /** Route being hovered (route key). */
  hoverRoute: string | null;
  /** Free depot sites to highlight with this company's prices (buy-depot mode). */
  buyFor: number | null;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** Pixels per block. */
  scale = 30;
  /** Screen position (CSS px) of town coordinate (0, 0). */
  ox = 20;
  oy = 20;
  private w = 0;
  private h = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private town: Town,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  setTown(town: Town) {
    this.town = town;
  }

  /** Match the canvas to its box and fit the whole town. */
  resize(fit = false) {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = box.width;
    this.h = box.height;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (fit) this.fit();
  }

  fit() {
    const { blocksX, blocksY } = this.town.cfg;
    const pad = 24;
    this.scale = Math.max(6, Math.min((this.w - 2 * pad) / blocksX, (this.h - 2 * pad) / blocksY));
    this.ox = (this.w - blocksX * this.scale) / 2;
    this.oy = (this.h - blocksY * this.scale) / 2;
  }

  X = (x: number) => this.ox + x * this.scale;
  Y = (y: number) => this.oy + y * this.scale;
  /** Screen (CSS px) to town coordinates. */
  toTown(sx: number, sy: number) {
    return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale };
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const before = this.toTown(sx, sy);
    this.scale = Math.max(8, Math.min(160, this.scale * factor));
    this.ox = sx - before.x * this.scale;
    this.oy = sy - before.y * this.scale;
  }

  pan(dx: number, dy: number) {
    this.ox += dx;
    this.oy += dy;
  }

  /** Building radius on screen. */
  get r() {
    return Math.max(4, Math.min(18, this.scale * 0.24));
  }

  /** The location under a screen point, if any. */
  locationAt(sx: number, sy: number, includeLots = false): Location | null {
    let best: Location | null = null;
    let bestD = this.r + 4;
    for (const l of this.town.locations) {
      if (l.kind === 'lot' && !includeLots) continue;
      const d = Math.hypot(this.X(l.x) - sx, this.Y(l.y) - sy);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  /** The route line under a screen point, if any (producer -> consumer segment). */
  routeAt(sx: number, sy: number, routes: Route[]): Route | null {
    let best: Route | null = null;
    let bestD = 7;
    for (const [i, r] of routes.entries()) {
      const [a, b] = this.routeEnds(r, i, routes);
      const d = distToSegment(sx, sy, a.x, a.y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  /** Screen endpoints of a route line, nudged sideways so parallel routes don't overlap. */
  private routeEnds(r: Route, _i: number, routes: Route[]) {
    const p = this.town.locations[r.producer];
    const q = this.town.locations[r.consumer];
    const same = routes.filter((x) => x.producer === r.producer && x.consumer === r.consumer);
    const k = same.indexOf(r) - (same.length - 1) / 2;
    const dx = this.X(q.x) - this.X(p.x);
    const dy = this.Y(q.y) - this.Y(p.y);
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 5 * k;
    const ny = (dx / len) * 5 * k;
    return [
      { x: this.X(p.x) + nx, y: this.Y(p.y) + ny },
      { x: this.X(q.x) + nx, y: this.Y(q.y) + ny },
    ];
  }

  draw(obs: Observation, trucks: { id: number; x: number; y: number; dx: number; dy: number }[], hl: Highlights, now: number) {
    const { ctx } = this;
    const town = this.town;
    ctx.clearRect(0, 0, this.w, this.h);
    const { blocksX, blocksY } = town.cfg;
    // Ground.
    ctx.fillStyle = '#fbf9f4';
    ctx.fillRect(this.X(-0.3), this.Y(-0.3), (blocksX + 0.6) * this.scale, (blocksY + 0.6) * this.scale);
    // Water.
    ctx.fillStyle = WATER;
    for (const { i, j } of town.river) ctx.fillRect(this.X(i) - 1, this.Y(j) - 1, this.scale + 2, this.scale + 2);

    // Roads.
    const roadW = Math.max(2, Math.min(9, this.scale * 0.13));
    const bridges = new Set(town.bridges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
    ctx.lineCap = 'round';
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = roadW;
    ctx.beginPath();
    for (const e of town.graph.edges) {
      const a = town.graph.nodes[e.a];
      const b = town.graph.nodes[e.b];
      ctx.moveTo(this.X(a.x), this.Y(a.y));
      ctx.lineTo(this.X(b.x), this.Y(b.y));
    }
    ctx.stroke();
    if (bridges.size) {
      ctx.strokeStyle = '#a07c55';
      ctx.lineWidth = roadW * 1.3;
      ctx.beginPath();
      for (const e of town.graph.edges) {
        if (!bridges.has(e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`)) continue;
        const a = town.graph.nodes[e.a];
        const b = town.graph.nodes[e.b];
        ctx.moveTo(this.X(a.x), this.Y(a.y));
        ctx.lineTo(this.X(b.x), this.Y(b.y));
      }
      ctx.stroke();
    }

    // Routes.
    const routes = obs.routes;
    for (const [i, r] of routes.entries()) {
      const [a, b] = this.routeEnds(r, i, routes);
      const hot = hl.hoverRoute === r.key;
      ctx.strokeStyle = companyColor(r.company);
      ctx.globalAlpha = hot ? 0.95 : 0.55;
      ctx.lineWidth = hot ? 3.5 : 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Buildings.
    const byId = new Map(obs.locations.map((s) => [s.id, s]));
    const r = this.r;
    const detail = this.scale >= 22;
    for (const l of town.locations) {
      const x = this.X(l.x);
      const y = this.Y(l.y);
      const picked = hl.picked.includes(l.id);
      const hovered = hl.hover === l.id;
      if (l.kind === 'lot') {
        ctx.fillStyle = '#d8d1c2';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.5, r * 0.22), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      if (l.kind === 'depot') {
        const owner = obs.depots[l.id];
        const s = r * 1.05;
        ctx.lineWidth = 1.5;
        if (owner === undefined) {
          const price = hl.buyFor !== null ? obs.depotPrices[l.id]?.[hl.buyFor] : undefined;
          ctx.fillStyle = price !== undefined ? '#fff6d6' : '#ffffff';
          ctx.strokeStyle = price !== undefined ? '#b08a1e' : '#9a9283';
          ctx.setLineDash([3, 3]);
          roundRect(ctx, x - s, y - s, 2 * s, 2 * s, 3);
          ctx.fill();
          ctx.stroke();
          ctx.setLineDash([]);
          if (price !== undefined) label(ctx, `$${price}`, x, y - s - 7, '#7a5d10');
        } else {
          ctx.fillStyle = companyColor(owner);
          ctx.strokeStyle = INK;
          roundRect(ctx, x - s, y - s, 2 * s, 2 * s, 3);
          ctx.fill();
          ctx.stroke();
          // Garage door.
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(x - s * 0.55, y - s * 0.1, s * 1.1, s * 0.85);
          ctx.strokeStyle = 'rgba(0,0,0,0.25)';
          ctx.lineWidth = 1;
          for (let k = 1; k < 3; k++) {
            ctx.beginPath();
            ctx.moveTo(x - s * 0.55, y - s * 0.1 + (k * s * 0.85) / 3);
            ctx.lineTo(x + s * 0.55, y - s * 0.1 + (k * s * 0.85) / 3);
            ctx.stroke();
          }
        }
        if (picked || hovered) ring(ctx, x, y, s * 1.5, picked ? INK : '#8a8273');
        continue;
      }
      const st = byId.get(l.id);
      const closing = st?.closingIn !== null && st?.closingIn !== undefined;
      ctx.fillStyle = goodColor(l.good!);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.6;
      if (l.kind === 'producer') {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Chimney-ish notch so producers read as factories.
        ctx.fillStyle = INK;
        ctx.fillRect(x + r * 0.25, y - r * 1.25, r * 0.28, r * 0.5);
      } else {
        // A house: square body with a roof.
        ctx.beginPath();
        ctx.moveTo(x - r * 0.85, y - r * 0.15);
        ctx.lineTo(x, y - r * 1.0);
        ctx.lineTo(x + r * 0.85, y - r * 0.15);
        ctx.lineTo(x + r * 0.85, y + r * 0.8);
        ctx.lineTo(x - r * 0.85, y + r * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      if (detail) {
        ctx.fillStyle = l.good === 0 ? INK : '#ffffff';
        ctx.font = `700 ${Math.round(r * 0.8)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const letter = town.cfg.goods[l.good!][0];
        ctx.fillText(l.kind === 'producer' ? letter.toUpperCase() : letter, x, y + (l.kind === 'consumer' ? r * 0.25 : 0));
      }
      // Level: pips when zoomed in, a ring tint when zoomed out.
      if (st) {
        if (detail) {
          const n = 5;
          const gap = Math.max(4, r * 0.42);
          for (let k = 0; k < n; k++) {
            ctx.beginPath();
            ctx.arc(x + (k - (n - 1) / 2) * gap, y + r * 1.45, Math.max(1.3, r * 0.14), 0, Math.PI * 2);
            ctx.fillStyle = k < st.level ? INK : 'rgba(0,0,0,0.13)';
            ctx.fill();
          }
        } else {
          ctx.strokeStyle = `rgba(35,32,27,${0.15 + 0.17 * st.level})`;
          ctx.lineWidth = 1 + st.level * 0.5;
          ctx.beginPath();
          ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (closing && Math.floor(now * 2.5) % 2 === 0) ring(ctx, x, y, r * 1.6, '#d1342f', 2.5);
      if (picked || hovered) ring(ctx, x, y, r * 1.6, picked ? INK : '#8a8273');
    }

    // Route truck counts (on top of buildings).
    for (const [i, rt] of routes.entries()) {
      const [a, b] = this.routeEnds(rt, i, routes);
      badge(ctx, `${rt.trucks}`, (a.x + b.x) / 2, (a.y + b.y) / 2, companyColor(rt.company));
    }

    // Trucks.
    const tw = Math.max(5, Math.min(14, this.scale * 0.3));
    const th = tw * 0.62;
    const tById = new Map(obs.trucks.map((t) => [t.id, t]));
    for (const p of trucks) {
      const t = tById.get(p.id)!;
      const x = this.X(p.x);
      const y = this.Y(p.y);
      const ang = Math.atan2(p.dy, p.dx);
      ctx.save();
      ctx.translate(x, y);
      if (t.state === 'driving' || t.state === 'broken') ctx.rotate(Math.abs(p.dx) + Math.abs(p.dy) > 1e-6 ? ang : 0);
      // Body.
      ctx.fillStyle = companyColor(t.company);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      roundRect(ctx, -tw / 2, -th / 2, tw, th, 2);
      ctx.fill();
      ctx.stroke();
      // Cab.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(tw / 2 - tw * 0.28, -th / 2, tw * 0.28, th);
      // Open-top payload: a pallet in the good's colour, or an empty bed.
      const bx = -tw / 2 + 1.5;
      const bw = tw * 0.58;
      if (t.cargo) {
        ctx.fillStyle = goodColor(t.cargo.good);
        ctx.fillRect(bx, -th / 2 + 1.5, bw, th - 3);
        ctx.strokeStyle = INK;
        ctx.strokeRect(bx, -th / 2 + 1.5, bw, th - 3);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillRect(bx, -th / 2 + 1.5, bw, th - 3);
      }
      ctx.restore();
      // Breakdowns and repairs.
      if (t.state === 'broken' || t.limping) {
        const blink = t.state === 'broken' ? Math.floor(now * 4) % 2 === 0 : true;
        if (blink) {
          ctx.fillStyle = '#d1342f';
          ctx.beginPath();
          ctx.arc(x + tw * 0.55, y - th * 0.9, Math.max(3, tw * 0.28), 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = `800 ${Math.max(6, tw * 0.4)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', x + tw * 0.55, y - th * 0.9 + 0.5);
        }
      } else if (t.state === 'repairing') {
        ctx.fillStyle = '#5b6b7a';
        ctx.beginPath();
        ctx.arc(x + tw * 0.55, y - th * 0.9, Math.max(3, tw * 0.28), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `800 ${Math.max(6, tw * 0.36)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚙', x + tw * 0.55, y - th * 0.9 + 0.5);
      }
    }
  }

  /**
   * Where each truck should be drawn: its road position, or, when queued or loading at a
   * building, a slot in a neat row beside it (and likewise when parked at a depot). The facing is
   * the direction to the next road node.
   */
  truckTargets(obs: Observation): Map<number, { x: number; y: number; dx: number; dy: number }> {
    const out = new Map<number, { x: number; y: number; dx: number; dy: number }>();
    const step = Math.max(0.22, 9 / this.scale);
    const rr = this.r / this.scale;
    for (const [loc, ids] of Object.entries(obs.queues)) {
      const l = this.town.locations[Number(loc)];
      ids.forEach((id, k) => {
        const col = k % 4;
        const row = Math.floor(k / 4);
        out.set(id, { x: l.x + (col - 1.5) * step, y: l.y + rr + step * (1.7 + row), dx: 1, dy: 0 });
      });
    }
    const atDepot = new Map<number, number>();
    for (const t of obs.trucks) {
      if (out.has(t.id)) continue;
      if (t.state === 'idle' || t.state === 'repairing') {
        const k = atDepot.get(t.node) ?? 0;
        atDepot.set(t.node, k + 1);
        const n = this.town.graph.nodes[t.node];
        out.set(t.id, { x: n.x + rr + step * (1 + (k % 4)), y: n.y + step * Math.floor(k / 4), dx: 1, dy: 0 });
        continue;
      }
      const next = t.path.length ? this.town.graph.nodes[t.path[0]] : null;
      out.set(t.id, { x: t.x, y: t.y, dx: next ? next.x - t.x : 0, dy: next ? next.y - t.y : 0 });
    }
    return out;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function badge(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.font = '700 11px system-ui, sans-serif';
  const w = Math.max(16, ctx.measureText(text).width + 8);
  ctx.fillStyle = color;
  roundRect(ctx, x - w / 2, y - 8, w, 16, 8);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.font = '700 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRect(ctx, x - w / 2, y - 8, w, 15, 4);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
