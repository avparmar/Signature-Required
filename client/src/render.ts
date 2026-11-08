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
import { distancesFrom, routeVia, type Location, type Observation, type Route, type Town } from '@sr/core';

// Company colours stay clear of the goods' colours (wood brown, wheat gold, oil slate). Each game
// uses a few of these (see pickCompanySlots), never two that are easy to mix up.
export const COMPANY_COLORS = ['#e8432f', '#2a86e0', '#25a84a', '#9152e0', '#f5891a', '#66717e', '#d93a8c', '#7cbf2e', '#38b6e8'];
/** Colours too alike to share a game: red/magenta, green/lime, blue/sky. */
const CLASHES: [number, number][] = [[0, 6], [2, 7], [1, 8]];

/** This game's palette slot for each company (company index -> COMPANY_COLORS index). */
let companySlots: number[] = COMPANY_COLORS.map((_, i) => i);
export const companySlot = (c: number) => companySlots[c % companySlots.length];

/** Choose `n` colours for a game from its seed: shuffled, skipping any that clash with one already picked. */
export function pickCompanySlots(n: number, seed: number) {
  let x = (seed >>> 0) || 1;
  const rand = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const order = COMPANY_COLORS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const picked: number[] = [];
  for (const i of order) if (picked.length < n && !picked.some((j) => CLASHES.some(([a, b]) => (a === i && b === j) || (a === j && b === i)))) picked.push(i);
  for (const i of order) if (picked.length < n && !picked.includes(i)) picked.push(i); // more companies than clash-free colours
  companySlots = picked; // in shuffled order, so red isn't always the first company
}
export const GOOD_COLORS = ['#b07a4a', '#f0cf6a', '#4a5470', '#8fbf5a', '#b05bb0'];
/** Producer icons (raw material) and shop icons (product), by good. */
export const RAW_ICONS = ['🪵', '🌾', '🛢️'];
export const PRODUCT_ICONS = ['🪑', '🍞', '⛽'];

/** Chess-style name for a block: column letter (A at the left) and row number (1 at the top). */
export function coordOf(x: number, y: number): string {
  return `${String.fromCharCode(65 + Math.floor(x))}${Math.floor(y) + 1}`;
}
const INK = '#23201b';
const ROAD = '#d9d2c3';
const WATER = '#9cc3e0';

export const companyColor = (c: number) => COMPANY_COLORS[companySlot(c)];
export const goodColor = (g: number) => GOOD_COLORS[g % GOOD_COLORS.length];

export interface Highlights {
  /** Location being hovered. */
  hover: number | null;
  /** Locations picked so far for a new route. */
  picked: number[];
  /** Route being hovered (route key). */
  hoverRoute: string | null;
  /** The route whose row in the routes list the pointer is over. */
  listRoute: string | null;
  /** Routes of your companies with more trucks than they can use (their trucks keep waiting). */
  saturated: Set<string>;
  /** Free depot sites to highlight with this company's prices (buy-depot mode). */
  buyFor: number | null;
  /** Companies holding a sale right now: their factories pulse. */
  spotlight: Set<number>;
  /** A free factory site's subsidy district (drive distance, blocks), shaded when it's hovered. */
  district: number;
  /** Companies whose subsidy meters show on free factory sites (the ones you run). */
  meterFor: number[];
  /** The company whose card the pointer is over (shows the subsidy meters on every free site). */
  cardCompany: number | null;
  /** Full price of a factory site and the biggest discount, for the meters. */
  siteBase: number;
  maxSubsidy: number;
  /** Free sites to flash: site id -> company -> game-clock time of its last pickup or delivery there. */
  flash: Map<number, Map<number, number>>;
  /** Editing a company's delivery area: the company, and its blocks as they're being painted. */
  areaEdit: { company: number; blocks: Set<number> } | null;
  /** The block under the pointer while editing an area. */
  hoverBlock: number | null;
  /** Outside area editing: a block in one of your companies' areas under the pointer (for its arrows). */
  areaHover: { company: number; block: number } | null;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** Pixels per block. */
  scale = 30;
  /** Screen position (CSS px) of town coordinate (0, 0). */
  ox = 20;
  oy = 20;
  w = 0;
  h = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    public town: Town,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  private districts = new Map<number, Float64Array>();
  /**
   * The blocks in a free site's subsidy zone (x + y * blocksX): a building counts when the street
   * it's on is in the zone; blocks with no building go by the nearest street round them.
   */
  zoneBlocks(site: number, district: number): Set<number> {
    const hit = this.zoneCache.get(site);
    if (hit) return hit;
    const town = this.town;
    const d = this.districtOf(town.locations[site].node);
    const built = new Map<string, number>();
    for (const l of town.locations) built.set(`${Math.floor(l.x)},${Math.floor(l.y)}`, l.node);
    const near = this.nodeAt();
    const water = new Set(town.river.map(({ i, j }) => `${i},${j}`));
    const out = new Set<number>();
    for (let j = 0; j < town.cfg.blocksY; j++)
      for (let i = 0; i < town.cfg.blocksX; i++) {
        if (water.has(`${i},${j}`)) continue;
        const own = built.get(`${i},${j}`);
        const sides = [`${i + 0.5},${j}`, `${i + 1},${j + 0.5}`, `${i + 0.5},${j + 1}`, `${i},${j + 0.5}`].map((k) => near.get(k)).filter((n) => n !== undefined) as number[];
        const dist = own !== undefined ? d[own] : Math.min(Infinity, ...sides.map((n) => d[n]));
        if (dist <= district) out.add(i + j * town.cfg.blocksX);
      }
    this.zoneCache.set(site, out);
    return out;
  }
  private zoneCache = new Map<number, Set<number>>();

  private districtOf(node: number): Float64Array {
    const d = this.districts.get(node) ?? distancesFrom(this.town.graph, node);
    this.districts.set(node, d);
    return d;
  }

  setTown(town: Town) {
    this.town = town;
    this.districts.clear();
    this.paths.clear();
    this.edgeDir = undefined;
  }

  /** Lane offset from the middle of the road (world units). */
  get laneOffset() {
    return this.roadWidth / this.scale / 4;
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

  /** Road width on screen: most of the gap between blocks, room for two lanes. */
  /** Truck size on screen (pixels): long enough that the company colour shows around the load. */
  get truckSize() {
    const w = Math.max(11, this.scale * 0.5); // grows with the zoom
    return { w, h: w * 0.5 };
  }

  get roadWidth() {
    return Math.max(3, this.scale * 0.31);
  }

  /** Building radius on screen. */
  get r() {
    // Small enough to leave room in the block, now that roads take most of the gap.
    return Math.max(5, this.scale * 0.27);
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

  /** The route line under a screen point, if any. */
  routeAt(sx: number, sy: number, routes: Route[]): Route | null {
    let best: Route | null = null;
    let bestD = 6;
    for (const r of routes)
      for (const pts of [this.routeLine(r, routes, 0), this.routeLine(r, routes, 1)])
      for (let i = 1; i < pts.length; i++) {
        const d = distToSegment(sx, sy, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
    return best;
  }

  /** Whether routes run through their depot (TruckConfig.viaDepot); set by the client. */
  via: 'none' | 'loaded' | 'hub' = 'none';
  private paths = new Map<string, number[]>();
  /**
   * Road nodes a truck on a route drives (cached; the roads never change). Leg 0, loaded: producer
   * to consumer, through the depot when routes run through it. Leg 1, empty: back from the
   * consumer to the producer (through the depot too, for 'hub' routes).
   */
  private routePath(r: Route, leg: 0 | 1): number[] {
    const key = `${this.via === 'none' ? `${r.producer}>${r.consumer}` : r.key}#${leg}`;
    let path = this.paths.get(key);
    if (!path) {
      const a = this.town.locations[r.producer].node;
      const b = this.town.locations[r.consumer].node;
      const d = this.town.locations[r.depot].node;
      const stops = leg === 0 ? (this.via === 'none' ? [a, b] : [a, d, b]) : this.via === 'hub' ? [b, d, a] : [b, a];
      path = routeVia(this.town.graph, stops) ?? stops;
      this.paths.set(key, path);
    }
    return path;
  }

  /** Kerb-to-kerb road nodes of a route's leg (leaving off the zero-length driveways into the buildings). */
  private routeNodes(r: Route, leg: 0 | 1 = 0): number[] {
    const path = this.routePath(r, leg);
    const term = this.town.graph.terminal;
    return path.filter((n, i) => !(term[n] && (i === 0 || i === path.length - 1)) || path.length <= 2);
  }

  private tracksFor = '';
  private tracks = new Map<string, number[]>();
  /** For each street (a<b), the companies with a route along it, in order: each gets its own track. */
  private streetTracks(routes: Route[]): Map<string, number[]> {
    const sig = routes.map((r) => `${r.key}@${r.company}`).join('|');
    if (sig === this.tracksFor) return this.tracks;
    const m = new Map<string, Set<number>>();
    for (const r of routes)
      for (const ns of [this.routeNodes(r, 0), this.routeNodes(r, 1)]) {
      for (let i = 1; i < ns.length; i++) {
        const k = ns[i - 1] < ns[i] ? `${ns[i - 1]}-${ns[i]}` : `${ns[i]}-${ns[i - 1]}`;
        (m.get(k) ?? m.set(k, new Set()).get(k)!).add(r.company);
      }
    }
    this.tracks = new Map([...m].map(([k, v]) => [k, [...v].sort((x, y) => x - y)]));
    this.tracksFor = sig;
    return this.tracks;
  }

  /** The town block under a screen point (x + y * blocksX), or null outside the town. */
  blockAt(sx: number, sy: number): number | null {
    const x = Math.floor((sx - this.ox) / this.scale);
    const y = Math.floor((sy - this.oy) / this.scale);
    const { blocksX, blocksY } = this.town.cfg;
    return x >= 0 && y >= 0 && x < blocksX && y < blocksY ? x + y * blocksX : null;
  }

  /**
   * Delivery areas: a faint tint over each company's blocks, and a thin border in its colour along
   * the streets round them (just inside, so two companies' borders on one street sit side by side).
   * Focused places get a ring in the company's colour. While editing, that company's area is
   * stronger, and the block under the pointer is outlined.
   */
  private drawAreas(obs: Observation, hl: Highlights) {
    const ctx = this.ctx;
    const W = this.town.cfg.blocksX;
    const s = this.scale;
    for (const c of obs.companies) {
      const editing = hl.areaEdit?.company === c.id;
      const blocks = editing ? hl.areaEdit!.blocks : new Set(c.area);
      if (!blocks.size) continue;
      const color = companyColor(c.id);
      ctx.fillStyle = color;
      ctx.globalAlpha = editing ? 0.18 : 0.1;
      for (const b of blocks) ctx.fillRect(this.X(b % W), this.Y(Math.floor(b / W)), s, s);
      const inset = this.roadWidth * 0.22;
      ctx.globalAlpha = editing ? 1 : 0.8;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, s * (editing ? 0.06 : 0.04));
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const b of blocks) {
        const i = b % W;
        const j = Math.floor(b / W);
        const x0 = this.X(i);
        const y0 = this.Y(j);
        if (j === 0 || !blocks.has(b - W)) (ctx.moveTo(x0, y0 + inset), ctx.lineTo(x0 + s, y0 + inset));
        if (!blocks.has(b + W)) (ctx.moveTo(x0, y0 + s - inset), ctx.lineTo(x0 + s, y0 + s - inset));
        if (i === 0 || !blocks.has(b - 1)) (ctx.moveTo(x0 + inset, y0), ctx.lineTo(x0 + inset, y0 + s));
        if (i === W - 1 || !blocks.has(b + 1)) (ctx.moveTo(x0 + s - inset, y0), ctx.lineTo(x0 + s - inset, y0 + s));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Focused places: a ring in the company's colour (one ring per company focusing it).
    for (const c of obs.companies) {
      c.focus.forEach((id) => {
        const l = this.town.locations[id];
        if (!l) return;
        const k = obs.companies.filter((o) => o.id < c.id && o.focus.includes(id)).length;
        ctx.strokeStyle = companyColor(c.id);
        ctx.lineWidth = Math.max(2, s * 0.06);
        ctx.setLineDash([s * 0.12, s * 0.07]);
        ctx.beginPath();
        ctx.arc(this.X(l.x), this.Y(l.y), s * (0.5 + 0.08 * k), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }
    // While editing (or over a block in one of your areas): arrows from the block under the pointer to each free factory site whose subsidy
    // zone it's in, each site ringed with what it would cost this company now. (Not while hovering
    // a free site: then its whole zone is shaded instead.)
    const hovered = hl.hover !== null ? this.town.locations[hl.hover] : null;
    const onSite = hovered?.kind === 'depot' && obs.depots[hovered.id] === undefined;
    const arrows = hl.areaEdit ? (hl.hoverBlock !== null ? { company: hl.areaEdit.company, block: hl.hoverBlock } : null) : hl.areaHover;
    if (arrows && !onSite) {
      const b = arrows.block;
      const gold = '#b08a1e';
      const cx = this.X((b % W) + 0.5);
      const cy = this.Y(Math.floor(b / W) + 0.5);
      const ring = this.r * 1.5;
      for (const site of this.town.locations) {
        if (site.kind !== 'depot' || obs.depots[site.id] !== undefined) continue;
        if (!this.zoneBlocks(site.id, hl.district).has(b)) continue;
        const tx = this.X(site.x);
        const ty = this.Y(site.y);
        const len = Math.hypot(tx - cx, ty - cy);
        ctx.strokeStyle = gold;
        ctx.fillStyle = gold;
        ctx.lineWidth = Math.max(2, s * 0.05);
        if (len > ring + 4) {
          const ux = (tx - cx) / len;
          const uy = (ty - cy) / len;
          const ex = tx - ux * ring;
          const ey = ty - uy * ring;
          ctx.setLineDash([s * 0.12, s * 0.08]);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.setLineDash([]);
          const h = Math.max(7, s * 0.2);
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ux * h - uy * h * 0.6, ey - uy * h + ux * h * 0.6);
          ctx.lineTo(ex - ux * h + uy * h * 0.6, ey - uy * h - ux * h * 0.6);
          ctx.closePath();
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(tx, ty, ring, 0, Math.PI * 2);
        ctx.stroke();
        const price = obs.depotPrices[site.id]?.[arrows.company];
        if (price !== undefined) label(ctx, `$${price}`, tx, ty - ring - 8, '#7a5d10');
      }
    }
    if (hl.areaEdit && hl.hoverBlock !== null) {
      const b = hl.hoverBlock;
      ctx.strokeStyle = companyColor(hl.areaEdit.company);
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(this.X(b % W) + 2, this.Y(Math.floor(b / W)) + 2, s - 4, s - 4);
      ctx.setLineDash([]);
    }
  }

  /** The road's centre-line dashes (the route lines use the same, so they line up). */
  private centreDash(): number[] {
    return [this.scale * 0.11, this.scale * 0.14];
  }

  /**
   * A route's streets on screen, each drawn the way the road draws its centre line (same end
   * first), shifted onto the company's track where several share it.
   */
  private routeStreets(r: Route, routes: Route[]): [{ x: number; y: number }, { x: number; y: number }][] {
    const g = this.town.graph;
    const tracks = this.streetTracks(routes);
    if (!this.edgeDir) {
      this.edgeDir = new Map();
      for (const e of g.edges) this.edgeDir.set(e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`, [e.a, e.b]);
    }
    const out: [{ x: number; y: number }, { x: number; y: number }][] = [];
    // Both ways (loaded and back empty), each street once.
    const done = new Set<string>();
    for (const ns of [this.routeNodes(r, 0), this.routeNodes(r, 1)])
    for (let i = 1; i < ns.length; i++) {
      const lo = Math.min(ns[i - 1], ns[i]);
      const hi = Math.max(ns[i - 1], ns[i]);
      if (done.has(`${lo}-${hi}`)) continue;
      done.add(`${lo}-${hi}`);
      if (g.terminal[lo] || g.terminal[hi]) continue;
      const [ea, eb] = this.edgeDir.get(`${lo}-${hi}`) ?? [lo, hi];
      const list = tracks.get(`${lo}-${hi}`) ?? [r.company];
      const gap = this.trackGap(list.length);
      // The same sideways shift as routeLine (measured along the street from its first end).
      const k = (list.indexOf(r.company) - (list.length - 1) / 2) * gap;
      const f = this.firstEnd(lo, hi);
      const A = g.nodes[f];
      const B = g.nodes[f === lo ? hi : lo];
      const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      const ox = (-(B.y - A.y) / len) * k;
      const oy = ((B.x - A.x) / len) * k;
      const P = g.nodes[ea];
      const Q = g.nodes[eb];
      out.push([
        { x: this.X(P.x) + ox, y: this.Y(P.y) + oy },
        { x: this.X(Q.x) + ox, y: this.Y(Q.y) + oy },
      ]);
    }
    return out;
  }
  private edgeDir?: Map<string, [number, number]>;

  /**
   * Of a street's two ends, the one sideways shifts are measured from: the left one (or the top
   * one, on a street running up and down), so each company keeps to the same side all along a
   * street, whichever way the road's own nodes run.
   */
  private firstEnd(a: number, b: number): number {
    const A = this.town.graph.nodes[a];
    const B = this.town.graph.nodes[b];
    return A.x < B.x - 1e-9 || (Math.abs(A.x - B.x) <= 1e-9 && A.y < B.y) ? a : b;
  }

  /** How far apart companies' tracks are on a street several of them share. */
  private trackGap(n: number): number {
    return Math.min(this.roadWidth * 0.5, (this.roadWidth * 0.75) / Math.max(1, n - 1));
  }

  /**
   * A route's line on screen, along the streets from producer to consumer. Where several
   * companies' routes share a street, each company has its own track across it, side by side.
   */
  private routeLine(r: Route, routes: Route[], leg: 0 | 1 = 0): { x: number; y: number }[] {
    const ns = this.routeNodes(r, leg);
    const g = this.town.graph;
    const tracks = this.streetTracks(routes);
    const P = ns.map((n) => ({ x: this.X(g.nodes[n].x), y: this.Y(g.nodes[n].y) }));
    if (P.length < 2) return P;
    // Each stretch, shifted sideways onto its track (measured the same way whichever way it's driven).
    const segs: { a: { x: number; y: number }; b: { x: number; y: number }; u: { x: number; y: number } }[] = [];
    for (let i = 1; i < ns.length; i++) {
      const lo = Math.min(ns[i - 1], ns[i]);
      const hi = Math.max(ns[i - 1], ns[i]);
      const list = tracks.get(`${lo}-${hi}`) ?? [r.company];
      // Spread across the road, two companies a lane each: the more there are, the closer together.
      const gap = this.trackGap(list.length);
      const k = (list.indexOf(r.company) - (list.length - 1) / 2) * gap * (ns[i - 1] === this.firstEnd(lo, hi) ? 1 : -1);
      const dx = P[i].x - P[i - 1].x;
      const dy = P[i].y - P[i - 1].y;
      const len = Math.hypot(dx, dy) || 1;
      const u = { x: dx / len, y: dy / len };
      const o = { x: -u.y * k, y: u.x * k };
      segs.push({ a: { x: P[i - 1].x + o.x, y: P[i - 1].y + o.y }, b: { x: P[i].x + o.x, y: P[i].y + o.y }, u });
    }
    // Joined at each corner where the shifted stretches meet (or stepped across, if they run straight on).
    const out = [segs[0].a];
    for (let i = 0; i < segs.length - 1; i++) {
      const s1 = segs[i];
      const s2 = segs[i + 1];
      const cr = s1.u.x * s2.u.y - s1.u.y * s2.u.x;
      if (Math.abs(cr) > 0.2) {
        const t = ((s2.a.x - s1.a.x) * s2.u.y - (s2.a.y - s1.a.y) * s2.u.x) / cr;
        out.push({ x: s1.a.x + s1.u.x * t, y: s1.a.y + s1.u.y * t });
      } else {
        out.push(s1.b);
        if (Math.hypot(s1.b.x - s2.a.x, s1.b.y - s2.a.y) > 0.5) out.push(s2.a);
      }
    }
    out.push(segs[segs.length - 1].b);
    return out;
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
    // Two-lane roads: wide enough for trucks to pass on either side of a centre line.
    const roadW = this.roadWidth;
    // Water. The banks sit half a road in from the block edge, so the land on the bank lines up with
    // the outer edge of the roads there and roads don't jut into the water.
    ctx.fillStyle = WATER;
    const riverSet = new Set(town.river.map(({ i, j }) => `${i},${j}`));
    const wet = { has: (k: string) => { const [i, j] = k.split(',').map(Number); return i < 0 || j < 0 || i >= blocksX || j >= blocksY || riverSet.has(k); } };
    const bank = roadW / 2;
    for (const { i, j } of town.river) {
      const l = wet.has(`${i - 1},${j}`) ? -1 : bank;
      const r = wet.has(`${i + 1},${j}`) ? -1 : bank;
      const t = wet.has(`${i},${j - 1}`) ? -1 : bank;
      const btm = wet.has(`${i},${j + 1}`) ? -1 : bank;
      ctx.fillRect(this.X(i) + l, this.Y(j) + t, this.scale - l - r, this.scale - t - btm);
    }

    // Roads.
    const bridges = new Set(town.bridges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
    ctx.lineCap = 'round';
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = roadW;
    const term = town.graph.terminal;
    // Square ends (so a road stopping at the river stops square), with round joins drawn at every
    // intersection and bend, so corners stay rounded.
    ctx.lineCap = 'butt';
    const degree = new Array(town.graph.nodes.length).fill(0);
    ctx.beginPath();
    for (const e of town.graph.edges) {
      if (term[e.a] || term[e.b]) continue;
      degree[e.a]++;
      degree[e.b]++;
      const a = town.graph.nodes[e.a];
      const b = town.graph.nodes[e.b];
      ctx.moveTo(this.X(a.x), this.Y(a.y));
      ctx.lineTo(this.X(b.x), this.Y(b.y));
    }
    ctx.stroke();
    ctx.fillStyle = ROAD;
    ctx.beginPath();
    for (const n of town.graph.nodes) {
      if (degree[n.id] < 2) continue;
      ctx.moveTo(this.X(n.x) + roadW / 2, this.Y(n.y));
      ctx.arc(this.X(n.x), this.Y(n.y), roadW / 2, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.lineCap = 'round';
    // Centre lines, when zoomed in enough to see the lanes.
    if (this.scale >= 30) {
      // Sized to the town, not the screen: they grow and shrink with the zoom like the roads.
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(1, this.scale * 0.025);
      ctx.setLineDash(this.centreDash());
      ctx.beginPath();
      // Not under a route: its line takes the middle of the street there.
      const routed = this.streetTracks(obs.routes);
      for (const e of town.graph.edges) {
        if (term[e.a] || term[e.b]) continue;
        if (routed.has(e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`)) continue;
        const a = town.graph.nodes[e.a];
        const b = town.graph.nodes[e.b];
        ctx.moveTo(this.X(a.x), this.Y(a.y));
        ctx.lineTo(this.X(b.x), this.Y(b.y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Bridges: a flat deck the width of the road, square-ended, with a railing along each side.
    if (bridges.size) {
      for (const e of town.graph.edges) {
        if (!bridges.has(e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`)) continue;
        const a = town.graph.nodes[e.a];
        const b = town.graph.nodes[e.b];
        const ax = this.X(a.x);
        const ay = this.Y(a.y);
        const bx = this.X(b.x);
        const by = this.Y(b.y);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = (-(by - ay) / len) * (roadW / 2);
        const ny = ((bx - ax) / len) * (roadW / 2);
        // Trim the ends a little so the deck meets the bank roads rather than covering them.
        const tx = ((bx - ax) / len) * (roadW / 2);
        const ty = ((by - ay) / len) * (roadW / 2);
        ctx.fillStyle = '#cdbfa8';
        ctx.beginPath();
        ctx.moveTo(ax + tx + nx, ay + ty + ny);
        ctx.lineTo(bx - tx + nx, by - ty + ny);
        ctx.lineTo(bx - tx - nx, by - ty - ny);
        ctx.lineTo(ax + tx - nx, ay + ty - ny);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#7a6550';
        ctx.lineWidth = Math.max(1, roadW * 0.12);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(ax + tx + nx, ay + ty + ny);
        ctx.lineTo(bx - tx + nx, by - ty + ny);
        ctx.moveTo(ax + tx - nx, ay + ty - ny);
        ctx.lineTo(bx - tx - nx, by - ty - ny);
        ctx.stroke();
        ctx.lineCap = 'round';
      }
    }

    // A hovered free factory site: shade its district, where a company's pickups and deliveries
    // earn it a subsidy on the site's price.
    const site = hl.hover !== null ? town.locations[hl.hover] : null;
    if (site && site.kind === 'depot' && obs.depots[site.id] === undefined) {
      const d = this.districtOf(site.node);
      // Its streets, kept to the road itself so nothing spills onto blocks outside the zone.
      ctx.strokeStyle = '#b08a1e';
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = roadW;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const e of town.graph.edges) {
        if (d[e.a] > hl.district || d[e.b] > hl.district || term[e.a] || term[e.b]) continue;
        const a = town.graph.nodes[e.a];
        const b = town.graph.nodes[e.b];
        ctx.moveTo(this.X(a.x), this.Y(a.y));
        ctx.lineTo(this.X(b.x), this.Y(b.y));
      }
      ctx.stroke();
      // The blocks it covers, filled edge to edge: a building counts when the street it's on is in
      // the zone. Blocks with a building go by its street; other blocks by the nearest street round them.
      ctx.lineCap = 'round';
      ctx.fillStyle = '#b08a1e';
      ctx.globalAlpha = 0.3;
      const inset = roadW / 2;
      const W = town.cfg.blocksX;
      for (const b of this.zoneBlocks(site.id, hl.district))
        ctx.fillRect(this.X(b % W) + inset, this.Y(Math.floor(b / W)) + inset, this.scale - 2 * inset, this.scale - 2 * inset);
      ctx.globalAlpha = 1;
      label(ctx, 'subsidy zone', this.X(site.x), this.Y(site.y) - this.r * 1.9, '#7a5d10');
    }

    this.drawAreas(obs, hl);

    // Routes, along the streets.
    const routes = obs.routes;
    const lines = routes.map((r) => this.routeLine(r, routes));
    const backs = routes.map((r) => this.routeLine(r, routes, 1));
    const trace = (pts: { x: number; y: number }[]) => pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    for (const [i, r] of routes.entries()) {
      const pts = lines[i];
      const back = backs[i];
      // Hovering a route, or the factory it runs through, highlights it.
      const hot = hl.hoverRoute === r.key || hl.listRoute === r.key || hl.hover === r.depot;
      ctx.lineJoin = 'round';
      if (hl.saturated.has(r.key)) {
        // More trucks than the route can use: an amber band that slowly pulses under it.
        const pulse = 0.5 + 0.5 * Math.sin(now * 3.5);
        ctx.strokeStyle = `rgba(240, 160, 32, ${0.25 + 0.45 * pulse})`;
        ctx.lineWidth = Math.max(9, this.roadWidth * 0.9);
        ctx.beginPath();
        trace(pts);
        trace(back);
        ctx.stroke();
      }
      if (hot) {
        // A soft band under a highlighted route, so it stands out from the rest.
        ctx.strokeStyle = hexAlpha(companyColor(r.company), 0.28);
        ctx.lineWidth = Math.max(8, this.roadWidth * 0.8);
        ctx.beginPath();
        trace(pts);
        trace(back);
        ctx.stroke();
      }
      // Dashed like the road's centre line, dash for dash: street by street, from the same end,
      // so on a street of its own its dashes sit right on the centre line's.
      ctx.strokeStyle = companyColor(r.company);
      ctx.globalAlpha = hot ? 1 : 0.75;
      // Thicker than the centre line (scale * 0.025), so a route never reads as road paint.
      ctx.lineWidth = Math.max(hot ? 3 : 2, this.scale * (hot ? 0.075 : 0.05));
      ctx.setLineDash(this.centreDash());
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const [a, b] of this.routeStreets(r, routes)) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.lineCap = 'round';
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
        // An empty lot: a staked-out plot where a business may open (with a little sign).
        const s = r * 0.95;
        ctx.strokeStyle = '#c9c0ae';
        ctx.lineWidth = Math.max(1, this.scale * 0.03);
        ctx.setLineDash([this.scale * 0.05, this.scale * 0.075]);
        ctx.strokeRect(x - s, y - s, 2 * s, 2 * s);
        ctx.setLineDash([]);
        if (detail) {
          ctx.fillStyle = '#b8ae99';
          ctx.fillRect(x - 0.6, y - s * 0.2, 1.2, s * 0.75);
          ctx.fillRect(x - s * 0.38, y - s * 0.55, s * 0.76, s * 0.4);
        }
        continue;
      }
      if (l.kind === 'depot') {
        const owner = obs.depots[l.id];
        const s = r * 1.05; // on par with the other buildings, leaving a sidewalk round the block
        ctx.lineWidth = 1.5;
        if (owner === undefined) {
          const price = hl.buyFor !== null ? obs.depotPrices[l.id]?.[hl.buyFor] : undefined;
          const prices = obs.depotPrices[l.id];
          // Subsidy meters show while you hover this site or a company card, or are buying a factory.
          const showMeter = !!prices && (hovered || hl.cardCompany !== null || hl.buyFor !== null);
          ctx.fillStyle = price !== undefined ? '#fff6d6' : '#ffffff';
          ctx.strokeStyle = price !== undefined ? '#b08a1e' : '#9a9283';
          roundRect(ctx, x - s, y - s, 2 * s, 2 * s, 3);
          ctx.fill();
          ctx.stroke();
          if (price !== undefined) label(ctx, `$${price}`, x, y - s - 7, '#7a5d10');
          if (!showMeter) {
            // A plain white factory, with the same garage door as an owned one.
            ctx.strokeStyle = 'rgba(0,0,0,0.2)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - s * 0.55 + 0.5, y - s * 0.1 + 0.5, s * 1.1 - 1, s * 0.85 - 1);
            for (let k = 1; k < 3; k++) {
              ctx.beginPath();
              ctx.moveTo(x - s * 0.55, y - s * 0.1 + (k * s * 0.85) / 3);
              ctx.lineTo(x + s * 0.55, y - s * 0.1 + (k * s * 0.85) / 3);
              ctx.stroke();
            }
          } else {
            // Subsidy meters, filling the building: a column for each of the (up to three) companies
            // furthest along here (always including a hovered company card's), in company order,
            // each filled with its progress towards the full discount. A full column carries a star,
            // and a column blinks when one of that company's pickups or deliveries lands in the zone.
            const all = hl.meterFor
              .map((c) => ({ c, frac: Math.max(0, Math.min(1, (1 - prices[c] / hl.siteBase) / hl.maxSubsidy)) }))
              .filter((m) => m.frac > 0)
              .sort((a, b) => b.frac - a.frac || a.c - b.c);
            let cols = all.slice(0, 3);
            const focus = all.find((m) => m.c === hl.cardCompany);
            if (focus && !cols.includes(focus)) cols = [...cols.slice(0, 2), focus];
            cols.sort((a, b) => a.c - b.c);
            const pad = Math.max(2, s * 0.14);
            const gap = Math.max(1.5, s * 0.08);
            const bottom = y + s - pad;
            const full = 2 * (s - pad);
            const w = (full - gap * 2) / 3; // always three slots, so columns keep their width
            const left = x - s + pad + ((3 - cols.length) * (w + gap)) / 2; // centred
            const flashes = hl.flash.get(l.id);
            cols.forEach(({ c, frac }, k) => {
              const cx = left + k * (w + gap);
              ctx.fillStyle = hexAlpha(companyColor(c), 0.16);
              ctx.fillRect(cx, bottom - full, w, full);
              const t = flashes?.get(c);
              const since = t === undefined ? Infinity : obs.t - t;
              const blink = since >= 0 && since < 0.6 ? 1 - since / 0.6 : 0;
              ctx.fillStyle = companyColor(c);
              ctx.fillRect(cx, bottom - full * frac, w, full * frac);
              if (blink) {
                ctx.fillStyle = `rgba(255,255,255,${0.55 * blink})`;
                ctx.fillRect(cx, bottom - full * frac, w, full * frac);
              }
              ctx.strokeStyle = c === hl.cardCompany ? INK : 'rgba(0,0,0,0.35)';
              ctx.lineWidth = c === hl.cardCompany ? 1.5 : 1;
              ctx.strokeRect(cx + 0.5, bottom - full * frac + 0.5, Math.max(0, w - 1), Math.max(0, full * frac - 1));
              if (frac >= 1) {
                const size = Math.min(w * 0.95, full * 0.5);
                if (size >= 5) {
                  ctx.fillStyle = '#ffffff';
                  ctx.font = `${Math.round(size)}px system-ui, sans-serif`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  ctx.fillText('★', cx + w / 2, bottom - full + size * 0.7);
                }
              }
            });
          }
        } else {
          drawFactory(ctx, x, y, s, companyColor(owner));
        }
        if (picked || hovered) ring(ctx, x, y, s * 1.5, picked ? INK : '#8a8273');
        if (owner !== undefined && hl.spotlight.has(owner)) {
          const pulse = 0.5 + 0.5 * Math.sin(now * 4);
          ring(ctx, x, y, s * (1.7 + 0.35 * pulse), companyColor(owner), 3);
        }
        continue;
      }
      const st = byId.get(l.id);
      const closing = st?.closingIn !== null && st?.closingIn !== undefined;
      drawBusiness(ctx, l.kind as 'producer' | 'consumer', l.good!, x, y, r, detail);
      // Level: pips when zoomed in, a ring tint when zoomed out (none when every business has the same level).
      if (st && this.levelled) {
        if (detail) {
          const n = 5;
          const gap = Math.max(4, r * 0.42);
          for (let k = 0; k < n; k++) {
            ctx.beginPath();
            ctx.arc(x + (k - (n - 1) / 2) * gap, y + r * 1.22, Math.max(1.3, r * 0.12), 0, Math.PI * 2);
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
      // A premium shop (pays more per pallet): a gold coin on its roof.
      if (st && st.kind === 'consumer' && st.price > this.palletPrice + 1e-9) {
        const cr = Math.max(3.5, r * 0.42);
        const ccx = x + r * 0.78;
        const ccy = y - r * 0.78;
        ctx.fillStyle = '#f2c230';
        ctx.strokeStyle = '#8a6510';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(ccx, ccy, cr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (cr >= 5) {
          ctx.fillStyle = '#7a5208';
          ctx.font = `800 ${Math.round(cr * 1.3)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('$', ccx, ccy + 0.5);
        }
      }
      // Shop orders (placeholder look): an open order is a ring that fills as pallets arrive, with
      // what's still wanted; a quiet shop (no order) is faded.
      if (st && st.kind === 'consumer' && this.orders) {
        if (st.order) {
          const done = st.order.size - st.demand;
          const rr = r * 1.45;
          ctx.lineWidth = Math.max(2.5, r * 0.22);
          ctx.strokeStyle = 'rgba(35,32,27,0.15)';
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = '#2e8a3e';
          ctx.beginPath();
          ctx.arc(x, y, rr, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * done) / st.order.size);
          ctx.stroke();
          label(ctx, `${st.demand}`, x + rr * 0.8, y - rr * 0.8, '#1f5f29');
        } else {
          ctx.fillStyle = 'rgba(244,241,234,0.6)';
          ctx.beginPath();
          ctx.arc(x, y, r * 1.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Closing: a slow, soft pulse rather than a hard blink (it's news, not an alarm).
      if (closing) ring(ctx, x, y, r * 1.6, `rgba(209, 52, 47, ${0.25 + 0.5 * (0.5 + 0.5 * Math.sin(now * 2.2))})`, 2.5);
      if (picked || hovered) ring(ctx, x, y, r * 1.6, picked ? INK : '#8a8273');
    }

    // Puffs of smoke where factories were just bought.
    this.puffs = this.puffs.filter((p) => now - p.t0 < 1.2);
    for (const p of this.puffs) {
      const f = (now - p.t0) / 1.2;
      const px = this.X(p.x);
      const py = this.Y(p.y);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 + k * 0.4;
        const d = this.r * (0.9 + 2.2 * Math.sqrt(f));
        const rad = this.r * (0.5 + 0.8 * f) * (k % 2 ? 0.75 : 1);
        const cx = px + Math.cos(a) * d;
        const cy = py + Math.sin(a) * d - f * this.r * 1.2;
        ctx.fillStyle = `rgba(140, 133, 122, ${0.7 * (1 - f)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(250, 248, 242, ${0.8 * (1 - f)})`;
        ctx.beginPath();
        ctx.arc(cx - rad * 0.25, cy - rad * 0.25, rad * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Route truck counts (on top of buildings), halfway along the longer leg of each route (so they
    // don't pile up on the factory in the middle).
    for (const [i, rt] of routes.entries()) {
      const pts = lines[i];
      const d = this.town.locations[rt.depot];
      const dx = this.X(d.x);
      const dy = this.Y(d.y);
      let split = 0;
      pts.forEach((p, k) => {
        if (Math.hypot(p.x - dx, p.y - dy) < Math.hypot(pts[split].x - dx, pts[split].y - dy)) split = k;
      });
      const a = pts.slice(0, split + 1);
      const b = pts.slice(split);
      const m = midpoint(pathLength(a) >= pathLength(b) ? a : b);
      badge(ctx, `${rt.trucks}`, m.x, m.y, hl.saturated.has(rt.key) ? '#d98a0b' : companyColor(rt.company));
    }

    // Grid coordinates along the top and left edges.
    if (this.scale >= 14) {
      ctx.fillStyle = '#a39b8c';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < blocksX; i++) ctx.fillText(String.fromCharCode(65 + i), this.X(i + 0.5), Math.max(8, this.Y(-0.3) - 8));
      ctx.textAlign = 'right';
      for (let j = 0; j < blocksY; j++) ctx.fillText(`${j + 1}`, Math.max(14, this.X(-0.3) - 4), this.Y(j + 0.5));
    }

    // Trucks.
    const { w: tw, h: th } = this.truckSize;
    const tById = new Map(obs.trucks.map((t) => [t.id, t]));
    for (const p of trucks) {
      const t = tById.get(p.id)!;
      const x = this.X(p.x);
      const y = this.Y(p.y);
      const ang = Math.atan2(p.dy, p.dx);
      ctx.save();
      ctx.translate(x, y);
      // Point the way it's heading (parked trucks: along their street, the way the lane goes).
      if (Math.abs(p.dx) + Math.abs(p.dy) > 1e-6) ctx.rotate(ang);
      // A long truck in the company's colour: the trailer (with its load set inside a coloured rim)
      // and, in front, a cab with a pale windscreen.
      const col = companyColor(t.company);
      const cabW = tw * 0.24;
      const gapW = Math.max(1, tw * 0.04);
      const trW = tw - cabW - gapW;
      ctx.fillStyle = col;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      roundRect(ctx, -tw / 2, -th / 2, trW, th, 1.5);
      ctx.fill();
      ctx.stroke();
      roundRect(ctx, tw / 2 - cabW, -th / 2 + th * 0.06, cabW, th * 0.88, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(tw / 2 - cabW * 0.42, -th / 2 + th * 0.2, cabW * 0.26, th * 0.6);
      // Open-top bed: raw material is a rough crate (cross-braced), product a wrapped pallet
      // (with a band), both in the good's colour; an empty bed is dark.
      const rim = Math.max(1.5, th * 0.2);
      const bx = -tw / 2 + rim;
      const bw = trW - 2 * rim;
      // While a load is being processed it's in the factory, not on the truck.
      if (t.cargo && t.state !== 'processing') {
        drawCrate(ctx, bx, -th / 2 + rim, bw, th - 2 * rim, t.cargo.good, t.cargo.processed);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(bx, -th / 2 + rim, bw, th - 2 * rim);
      }
      ctx.restore();
      // Loading, unloading or being processed: a pie fills up beside the truck as the job goes on.
      // While loading or unloading, a little crate also hops between the building and the truck.
      if (t.state === 'servicing' || t.state === 'processing') {
        const total = t.state === 'servicing' ? this.serviceSec : this.processSec;
        const done = Math.max(0, Math.min(1, 1 - (t.busyUntil - obs.t) / Math.max(0.01, total)));
        const pr = Math.max(4, tw * 0.3);
        const px = x + tw * 0.55;
        const py = y - th * 0.95;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = t.state === 'processing' ? '#5b6b7a' : companyColor(t.company);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, pr - 1.5, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2);
        ctx.closePath();
        ctx.fill();
        // A crate hops between the building and the truck: raw goods (cross-braced) into a truck at a
        // producer and into the factory; finished goods (gold-trimmed) out of the factory and into a shop.
        const site = t.state === 'servicing' ? (t.at !== null ? this.town.locations[t.at] : null) : this.locationByNode().get(t.node) ?? null;
        if (site) {
          const bx = this.X(site.x);
          const by = this.Y(site.y);
          let f: number;
          let finished: boolean;
          if (t.state === 'processing') {
            // First half: the raw load goes in; second half: the finished product comes back out.
            finished = done >= 0.5;
            f = finished ? (done - 0.5) * 2 : 1 - done * 2;
          } else {
            f = (done * 3) % 1; // three hops per job
            finished = site.kind === 'consumer';
            if (finished) f = 1 - f;
          }
          const hop = Math.min(this.scale * 0.25, Math.hypot(x - bx, y - by) * 0.35);
          const cx = bx + (x - bx) * f;
          const cy = by + (y - by) * f - Math.sin(f * Math.PI) * hop;
          const cs = Math.max(5, tw * 0.38);
          const good = t.cargo?.good ?? site.good ?? 0;
          drawCrate(ctx, cx - cs / 2, cy - cs / 2, cs, cs, good, finished);
        }
      }
    }
  }

  /** Road nodes by position ("x,y"), for finding the street at a block's side. Cached per town. */
  private nodeAtCache: { town: Town; map: Map<string, number> } | null = null;
  private nodeAt(): Map<string, number> {
    if (this.nodeAtCache?.town === this.town) return this.nodeAtCache.map;
    const map = new Map<string, number>();
    const term = this.town.graph.terminal;
    this.town.graph.nodes.forEach((n, id) => {
      if (!term[id]) map.set(`${n.x},${n.y}`, id);
    });
    this.nodeAtCache = { town: this.town, map };
    return map;
  }

  /** Smoke puffs in progress (world position, start time in seconds). */
  private puffs: { x: number; y: number; t0: number }[] = [];
  /** A puff of smoke at a site (a factory was just bought there). */
  puff(x: number, y: number) {
    this.puffs.push({ x, y, t0: performance.now() / 1000 });
  }

  /** The ordinary pallet price: shops paying more are premium (drawn with a gold coin). */
  palletPrice = 2.4;
  /** Whether businesses have levels to show (off when they're all fixed at one). */
  levelled = true;
  /** Whether shops take orders (draw each order's progress, and fade quiet shops). */
  orders = false;

  /** How long loading/unloading and factory processing take (seconds), for the progress pies. */
  serviceSec = 3;
  processSec = 3;

  /** Locations by road node (cached per town). */
  private locAtCache: { town: Town; map: Map<number, Location> } | null = null;
  private locationByNode(): Map<number, Location> {
    if (this.locAtCache?.town !== this.town) this.locAtCache = { town: this.town, map: new Map(this.town.locations.map((l) => [l.node, l])) };
    return this.locAtCache.map;
  }

}

/** A load in the good's colour: raw goods are a cross-braced crate, finished goods a pallet with a band and a gold trim. */
function drawCrate(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, good: number, finished: boolean) {
  ctx.fillStyle = goodColor(good);
  ctx.fillRect(x0, y0, w, h);
  if (finished) {
    ctx.fillStyle = good === 0 ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.75)';
    ctx.fillRect(x0 + w * 0.4, y0, w * 0.2, h);
    ctx.strokeStyle = '#e6b422';
    ctx.lineWidth = Math.max(1.5, Math.min(w, h) * 0.16);
    ctx.strokeRect(x0, y0, w, h);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x0 - ctx.lineWidth, y0 - ctx.lineWidth, w + 1.6, h + 1.6);
  } else {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x0, y0, w, h);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + w, y0 + h);
    ctx.moveTo(x0 + w, y0);
    ctx.lineTo(x0, y0 + h);
    ctx.stroke();
  }
}

/** A producer (round, with a chimney) or a shop (a house), in its good's colour with its icon. */
export function drawBusiness(ctx: CanvasRenderingContext2D, kind: 'producer' | 'consumer', good: number, x: number, y: number, r: number, icon = true) {
  ctx.fillStyle = goodColor(good);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.6;
  if (kind === 'producer') {
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
  if (icon) {
    // An icon for what it makes (raw material) or sells (product).
    ctx.font = `${Math.round(r * 1.05)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const glyph = (kind === 'producer' ? RAW_ICONS : PRODUCT_ICONS)[good % RAW_ICONS.length];
    ctx.fillText(glyph, x, y + (kind === 'consumer' ? r * 0.22 : 0));
  }
}

/** A factory: a square in its company's colour with a garage door. */
export function drawFactory(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.fillStyle = color;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
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

/** Where a truck is drawn, and which way it faces. */
export interface Spot {
  x: number;
  y: number;
  dx: number;
  dy: number;
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


/** A #rrggbb colour with an alpha. */
function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function pathLength(pts: { x: number; y: number }[]) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return total;
}

function midpoint(pts: { x: number; y: number }[]) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (left <= seg && seg > 0) {
      const f = left / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
    }
    left -= seg;
  }
  return pts[pts.length - 1] ?? { x: 0, y: 0 };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
