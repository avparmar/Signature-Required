/**
 * The client: a solo game against bots in real time.
 *
 * - The town, trucks and routes are drawn by render.ts; drag to pan, scroll to zoom.
 * - Companies route their own trucks. A president edits its delivery area from the company panel:
 *   click (or drag across) blocks to add them, right-click (or right-drag) to take them out, and
 *   double-click a producer or shop to focus on it. Esc or Done ends editing.
 * - Company panel (#34): treasury, fleet, depots and routes for companies you run; buy trucks and
 *   depots (affordable sites light up on the map with your price).
 * - The share market lives in the company cards: each company's sale (when one is running), its
 *   standing bid and ask, what the company pays to buy a share back, and a box to bid or ask.
 */
import { distancesFrom, makeGameConfig, minimumBid, type GameConfig, type GameConfigOverrides, type GameEvent, type Location, type Observation } from '@sr/core';
import { Renderer, type Spot, companyColor, companySlot, coordOf, drawBusiness, drawFactory, goodColor, pickCompanySlots, type Highlights } from './render.js';
import { Session } from './session.js';
import { TruckMotion } from './motion.js';
import type { Match } from './match.js';
import { GuestLobby, HostLobby, normalizeCode } from './net.js';
import { SETTINGS, loadSettings, mergeOverrides, overridesFrom, saveSettings, valueIn, type Setting } from './settings.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (x: number) => `$${Math.floor(x + 1e-9)}`;
/** A pallet price, to the cent. */
const cents = (x: number) => `$${x.toFixed(2)}`;
/** Names for a good: its raw material, product, producer and consumer. */
const names = (good: number) => {
  const t = session.cfg.town;
  return { raw: t.raws[good], product: t.goods[good], source: t.sources[good], shop: t.shops[good] };
};
/**
 * Company names, one per colour (so a colour always means the same company), each with a
 * three-letter ticker for tight spots like a player's holdings.
 */
const COMPANY_NAMES: [string, string][] = [
  ['Red Rocket Hauling', 'RRH'],
  ['Bluebird Express', 'BBX'],
  ['Greenway Freight', 'GWF'],
  ['Purple Pony Transport', 'PPT'],
  ['Orange Owl Logistics', 'OOL'],
  ['Iron Horse Solutions', 'IHS'],
  ['Magenta Moth Movers', 'MMM'],
  ['Lime Lizard Lines', 'LLL'],
  ['Skyhook Shipping', 'SKY'],
];
const coName = (c: number) => COMPANY_NAMES[companySlot(c)][0];
const coTicker = (c: number) => COMPANY_NAMES[companySlot(c)][1];
/** A holding as a chip in the company's colour: ticker, shares, and a crown for its president. */
const holdingChip = (c: number, n: number, pres: boolean) =>
  `<span class="chip co-chip${pres ? ' pres' : ''}" style="background:${companyColor(c)}" title="${coName(c)}: ${n} share${n === 1 ? '' : 's'}${pres ? ', president' : ''}">${pres ? '♔ ' : ''}${coTicker(c)} ×${n}</span>`;
// While watching the bots, the first seat isn't you.
const playerName = (p: number, me: number) => (p === me && !watching ? 'you' : seatName(p));
/** A seat's name: the person's name online, otherwise just their icon. */
const seatName = (p: number) => session.names[p] || seatIcon(p);
/** Each seat's icon, so players are easy to tell apart wherever they appear (names alone aren't, online). */
const SEAT_ICONS = ['🦊', '🐻', '🐸', '🐧', '🦉', '🐙', '🐯', '🐨', '🐼', '🦁', '🐢', '🐝'];
/** Each seat's icon as the game has it (players pick theirs in the opening round). */
let seatIcons: number[] = [];
const seatIcon = (p: number) => SEAT_ICONS[(seatIcons[p] ?? p) % SEAT_ICONS.length];
/** A short label: icon, plus their name (trimmed) online. */
const seatShort = (p: number) => (session.names[p] ? `${seatIcon(p)} ${session.names[p].slice(0, 8)}` : seatIcon(p));
const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Rule options from the page address, for trying settings out: ?via=none (direct routes, no
 * factory stop) or ?via=hub (the factory on both legs; the default is the loaded leg), and
 * ?rivers=1 or ?rivers=2 for a town with rivers.
 */
function overridesFromUrl(): GameConfigOverrides {
  const q = new URLSearchParams(location.search);
  const via = q.get('via');
  const rivers = q.get('rivers') === null ? null : Number(q.get('rivers'));
  const o: GameConfigOverrides = {};
  if (via === 'none' || via === 'loaded' || via === 'hub') o.trucks = { viaDepot: via };
  // One river by default; ?rivers=0 for none, ?rivers=2 for two.
  if (rivers !== null && Number.isFinite(rivers)) o.town = { rivers: Math.max(0, Math.min(2, Math.floor(rivers))) };
  // ?seed=N replays the same town (handy for comparing or reporting a game).
  const seed = Number(q.get('seed'));
  if (Number.isInteger(seed) && seed > 0) o.seed = seed;
  return o;
}

/** Watching the bots play (?watch=1, or from the settings or welcome card): every seat is a bot. */
let watching = new URLSearchParams(location.search).get('watch') === '1';
let session: Match = new Session({ overrides: mergeOverrides(loadSettings(), overridesFromUrl()), watch: watching });
pickCompanySlots(session.cfg.companies, session.cfg.seed);
const renderer = new Renderer($<HTMLCanvasElement>('map'), session.game.town);
const motion = new TruckMotion(renderer);
renderer.via = session.cfg.trucks.viaDepot;
renderer.serviceSec = session.cfg.trucks.serviceSec;
renderer.processSec = session.cfg.trucks.signOffSec;
renderer.palletPrice = session.cfg.money.palletPrice;
let last = performance.now();
let lastUi = 0;

// ------------------------------------------------------------------ selection and input state

const hl: Highlights = {
  hover: null,
  picked: [],
  hoverRoute: null,
  listRoute: null,
  saturated: new Set(),
  buyFor: null,
  spotlight: new Set<number>(),
  district: session.cfg.depots.districtBlocks,
  meterFor: [],
  cardCompany: null,
  siteBase: session.cfg.depots.depotBase,
  maxSubsidy: session.cfg.depots.maxSubsidy,
  flash: new Map(),
  areaEdit: null,
  hoverBlock: null,
  areaHover: null,
};
/** Company the player last acted for (route clicks default to it). */
let activeCompany: number | null = null;
/** Smoothed on-screen truck positions (town coordinates). */
const shown = new Map<number, Spot>();
let mouse = { x: 0, y: 0, inside: false };

function myCompanies(obs: Observation): number[] {
  return obs.companies.filter((c) => c.presidents.includes(obs.me)).map((c) => c.id);
}

function currentCompany(obs: Observation): number | null {
  const mine = myCompanies(obs);
  if (activeCompany !== null && mine.includes(activeCompany)) return activeCompany;
  return mine[0] ?? null;
}

// ------------------------------------------------------------------ feedback

function toast(text: string, kind: 'info' | 'error' = 'info') {
  const box = $('toasts');
  // The same message twice in a row just stays up; never more than three at once.
  if ([...box.children].some((c) => c.textContent === text && !c.classList.contains('fade'))) return;
  while (box.children.length >= 3) box.firstChild!.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.classList.add('fade'), 2600);
  setTimeout(() => el.remove(), 3200);
}

function updateHint(obs: Observation) {
  const g = session.game;
  const hint = $('hint');
  $('me-title').textContent = watching ? `${seatIcon(obs.me)} (a bot you're watching)` : 'You';
  $('mycos-title').textContent = watching ? `${seatIcon(obs.me)}'s companies` : 'Your companies';
  if (watching) {
    hint.textContent = 'Watching the bots play. Change the speed at the top; New game to play yourself.';
    return;
  }
  if (hl.buyFor !== null) {
    hint.textContent = `Buying a factory for ${coName(hl.buyFor)}: click a highlighted site (Esc to cancel).`;
    return;
  }
  if (obs.phase === 'opening') {
    hint.textContent = 'Opening round: bid for shares in the company cards along the bottom. The president of a company runs it.';
    return;
  }
  if (hl.areaEdit) hint.textContent = `Editing ${coName(hl.areaEdit.company)}'s delivery area.`;
  else if (myCompanies(obs).length === 0) hint.textContent = 'You run no company yet: own the most shares of one to become its president.';
  else hint.textContent = 'Your companies route their own trucks. Buy trucks and choose where they deliver on the tabs atop their cards; click a free factory site to buy it.';
}

// ------------------------------------------------------------------ delivery areas

/** Painting blocks into (or out of) the area being edited: one stroke, from press to release. */
let paint: { add: boolean } | null = null;
/** The area before each of the last few strokes (a double-click to focus undoes its two clicks). */
const before: number[][] = [];
/** A little box truck: the cargo box in the company's colour, a cab with a window, speed lines. */
const truckIcon = (color: string) =>
  `<svg class="truck-icon" viewBox="0 0 32 20" aria-hidden="true"><g stroke="#23201b" stroke-width="1.4" stroke-linejoin="round"><path d="M1 6.5h3M2 10h3" stroke-linecap="round" opacity="0.5"/><rect x="6" y="2" width="15" height="11.5" rx="1.6" fill="${color}"/><path d="M8.5 9.5h10" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/><path d="M21 5.5h5l3.5 4.2v3.8H21z" fill="#fbf9f4"/><path d="M23 7.2h2.6l2 2.5H23z" fill="#9fc4dd" stroke-width="1"/><circle cx="10.5" cy="15.5" r="2.8" fill="#23201b"/><circle cx="25" cy="15.5" r="2.8" fill="#23201b"/></g><circle cx="10.5" cy="15.5" r="1" fill="#fbf9f4"/><circle cx="25" cy="15.5" r="1" fill="#fbf9f4"/></svg>`;
/** A little map of blocks, some in the company's colour: the delivery-area icon. */
const areaIcon = (color: string) =>
  `<svg class="area-icon" viewBox="0 0 24 24" aria-hidden="true"><g stroke="${color}" stroke-width="1.6"><rect x="2" y="2" width="9" height="9" rx="1.5" fill="${hexA(color, 0.3)}"/><rect x="13" y="2" width="9" height="9" rx="1.5" fill="${hexA(color, 0.3)}"/><rect x="2" y="13" width="9" height="9" rx="1.5" fill="${hexA(color, 0.3)}"/><rect x="13" y="13" width="9" height="9" rx="1.5" fill="none" stroke-dasharray="2.5 2"/></g></svg>`;
const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
/** Holding Space while editing an area: drag moves the map instead of painting. */
let spaceHeld = false;

function startAreaEdit(company: number) {
  const obs = session.obs();
  hl.areaEdit = { company, blocks: new Set(obs.companies[company].area) };
  hl.buyFor = null;
  activeCompany = company;
  showAreaBar();
}

function endAreaEdit() {
  hl.areaEdit = null;
  spaceHeld = false;
  $('map').classList.remove('panning');
  hl.hoverBlock = null;
  paint = null;
  $('area-bar').hidden = true;
}

function commitArea() {
  if (!hl.areaEdit) return;
  session.act({ type: 'setArea', company: hl.areaEdit.company, blocks: [...hl.areaEdit.blocks] });
}

function paintAt(sx: number, sy: number) {
  if (!hl.areaEdit || !paint) return;
  const b = renderer.blockAt(sx, sy);
  if (b === null) return;
  if (paint.add) hl.areaEdit.blocks.add(b);
  else hl.areaEdit.blocks.delete(b);
}

/** The bar over the map while editing: whose area, how to edit it, Clear and Done. */
function showAreaBar() {
  const bar = $('area-bar');
  if (!hl.areaEdit) return;
  const c = hl.areaEdit.company;
  bar.innerHTML = `<span class="sw" style="background:${companyColor(c)}"></span><b>${coName(c)}: delivery area</b>
    <button id="area-clear">Clear</button><button id="area-done" class="go">Done</button>
    <div class="area-hint">Click or drag over blocks to add them; right-click or right-drag to take them out. Double-click a producer or shop to focus on it (up to ${session.cfg.maxFocus}). No area: it delivers anywhere. <span class="gold">Gold arrows</span> point to the factory sites that deliveries there make cheaper. Hold Space (or the middle button) and drag to move the map.</div>`;
  bar.hidden = false;
  $('area-clear').onclick = () => {
    if (!hl.areaEdit) return;
    hl.areaEdit.blocks.clear();
    commitArea();
  };
  $('area-done').onclick = endAreaEdit;
}

const reachCache = new Map<number, Float64Array>();
/** Drive distances from a depot site (cached per game). */
function siteReach(site: number): Float64Array {
  const d = reachCache.get(site) ?? distancesFrom(session.game.town.graph, session.game.town.locations[site].node);
  reachCache.set(site, d);
  return d;
}

/** A company's free trucks (trucks are a company-wide pool). */
const freeTrucks = (obs: Observation, company: number) =>
  obs.trucks.filter((t) => t.company === company && t.route === null && t.orders.length === 0 && t.cargo === null).length;

function click(sx: number, sy: number, right: boolean) {
  const obs = session.obs();
  const l = renderer.locationAt(sx, sy);
  if (right) {
    hl.buyFor = null;
    return;
  }
  if (hl.buyFor !== null) {
    if (l && l.kind === 'depot' && obs.depots[l.id] === undefined) {
      session.act({ type: 'buyDepot', company: hl.buyFor, site: l.id });
      activeCompany = hl.buyFor;
      hl.buyFor = null;
    } else toast('Click a free (dashed) factory site, or Esc to cancel.', 'error');
    return;
  }
  if (l?.kind === 'depot' && obs.depots[l.id] === undefined) {
    if (myCompanies(obs).length) sitePop = sitePop === l.id ? null : l.id;
    else toast('An unclaimed factory site. A company you run can buy it.', 'info');
  } else sitePop = null;
}

// ------------------------------------------------------------------ canvas events

const canvas = $<HTMLCanvasElement>('map');
let drag: { x: number; y: number; moved: boolean } | null = null;
canvas.addEventListener('mousedown', (e) => {
  // The middle button always moves the map, and so does any drag with Space held while editing.
  if (e.button === 1 || (hl.areaEdit && spaceHeld && e.button === 0)) {
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, moved: true };
    return;
  }
  if (hl.areaEdit && (e.button === 0 || e.button === 2)) {
    // Editing an area: press and drag paints blocks in (left) or out (right).
    before.push([...hl.areaEdit.blocks]);
    if (before.length > 3) before.shift();
    paint = { add: e.button === 0 };
    const box = canvas.getBoundingClientRect();
    paintAt(e.clientX - box.left, e.clientY - box.top);
    return;
  }
  if (e.button === 0) drag = { x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener('mousemove', (e) => {
  const box = canvas.getBoundingClientRect();
  mouse = { x: e.clientX - box.left, y: e.clientY - box.top, inside: e.target === canvas };
  if (hl.areaEdit) {
    hl.hoverBlock = mouse.inside ? renderer.blockAt(mouse.x, mouse.y) : null;
    paintAt(mouse.x, mouse.y);
  }
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.moved || Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      renderer.pan(dx, dy);
      viewMoved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
    }
  }
});
window.addEventListener('mouseup', (e) => {
  if (paint) {
    paint = null;
    commitArea();
    return;
  }
  if (drag && (e.button === 1 || hl.areaEdit)) {
    drag = null; // a pan, not a click
    return;
  }
  if (e.button !== 0 || !drag) return;
  const wasDrag = drag.moved;
  drag = null;
  if (!wasDrag && e.target === canvas) {
    const box = canvas.getBoundingClientRect();
    click(e.clientX - box.left, e.clientY - box.top, false);
  }
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (hl.areaEdit) return; // painting handles it
  const box = canvas.getBoundingClientRect();
  click(e.clientX - box.left, e.clientY - box.top, true);
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const box = canvas.getBoundingClientRect();
    renderer.zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * 0.0015));
    viewMoved = true;
  },
  { passive: false },
);
canvas.addEventListener('dblclick', (e) => {
  if (hl.areaEdit) {
    // Focus on (or stop focusing on) a producer or shop; the double-click's two clicks don't count.
    const box = canvas.getBoundingClientRect();
    const l = renderer.locationAt(e.clientX - box.left, e.clientY - box.top);
    if (before.length >= 2) {
      hl.areaEdit.blocks = new Set(before[before.length - 2]);
      commitArea();
    }
    if (!l || (l.kind !== 'producer' && l.kind !== 'consumer')) return;
    const c = session.obs().companies[hl.areaEdit.company];
    session.act({ type: 'setFocus', company: c.id, location: l.id, on: !c.focus.includes(l.id) });
    return;
  }
  renderer.fit();
  viewMoved = false;
});
/** Whether you've panned or zoomed (then a change in the map's size keeps your view). */
let viewMoved = false;
// Resizing a canvas wipes it, so only when the size really changed, and draw again at once (no blank frame).
new ResizeObserver(() => {
  const box = $('map-wrap').getBoundingClientRect();
  if (Math.abs(box.width - renderer.w) < 0.5 && Math.abs(box.height - renderer.h) < 0.5) return;
  renderer.resize(!viewMoved);
  redraw?.();
}).observe($('map-wrap'));
/** Draws the last frame again (after a resize). */
let redraw: (() => void) | null = null;

// ------------------------------------------------------------------ tooltip

function tooltip(obs: Observation) {
  const tip = $('tooltip');
  if (!mouse.inside || drag?.moved) {
    tip.hidden = true;
    hl.hover = null;
    hl.hoverRoute = null;
    hl.areaHover = null;
    return;
  }
  const g = session.game;
  const l = renderer.locationAt(mouse.x, mouse.y, true);
  const route = l ? null : renderer.routeAt(mouse.x, mouse.y, obs.routes);
  hl.hover = l && l.kind !== 'lot' ? l.id : null;
  hl.hoverRoute = route?.key ?? null;
  // A block in one of your companies' delivery areas: its subsidy arrows (the company you're looking at first).
  hl.areaHover = null;
  if (!hl.areaEdit && !route) {
    const b = renderer.blockAt(mouse.x, mouse.y);
    const cur = currentCompany(obs);
    const mine = myCompanies(obs).sort((a, c) => Number(c === cur) - Number(a === cur));
    const co = b === null ? undefined : mine.find((c) => obs.companies[c].area.includes(b));
    if (co !== undefined) hl.areaHover = { company: co, block: b! };
  }
  let html = '';
  // A free site's card goes in a corner of the map, away from the site, so it doesn't hide the zone.
  let docked = false;
  if (l && (l.kind === 'producer' || l.kind === 'consumer')) {
    const s = obs.locations.find((x) => x.id === l.id);
    if (s) {
      const n = names(s.good);
      const recent = s.history.length ? Math.round((100 * s.history.reduce((a, b) => a + b, 0)) / s.history.length) : null;
      // At a glance: level, this cycle's progress, and when the next cycle comes.
      const prod = s.kind === 'producer';
      html = `<b>${cap(prod ? n.source : n.shop)} ${at(l.id)}</b>`;
      html += `<div class="tip-stats"><div><span>Level</span><b>${s.level}/${g.cfg.cycles.maxLevel}</b></div><div><span>${prod ? 'Shipped / made' : 'Received / needed'}</span><b>${s.served}/${s.cycleAmount}</b></div><div><span>Next cycle</span><b>${fmtClock(Math.max(0, s.nextCycleAt - obs.t))}</b></div></div>`;
      html += prod
        ? `<div class="muted">${s.stock} load${s.stock === 1 ? '' : 's'} of ${n.raw} waiting · a factory makes it into ${n.product}</div>`
        : `<div class="muted">Pays ${cents(s.price)} a pallet${s.price > g.cfg.money.palletPrice ? ' (premium)' : ''}</div>`;
      if (recent !== null) html += `<div class="muted">${recent}% served lately</div>`;
      if (s.closingIn !== null) html += `<div class="bad">Closing in ${s.closingIn} cycle${s.closingIn === 1 ? '' : 's'} unless served</div>`;
      const servers = [...new Set(obs.routes.filter((r) => r.producer === l.id || r.consumer === l.id).map((r) => r.company))];
      if (servers.length) html += `<div class="muted">Served by ${servers.map(coName).join(', ')}</div>`;
    }
  } else if (l && l.kind === 'depot') {
    const owner = obs.depots[l.id];
    if (owner === undefined) {
      docked = true;
      html = `<b>Unclaimed factory site ${at(l.id)}</b><div>Serving the producers and shops in the <b>gold zone</b> cuts a company's price here.</div><div class="muted">The zone is only for the discount: a factory here can run routes anywhere.</div>`;
      const prices = obs.depotPrices[l.id];
      const dc = g.cfg.depots;
      const mine = new Set(myCompanies(obs));
      const earning = obs.companies.map((c) => c.id).filter((c) => mine.has(c) || prices[c] < dc.depotBase);
      for (const c of earning) {
        const full = prices[c] <= Math.round(dc.depotBase * (1 - dc.maxSubsidy));
        html += `<div>${full ? '★ ' : ''}${coName(c)}${mine.has(c) ? ' (yours)' : ''} would pay ${money(prices[c])}${full ? ', full discount' : ''}</div>`;
      }
      html += `<div class="muted">Full price ${money(dc.depotBase)}, up to ${Math.round(100 * dc.maxSubsidy)}% off. Each company's discount starts after ${dc.subsidyMinPallets} pickups and deliveries in the zone and is full at ${dc.subsidyTarget} (over the last ${Math.round(dc.subsidyWindowSec / 60)} minutes).</div>`;
    } else {
      const routes = obs.routes.filter((r) => r.depot === l.id);
      const n = routes.reduce((a, r) => a + r.trucks, 0);
      html = `<b>${coName(owner)} factory ${at(l.id)}</b><div>${routes.length} route${routes.length === 1 ? '' : 's'}, ${n} truck${n === 1 ? '' : 's'} through here</div><div class="muted">Adds ${g.cfg.depots.capacity} to the company's truck limit</div>`;
    }
  } else if (l && l.kind === 'lot') {
    html = '<span class="muted">Empty lot: a business may open here.</span>';
  } else if (route) {
    const p = g.town.locations[route.producer];
    const n = names(p.good!);
    html = `<b>${coName(route.company)}</b> · ${n.raw} ${at(route.producer)} → factory ${at(route.depot)} → ${n.product} ${at(route.consumer)} · ${route.trucks} truck${route.trucks === 1 ? '' : 's'}`;
    if (obs.companies[route.company].presidents.includes(obs.me)) html += '<div class="muted">Click to add a truck · right-click to take one off</div>';
  }
  // While drawing an area, only a free site's card (in a corner) shows: the rest would cover the map.
  if (!html || (hl.areaEdit && !docked)) {
    tip.hidden = true;
    return;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  const wrap = $('map-wrap').getBoundingClientRect();
  let x = Math.min(mouse.x + 16, wrap.width - tip.offsetWidth - 8);
  let y = Math.min(mouse.y + 16, wrap.height - tip.offsetHeight - 8);
  if (docked) {
    // The corner furthest from the pointer.
    x = mouse.x < wrap.width / 2 ? wrap.width - tip.offsetWidth - 12 : 12;
    y = mouse.y < wrap.height / 2 ? wrap.height - tip.offsetHeight - 56 : 12; // clear of the hint at the bottom
  }
  tip.classList.toggle('docked', docked);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** A location's grid name, like C4. */
const at = (id: number) => {
  const l = session.game.town.locations[id];
  return coordOf(l.x, l.y);
};

// ------------------------------------------------------------------ panels

function refreshPanels(obs: Observation) {
  const g = session.game;
  const me = obs.players[obs.me];
  $('clock').textContent = obs.phase === 'opening' ? 'Opening' : fmtClock(obs.timeLeft);
  $('phase').textContent =
    obs.phase === 'opening'
      ? 'Opening offerings: one share of each company, before the clock starts'
      : obs.phase === 'ended'
        ? 'Game over'
        : `Next payout in ${fmtClock(obs.nextPayoutAt - obs.t)}`;
  // The last 10 seconds before a payout: the countdown lights up.
  $('phase').classList.toggle('soon', obs.phase === 'running' && obs.nextPayoutAt - obs.t <= 10);

  seatIcons = obs.players.map((p) => p.icon);
  // You: cash and shares, and in the opening round, your icon to pick.
  let html = `<div class="row big"><span>Cash</span><b>${money(me.cash)}</b></div>`;
  if (obs.phase === 'opening' && !watching) {
    const taken = new Set(obs.players.filter((p) => p.id !== obs.me).map((p) => p.icon));
    html += `<div class="sub">Your icon</div><div class="icons">${SEAT_ICONS.map((ic, i) => `<button class="icon-pick${me.icon === i ? ' on' : ''}" data-icon="${i}" ${taken.has(i) ? 'disabled title="Taken"' : ''}>${ic}</button>`).join('')}</div>`;
  }
  if (me.held) html += `<div class="row muted"><span>Held for your bids</span><span>${money(me.held)}</span></div>`;
  const holdings = obs.companies.filter((c) => c.shares.includes(obs.me));
  if (holdings.length) {
    html += '<div class="sub">Your shares</div>';
    for (const c of holdings) {
      const n = c.shares.filter((s) => s === obs.me).length;
      const pres = c.presidents.includes(obs.me);
      html += `<div class="row"><span>${sw(c.id)}${coName(c.id)} ×${n}${pres ? ' <span class="tag">president</span>' : ''}</span><span class="muted">next ${money(c.dividendPerShare * n)}</span></div>`;
    }
  } else html += '<div class="muted small">No shares yet.</div>';
  $('me').innerHTML = html;

  // Everyone else: cash and holdings, as for you.
  $('players').innerHTML = [...obs.players]
    .sort((a, b) => (a.id === obs.me ? -1 : b.id === obs.me ? 1 : a.id - b.id))
    .map((p) => {
      const held = obs.companies.filter((c) => c.shares.includes(p.id));
      const shares = held
        .map((c) => {
          const n = c.shares.filter((s) => s === p.id).length;
          return holdingChip(c.id, n, c.presidents.includes(p.id));
        })
        .join('');
      const me = p.id === obs.me && !watching;
      const name = me ? 'You' : session.names[p.id] ? session.names[p.id].slice(0, 10) : '';
      return `<div class="pl${me ? ' me' : ''}" title="${me ? 'You' : seatName(p.id)}"><span class="icon">${seatIcon(p.id)}</span>${name ? `<b>${name}</b>` : ''}<span class="cash">${money(p.cash)}</span><span class="chips">${shares || '<span class="muted small">no shares</span>'}</span></div>`;
    })
    .join('');

  // Companies: everyone's at a glance, with the share market in each card.
  refreshCompanies(obs);

  refreshMyCompanies(obs);
  updateHint(obs);
  void g;
}

const sw = (c: number) => `<span class="swatch" style="background:${companyColor(c)}"></span>`;

interface Card {
  /** Its place in the strip (the card sits at its bottom and grows upwards when open). */
  slot: HTMLElement;
  root: HTMLElement;
  info: HTMLElement;
  /** The broker box: buy or sell at once, or place your own order at a price on the slider. */
  form: HTMLElement;
  quick: HTMLElement;
  buyNow: HTMLButtonElement;
  sellNow: HTMLButtonElement;
  slider: HTMLInputElement;
  price: HTMLElement;
  lo: HTMLElement;
  hi: HTMLElement;
  placeBuy: HTMLButtonElement;
  placeSell: HTMLButtonElement;
  /** What the slider was last set for (a sale starting moves it to that sale's minimum). */
  key: string;
}
const cards = new Map<number, Card>();
/** Cards you've pinned open. */
const pinnedCards = new Set<number>();

/** A company's card: the info part re-renders; the broker box is built once, so dragging isn't interrupted. */
function card(id: number): Card {
  let k = cards.get(id);
  if (k) return k;
  const slot = document.createElement('div');
  slot.className = 'slot';
  const root = document.createElement('div');
  root.className = 'co';
  root.dataset.cohover = String(id);
  slot.append(root);
  const info = document.createElement('div');
  const form = document.createElement('div');
  form.className = 'broker';
  form.innerHTML = `<div class="quick"><button type="button" class="sell-now"></button><button type="button" class="buy-now"></button></div><div class="slide"><span class="lo"></span><input type="range" min="1" max="2" step="1" aria-label="Price for your order" /><span class="hi"></span></div><div class="order"><b class="px"></b><button type="button" class="place-buy"></button><button type="button" class="place-sell"></button></div>`;
  root.append(info, form);
  const q = <T extends HTMLElement>(sel: string) => form.querySelector<T>(sel)!;
  k = { slot, root, info, form, quick: q('.quick'), buyNow: q('.buy-now'), sellNow: q('.sell-now'), slider: q('input'), price: q('.px'), lo: q('.lo'), hi: q('.hi'), placeBuy: q('.place-buy'), placeSell: q('.place-sell'), key: '' };
  cards.set(id, k);
  const kk = k;
  kk.slider.addEventListener('input', () => refreshCompanies(session.obs()));
  // Buttons act on press (the panel can re-render between press and release).
  const press = (b: HTMLButtonElement, f: () => void) => b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || b.disabled) return;
    f();
    refreshPanels(session.obs());
  });
  press(kk.buyNow, () => session.act({ type: 'buy', company: id }));
  press(kk.sellNow, () => session.act({ type: 'sell', company: id, to: (kk.sellNow.dataset.to as 'bid' | 'company') ?? 'bid' }));
  press(kk.placeBuy, () => session.act({ type: 'bid', company: id, amount: Number(kk.slider.value) }));
  // In a sale, the second button passes; otherwise it posts a sell order.
  press(kk.placeSell, () => session.act(kk.placeSell.dataset.mode === 'pass' ? { type: 'pass', company: id } : { type: 'ask', company: id, price: Number(kk.slider.value) }));
  return k;
}

/** The least a bid could be now to stand (and, in a sale, to count). */
function leastBid(obs: Observation, id: number): number {
  const book = obs.books[id];
  const min = minimumBid(book, obs.me, session.cfg.auctions);
  return Math.max(1, min, obs.minPrice[id]); // never below the company's price
}

function refreshCompanies(obs: Observation) {
  const box = $('companies');
  const me = obs.players[obs.me];
  const free = me.cash - me.held;
  const acting = !watching && obs.phase !== 'ended';
  obs.companies.forEach((c, i) => {
    const k = card(c.id);
    if (box.children[i] !== k.slot) box.insertBefore(k.slot, box.children[i] ?? null);
    const trucks = obs.trucks.filter((t) => t.company === c.id).length;
    const depots = Object.values(obs.depots).filter((o) => o === c.id).length;
    // One chip per shareholder with how many shares they hold (you first, presidents crowned),
    // then the shares the company owns itself.
    const holders = new Map<number, number>();
    for (const sh of c.shares) if (sh !== null) holders.set(sh, (holders.get(sh) ?? 0) + 1);
    const order = [...holders.keys()].sort((a, b) => (a === obs.me ? -1 : b === obs.me ? 1 : holders.get(b)! - holders.get(a)! || a - b));
    const own = c.shares.filter((sh) => sh === null).length;
    const mine = holders.get(obs.me) ?? 0;
    // Five boxes, one per share, in line of succession: the president's first (in gold), then
    // whoever would take over if they sold, and so on (yours outlined); the company's own, empty, last.
    const inLine = [...c.succession.flatMap((pl) => Array<number>(holders.get(pl) ?? 0).fill(pl)), ...c.shares.filter((sh) => sh === null)];
    const boxes = inLine
      .map((pl) => {
        if (pl === null) return '<span class="share empty" title="Owned by the company: sold in share offerings"></span>';
        const pres = c.presidents.includes(pl);
        const n = holders.get(pl)!;
        const you = pl === obs.me && !watching;
        return `<span class="share${you ? ' you' : ''}${pres ? ' pres' : ''}" title="${you ? 'You' : seatName(pl)}: ${n} share${n === 1 ? '' : 's'}${pres ? ', president' : ''}">${seatIcon(pl)}</span>`;
      })
      .join('');
    const chips = `<span class="shares">${boxes}</span>`;
    const sale = obs.sales.find((x) => x.company === c.id);
    const book = obs.books[c.id];
    const who = (p: number) => (p === obs.me && !watching ? 'you' : seatShort(p));
    const pinned = pinnedCards.has(c.id);
    const pinBtn = `<button class="pin${pinned ? ' on' : ''}" data-pin="${c.id}" title="${pinned ? 'Unpin: fold this card back down' : 'Pin this card open'}">${pinned ? 'Unpin' : 'Pin'}</button>`;
    // Open, the card has a top row (Pin) so the name gets its own line, with its ticker.
    let html = `<div class="row head-open"><span>${pinBtn}</span></div>`;
    let saleBtn = '';
    if (acting && obs.phase === 'running' && own && !sale && c.presidents.length) {
      const cooldown = obs.saleCooldownUntil[c.id] - obs.elapsed;
      saleBtn = `<button class="mini" data-startsale="${c.id}" ${cooldown > 0 ? 'disabled' : ''} title="Offer one of the company's own shares. The best bid at the end gets it, if it's at least ${money(obs.minPrice[c.id])}; the money goes to the company.">${cooldown > 0 ? `Offer in ${Math.ceil(cooldown)}s` : 'Offer a share'}</button>`;
    }
    // Name and shares on the left; the company's money in a box on the right: its treasury, the
    // dividend per share so far, and its factories.
    const coBox = `<div class="co-box"><b class="tr" title="The company's treasury: what it has to spend on trucks and factories, and to buy shares back">${money(c.treasury)}</b><span class="stats"><span title="Next dividend per share, so far">div <b>${money(c.dividendPerShare)}</b></span><span title="${depots} factor${depots === 1 ? 'y' : 'ies'}">🏭 <b>${depots}</b></span></span></div>`;
    html += `<div class="top"><div class="left"><div class="row head"><span title="${coName(c.id)}">${sw(c.id)}<b class="nm">${coName(c.id)}</b><b class="tk">${COMPANY_NAMES[companySlot(c.id)][1]}</b> <span class="ticker">${COMPANY_NAMES[companySlot(c.id)][1]}</span></span></div><div class="chips">${chips}${saleBtn}</div></div>${coBox}</div>`;
    // Folded, the card stops here (plus a line for a running sale); hovering or pinning shows the rest.
    if (sale) {
      const best = book.bid;
      html += `<div class="row small sale-line fold-only"><b>${sale.opening ? 'Opening' : 'Offering'} ${Math.ceil(sale.timeLeft)}s</b><span>${best ? `<span title="Highest bid: ${best.player === obs.me && !watching ? 'yours' : seatName(best.player)}">top bid <b>${money(best.price)}</b> ${seatIcon(best.player)}</span>` : 'no bids yet'}</span></div>`;
    }
    // Folded: the standing orders at a glance, laid out like the Sell for / Buy for buttons (buy order
    // on the left, sell order on the right). Watching the bots, there are no buttons, so all of them;
    // playing, the buttons show everyone else's, so just yours. (Opened, they're listed in full below.)
    // Playing, the Buy/Sell buttons carry the other side's icon, so this line is only for watching.
    if (obs.phase === 'running' && !sale && !acting) {
      const shown = (o: { player: number } | null) => o !== null;
      const bid = shown(book.bid) ? book.bid : null;
      const ask = shown(book.ask) ? book.ask : null;
      if (bid || ask) {
        const cell = (label: string, o: { player: number; price: number } | null, tip: string) =>
          o ? `<span title="${tip}">${label} <b>${money(o.price)}</b>${o.player === obs.me && !watching ? '' : `<span class="from">${seatIcon(o.player)}</span>`}</span>` : '<span></span>';
        const mine = acting ? 'Your ' : 'Standing ';
        const parts = [cell('Buying', bid, `${mine}buy order`), cell('Selling', ask, `${mine}sell order`)];
        html += `<div class="row small orders-line fold-only">${parts.join('')}</div>`;
      }
    }
    html += '<div class="more">';
    // Opened: its income lately, and its last dividend (the next one so far is in the box).
    const income = obs.phase === 'running' ? companyRate(c.id, obs.t) : null;
    html += `<div class="row small muted"><span title="What its deliveries earned per minute over the last ${RATE_WINDOW / 60} minutes (half to the treasury, half to dividends)">Income ${income === null ? 'earning…' : `<b>${money(income)}</b>/min`}</span><span title="Dividend per share: the last one paid">last div ${lastDividend.has(c.id) ? money(lastDividend.get(c.id)!) : '—'}</span></div>`;
    // A sale running: the share goes to the best bid at the end, if it's at least the minimum.
    if (sale) {
      const best = book.bid;
      const enough = best !== null && best.price >= obs.minPrice[c.id];
      const last = sale.age + sale.timeLeft >= session.cfg.auctions.maxSec - 0.05 && sale.timeLeft < session.cfg.auctions.softCloseSec;
      html += `<div class="sale"><div class="row"><b title="One of the company's own shares, to the highest bid at the end">${sale.opening ? 'Opening offering' : 'Share offering'}</b><b>${Math.ceil(sale.timeLeft)}s</b></div>`;
      html += `<div class="row small"><span>Highest bid</span><span>${best ? `${money(best.price)} (${who(best.player)})` : 'none yet'}</span></div>`;
      if (obs.minPrice[c.id] > 0) html += `<div class="row small muted"><span>Sells for at least</span><span>${money(obs.minPrice[c.id])}${best && !enough ? ' · not met yet' : ''}</span></div>`;
      if (best?.player === obs.me && !watching) html += `<div class="good small">${enough ? 'You’re winning it.' : 'Your bid is below the minimum.'}</div>`;
      if (sale.passed.length) html += `<div class="row small muted"><span>Passed</span><span>${sale.passed.map((pl) => (pl === obs.me && !watching ? 'you' : seatIcon(pl))).join(' ')}</span></div>`;
      if (last) html += `<div class="muted small">Final seconds: bids no longer add time.</div>`;
      html += `</div>`;
    }
    // The market: standing orders (yours can be withdrawn), the company's buy-back price, and starting a sale.
    if (obs.phase === 'running') {
      const rows: string[] = [];
      // Playing, only your own orders are listed (to withdraw them): the Buy/Sell buttons already show
      // everyone else's. Watching, all of them.
      const order = (side: 'bid' | 'ask', o: { player: number; price: number }) => {
        const yours = o.player === obs.me && !watching;
        if (acting && !yours) return;
        rows.push(`<div class="row small"><span>${yours ? `Your ${side === 'bid' ? 'buy' : 'sell'} order: ${money(o.price)}` : `${side === 'bid' ? 'Buying' : 'Selling'}: ${money(o.price)} (${who(o.player)})`}</span>${acting && yours ? `<button class="mini" data-cancel="${c.id}:${side}">Withdraw</button>` : ''}</div>`);
      };
      if (book.bid && !sale) order('bid', book.bid);
      if (book.ask) order('ask', book.ask);
      const cb = obs.companyBid[c.id];
      if (cb !== null) rows.push(`<div class="row small"><span title="Half its value per share (it's worth ${money(obs.value[c.id])}: trucks and factories at cost, plus cash), while its cash covers that">Company buys back at ${money(cb)}</span></div>`);
      html += rows.join('');
    }
    html += '</div>';
    if (k.info.dataset.html !== html) {
      k.info.innerHTML = html;
      k.info.dataset.html = html;
    }
    k.root.classList.toggle('selling', !!sale);
    // A sale's clock: a bar along the card's top that shortens as time runs out (and grows back when a late bid extends it).
    let bar = k.root.querySelector<HTMLElement>(':scope > .sale-bar');
    if (sale && !bar) {
      bar = document.createElement('div');
      bar.className = 'sale-bar';
      k.root.append(bar);
    }
    if (bar) {
      if (!sale) bar.remove();
      else {
        const full = sale.opening ? session.game.cfg.auctions.openingClockSec : session.game.cfg.auctions.clockSec;
        bar.style.width = `${Math.max(0, Math.min(1, sale.timeLeft / full)) * 100}%`;
        bar.classList.toggle('late', sale.timeLeft <= 5);
      }
    }
    k.root.classList.toggle('yours', c.presidents.includes(obs.me) && !watching);
    // Open: pinned, or the opening round's company being sold (nothing else is happening then).
    k.root.classList.toggle('pinned', pinned || (sale?.opening === true && acting));
    // The broker box: always there once the market is open; in the opening round, only on the company being sold.
    const show = acting && (obs.phase === 'running' || (sale !== undefined && obs.sales[0]?.company === c.id));
    k.form.hidden = !show;
    if (!show) {
      k.key = '';
      return;
    }
    const cfg = session.cfg.auctions;
    const myBid = book.bid?.player === obs.me ? book.bid.price : 0;
    // During the company's sale, its bids are for the company's share, not yours.
    const otherBid = book.bid && book.bid.player !== obs.me && !sale ? book.bid.price : null;
    const otherAsk = book.ask && book.ask.player !== obs.me ? book.ask.price : null;
    const cb = obs.companyBid[c.id];
    // Buy now (at the standing ask) and sell now (to the best of a player's bid and the company's).
    k.quick.hidden = obs.phase !== 'running';
    // Buttons only for what you can do; otherwise a plain note of the price (or that there's none).
    const canBuy = otherAsk !== null && free >= otherAsk;
    const seller = book.ask && book.ask.player !== obs.me ? seatIcon(book.ask.player) : '';
    // Nobody selling: the space stays, blank.
    k.buyNow.innerHTML = otherAsk === null ? '' : `Buy <b>${money(otherAsk)}</b> <span class="from">${seller}</span>`;
    k.buyNow.classList.toggle('blank', otherAsk === null);
    k.buyNow.disabled = !canBuy;
    k.buyNow.classList.toggle('note', !canBuy);
    k.buyNow.title = otherAsk === null ? 'Nobody is selling a share right now' : !canBuy ? 'Not enough cash to buy it' : `Buy ${seatName(book.ask!.player)}'s share at once`;
    const toCompany = cb !== null && (otherBid === null || cb >= otherBid);
    const sellAt = toCompany ? cb : otherBid;
    k.sellNow.dataset.to = toCompany ? 'company' : 'bid';
    const canSell = sellAt !== null && mine > 0;
    // Only for your own shares: what someone would pay is no business of yours until you have one to sell.
    k.sellNow.classList.toggle('empty', mine === 0);
    const buyer = toCompany ? 'co.' : book.bid ? seatIcon(book.bid.player) : '';
    k.sellNow.innerHTML = sellAt === null ? '' : `Sell <b>${money(sellAt)}</b> <span class="from">${buyer}</span>`;
    k.sellNow.classList.toggle('blank', sellAt === null);
    k.sellNow.disabled = !canSell;
    k.sellNow.classList.toggle('note', !canSell);
    k.sellNow.title = sellAt === null ? 'Nobody is buying right now' : toCompany ? 'Sell one of your shares back to the company at once' : `Sell one of your shares to ${seatName(book.bid!.player)} at once`;
    // The slider runs from the least buy order that would stand to just below the standing ask
    // (or, with nobody selling, well above the company's worth per share).
    const low = leastBid(obs, c.id);
    const perShare = Math.ceil(obs.value[c.id] / c.shares.length);
    // With nobody selling, the slider goes as high as you could bid (all your spare cash), or for a sell
    // order, well above the company's value per share; with a standing sell order, to just below it.
    const high = Math.max(low, otherAsk !== null ? otherAsk - 1 : Math.max(Math.floor(free + myBid), Math.ceil(perShare * 1.5), low + 20));
    k.slider.min = String(low);
    k.slider.max = String(high);
    const key = sale ? `sale@${Math.round(obs.elapsed - sale.age)}` : 'market';
    let v = Math.round(Number(k.slider.value));
    // A fresh box starts halfway between the poles (a sale's starts at its minimum).
    if (key !== k.key) v = sale ? low : Math.round((low + high) / 2);
    k.key = key;
    v = Math.min(high, Math.max(low, v));
    if (Number(k.slider.value) !== v) k.slider.value = String(v);
    k.slider.disabled = low >= high;
    k.price.textContent = money(v);
    k.lo.textContent = money(low);
    k.lo.title = 'The least a buy order can be now';
    k.hi.textContent = money(high);
    k.hi.title = otherAsk !== null ? 'Just below the standing sell price' : 'Nobody is selling: as much as you have to bid with';
    // Place a buy order at that price (in a sale, that's your bid), or a sell order for one of your shares.
    k.placeBuy.textContent = myBid ? 'Raise buy' : sale ? 'Bid' : 'Place buy';
    k.placeBuy.disabled = v < low || (otherAsk !== null && v >= otherAsk) || v - myBid > free;
    k.placeBuy.title = v - myBid > free ? 'Not enough cash' : `Offer ${money(v)} for a share${sale ? ' in this offering' : ''}; it holds that cash until it's filled, beaten or withdrawn`;
    k.placeSell.textContent = book.ask?.player === obs.me ? 'Lower sell' : 'Place sell';
    k.placeSell.hidden = false;
    k.placeSell.dataset.mode = sale ? 'pass' : 'ask';
    const sellOk = mine > 0 && v > (otherBid ?? 0) && v > (cb ?? 0) && (otherAsk === null || v <= otherAsk - cfg.minRaise) && (book.ask?.player !== obs.me || v < book.ask.price);
    k.placeSell.disabled = !sellOk;
    k.placeSell.title = !mine ? "You don't own a share" : sellOk ? `Offer one of your shares for ${money(v)}` : 'At this price, sell now instead (or undercut the standing price)';
    if (sale) {
      // Pass: done bidding until someone bids again; once everyone but the highest bidder has, it ends.
      const passed = sale.passed.includes(obs.me);
      k.placeSell.textContent = passed ? 'Passed' : 'Pass';
      k.placeSell.disabled = passed || book.bid?.player === obs.me;
      k.placeSell.title = book.bid?.player === obs.me ? "You're the highest bidder" : 'Done bidding (until someone bids again). Once everyone but the highest bidder has passed, the offering ends at once.';
    }
  });
}

/** What a company's next truck costs, and whether it has room and money for it. */
function truckOffer(obs: Observation, id: number) {
  const g = session.game;
  const trucks = obs.trucks.filter((t) => t.company === id).length;
  const sites = Object.entries(obs.depots).filter(([, o]) => o === id).map(([site]) => Number(site));
  const limit = sites.length * g.cfg.depots.capacity;
  const price = g.cfg.depots.truckPrice + g.cfg.depots.truckPriceStep * trucks;
  return { trucks, limit, price, home: sites[0] as number | undefined, full: trucks >= limit, afford: obs.companies[id].treasury >= price };
}

/**
 * Tabs atop the cards: the trucks (buy one, on companies you run), then edit its delivery area
 * ("🛻 3/8 $12", green when it has the room and the money).
 */
function refreshCardTabs(obs: Observation, mine: number[]) {
  for (const [id, k] of cards) {
    let tabs = k.root.querySelector<HTMLElement>('.co-tabs');
    if (obs.phase !== 'running') {
      tabs?.remove();
      continue;
    }
    const own = mine.includes(id);
    if (!tabs) {
      tabs = document.createElement('div');
      tabs.className = 'co-tabs';
      tabs.innerHTML = '<button class="co-tab truck"></button><button class="co-tab area"></button>';
      const [truck, area] = [...tabs.children] as HTMLButtonElement[];
      // On press (the cards can re-render between press and release).
      area.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        if (hl.areaEdit?.company === id) endAreaEdit();
        else startAreaEdit(id);
      });
      truck.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !truck.classList.contains('can')) return;
        e.stopPropagation();
        const o = truckOffer(session.obs(), id);
        if (o.home === undefined) return;
        session.act({ type: 'buyTruck', company: id, depot: o.home });
        activeCompany = id;
      });
      k.root.prepend(tabs);
    }
    tabs.style.setProperty('--co', companyColor(id));
    const [truck, area] = [...tabs.children] as HTMLButtonElement[];
    // The area tab: only on companies you run.
    area.hidden = !own;
    const editing = hl.areaEdit?.company === id;
    const areaHtml = `${areaIcon(companyColor(id))}${editing ? 'Done' : '<span class="long">Delivery area</span><span class="short">Area</span>'}`;
    if (area.dataset.html !== areaHtml) (area.innerHTML = areaHtml), (area.dataset.html = areaHtml);
    area.classList.toggle('on', editing);
    area.title = editing ? 'Finish editing the delivery area' : 'Choose which blocks it delivers to';
    // The truck tab: on every card, its fleet (trucks/limit). On yours, the next truck's price too,
    // and the whole tab turns into a green button when it has the room and the money.
    const o = truckOffer(obs, id);
    const can = own && !o.full && o.afford && o.home !== undefined;
    const pill = !own ? '' : `<span class="px">${o.full ? 'Full' : money(o.price)}</span>`;
    const truckHtml = `${truckIcon(companyColor(id))}<span class="count">${o.trucks}/${o.limit}</span>${pill}`;
    if (truck.dataset.html !== truckHtml) (truck.innerHTML = truckHtml), (truck.dataset.html = truckHtml);
    truck.classList.toggle('own', own);
    truck.classList.toggle('can', can);
    truck.setAttribute('aria-disabled', String(!can));
    const cap = session.game.cfg.depots.capacity;
    truck.title = !own
      ? `${o.trucks} trucks, room for ${o.limit} (each factory adds ${cap})`
      : o.full
        ? `Fleet full: ${o.trucks}/${o.limit} trucks. Each factory adds ${cap}: click a free factory site on the map to buy one.`
        : !o.afford
          ? `Another truck costs ${money(o.price)}, and the treasury has ${money(obs.companies[id].treasury)} (${o.trucks}/${o.limit} trucks)`
          : `Buy another truck for ${money(o.price)} (${o.trucks}/${o.limit} trucks)`;
  }
}

/** The free factory site you clicked, with a buy button for each company you run. */
let sitePop: number | null = null;

function refreshSitePop(obs: Observation) {
  const pop = $('site-pop');
  const g = session.game;
  if (sitePop !== null && (obs.depots[sitePop] !== undefined || obs.phase !== 'running')) sitePop = null;
  if (sitePop === null) {
    pop.hidden = true;
    return;
  }
  const site = sitePop;
  const mine = myCompanies(obs);
  const dc = g.cfg.depots;
  let html = `<div class="title"><b>Factory site ${at(site)}</b><button data-popclose title="Close">✕</button></div>`;
  for (const c of mine) {
    const price = obs.depotPrices[site]?.[c] ?? dc.depotBase;
    const can = obs.companies[c].treasury >= price;
    html += `<button class="buy${can ? ' can' : ''}" data-popbuy="${c}" ${can ? '' : 'disabled'} title="${can ? `Buy it for ${coName(c)}` : `${coName(c)} has ${money(obs.companies[c].treasury)}`}"><span class="sw" style="background:${companyColor(c)}"></span>${coName(c)}<span class="px">${money(price)}</span></button>`;
  }
  html += `<div class="note">Each factory adds ${dc.capacity} to the truck limit. Serving the gold zone round it cuts the price (up to ${Math.round(100 * dc.maxSubsidy)}% off).</div>`;
  if (pop.dataset.html !== html) (pop.innerHTML = html), (pop.dataset.html = html);
  pop.hidden = false;
  // Just above the site (below it, near the top of the map), kept on the map.
  const l = g.town.locations[site];
  const wrap = $('map-wrap').getBoundingClientRect();
  const box = canvas.getBoundingClientRect();
  const sx = box.left - wrap.left + renderer.X(l.x);
  const sy = box.top - wrap.top + renderer.Y(l.y);
  const gap = renderer.scale * 0.6;
  let y = sy - gap - pop.offsetHeight;
  if (y < 8) y = sy + gap;
  const x = Math.max(8, Math.min(wrap.width - pop.offsetWidth - 8, sx - pop.offsetWidth / 2));
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}

$('site-pop').addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b || e.button !== 0) return;
  e.stopPropagation();
  if (b.dataset.popclose !== undefined) sitePop = null;
  else if (b.dataset.popbuy && sitePop !== null && !b.hasAttribute('disabled')) {
    const c = Number(b.dataset.popbuy);
    session.act({ type: 'buyDepot', company: c, site: sitePop });
    activeCompany = c;
    sitePop = null;
  }
  refreshSitePop(session.obs());
});

function refreshMyCompanies(obs: Observation) {
  const g = session.game;
  const mine = myCompanies(obs);
  if (obs.phase === 'running') runningSince ??= obs.t;
  refreshCardTabs(obs, mine);
  refreshSitePop(obs);
  const box = $('mycos');
  let html = '';
  if (!mine.length) html = '<div class="muted small">You aren’t president of any company. Own the most shares of one to run it.</div>';
  for (const id of mine) {
    const c = obs.companies[id];
    const trucks = obs.trucks.filter((t) => t.company === id);
    const free = freeTrucks(obs, id);
    const factorySites = Object.entries(obs.depots).filter(([, o]) => o === id).map(([site]) => Number(site));
    const limit = factorySites.length * g.cfg.depots.capacity;
    const rate = obs.phase === 'running' ? companyRate(id, obs.t) : null;
    const routes = obs.routes
      .filter((r) => r.company === id)
      .sort((a, b) => g.town.locations[a.producer].good! - g.town.locations[b.producer].good! || a.key.localeCompare(b.key));
    // Header: name and ticker, and its treasury in a box (as on its card).
    html += `<div class="co${currentCompany(obs) === id ? ' active' : ''}" data-company="${id}" data-cohover="${id}">`;
    html += `<div class="row head"><span>${sw(id)}<b>${coName(id)}</b> <span class="ticker">${COMPANY_NAMES[companySlot(id)][1]}</span></span><span class="treasury-box" title="The treasury: what it has to spend on trucks and factories"><span class="lbl">Treasury</span> <b>${money(c.treasury)}</b></span></div>`;
    // At a glance: trucks, factories, and what its deliveries are earning.
    html += `<div class="row small quick-stats"><span title="${trucks.length} trucks (${free} free), room for ${limit}: each factory adds ${g.cfg.depots.capacity}">🚚 <b>${trucks.length}</b>/${limit}</span><span title="Factories: ${factorySites.map(at).join(', ')}">🏭 <b>${factorySites.length}</b></span><span title="What its deliveries earned per minute over the last ${RATE_WINDOW / 60} minutes (half to the treasury, half to dividends)"><span class="muted">Income</span> ${!trucks.length ? '<span class="muted">—</span>' : rate === null ? '<span class="muted">earning…</span>' : `<b>${money(rate)}</b>/min`}</span></div>`;
    // Spending: a truck, or a factory (the nearest free sites, at its price).
    const full = trucks.length >= limit;
    const nextTruck = g.cfg.depots.truckPrice + g.cfg.depots.truckPriceStep * trucks.length;
    const home = factorySites[0];
    const truckBtn = home === undefined ? '' : `<button data-truck="${id}:${home}" ${full || c.treasury < nextTruck ? 'disabled' : ''} title="${full ? `Fleet full: each factory adds ${g.cfg.depots.capacity}` : c.treasury < nextTruck ? 'Not enough in the treasury' : 'Another truck: more deliveries'}">Buy truck <b>${money(nextTruck)}</b></button>`;
    const sites = Object.keys(obs.depotPrices).map(Number);
    const factoryBtn = sites.length ? `<button data-depot="${id}" class="${hl.buyFor === id ? 'on' : ''}" title="Pick a free factory site on the map (the ones you can afford light up with your price)">${hl.buyFor === id ? 'Cancel' : 'Buy factory…'}</button>` : '';
    html += `<div class="row spend">${truckBtn}${factoryBtn}</div>`;
    if (sites.length && (hl.buyFor === id || full)) {
      const own = factorySites.map((site) => g.town.locations[site].node);
      const dist = (site: number) => Math.min(...own.map((n) => siteReach(site)[n]));
      const near = sites.sort((a, b) => dist(a) - dist(b)).slice(0, 3);
      html += `<div class="sites"><span class="muted small">Nearest:</span>${near.map((site) => {
        const price = obs.depotPrices[site][id];
        return `<button data-buysite="${id}:${site}" ${c.treasury < price ? 'disabled' : ''} title="${Math.round(dist(site))} blocks away${price < g.cfg.depots.depotBase ? ', local subsidy' : ''}">${at(site)} ${money(price)}</button>`;
      }).join('')}</div>`;
    }
    // Where it delivers: its area (or anywhere), and what it's focusing on.
    const editing = hl.areaEdit?.company === id;
    const blocks = c.area.length;
    html += `<div class="row small"><span>Delivers to <b>${blocks ? `${blocks} block${blocks === 1 ? '' : 's'}` : 'anywhere'}</b></span><button data-area="${id}" class="${editing ? 'on' : ''}">${editing ? 'Done' : 'Edit area'}</button></div>`;
    if (c.focus.length)
      html += `<div class="row small focus-row"><span class="muted">Focus</span><span>${c.focus.map((f) => `<button data-unfocus="${id}:${f}" title="Stop focusing on it">${at(f)} ${names(g.town.locations[f].good!).product} ✕</button>`).join('')}</span></div>`;
    // Its routes (it picks them itself): folded to a summary until you open them.
    // Start each route's clock when it appears, folded or not, so its rate is ready when opened.
    for (const r of routes) if (!routeLog.has(r.key)) routeLog.set(r.key, { since: obs.t, hits: [] });
    if (routes.length) {
      const open = routesOpen.get(id) ?? false;
      const total = routes.reduce((n, r) => n + r.trucks, 0);
      html += `<button class="sub fold" data-fold="${id}">${open ? '▾' : '▸'} Routes · ${routes.length} · ${total} truck${total === 1 ? '' : 's'}${rate === null ? '' : ` · ${money(rate)}/min`}</button>`;
      if (open)
        for (const r of routes) {
          const p = g.town.locations[r.producer];
          html += `<div class="row small route-row${hl.hoverRoute === r.key ? ' hot' : ''}${hl.saturated.has(r.key) ? ' saturated' : ''}" data-routerow="${r.key}"><span><span class="dot" style="background:${goodColor(p.good!)}"></span>${cap(names(p.good!).product)} ${at(r.producer)} → ${at(r.depot)} → ${at(r.consumer)}<span class="rate" title="What this route earned per minute over the last ${RATE_WINDOW / 60} minutes">${routeRate(r.key, obs.t, r.trucks)}</span>${saturatedNote(r.key, p.good!)}</span><span class="route-ctl">${r.trucks} 🚚</span></div>`;
        }
    } else if (obs.phase === 'running') html += `<div class="row small muted"><span>${trucks.length ? 'No routes yet: its trucks pick some within a second or two.' : 'No trucks yet: buy one to start delivering.'}</span></div>`;
    html += '</div>';
  }
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
}

/** Which companies' route lists you've opened (folded until you do). */
const routesOpen = new Map<number, boolean>();

// Panel buttons (delegated, since the panels re-render). They act on press rather than click:
// a panel can re-render between press and release, which would swallow a click.
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.side button');
  if (!b || b.disabled) return;
  const obs = session.obs();
  if (b.dataset.icon) {
    session.act({ type: 'setIcon', icon: Number(b.dataset.icon) });
  } else if (b.dataset.pin) {
    const id = Number(b.dataset.pin);
    if (pinnedCards.has(id)) pinnedCards.delete(id);
    else pinnedCards.add(id);
  } else if (b.dataset.startsale) {
    session.act({ type: 'startSale', company: Number(b.dataset.startsale) });
  } else if (b.dataset.sell) {
    const [c, to] = b.dataset.sell.split(':');
    session.act({ type: 'sell', company: Number(c), to: to as 'bid' | 'company' });
  } else if (b.dataset.buy) {
    session.act({ type: 'buy', company: Number(b.dataset.buy) });
  } else if (b.dataset.cancel) {
    const [c, side] = b.dataset.cancel.split(':');
    session.act({ type: 'cancelOrder', company: Number(c), side: side as 'bid' | 'ask' });
  } else if (b.dataset.truck) {
    const [c, s] = b.dataset.truck.split(':').map(Number);
    session.act({ type: 'buyTruck', company: c, depot: s });
    activeCompany = c;
  } else if (b.dataset.buysite) {
    const [c, site] = b.dataset.buysite.split(':').map(Number);
    session.act({ type: 'buyDepot', company: c, site });
    activeCompany = c;
    hl.buyFor = null;
  } else if (b.dataset.depot) {
    const c = Number(b.dataset.depot);
    hl.buyFor = hl.buyFor === c ? null : c;
    activeCompany = c;
  } else if (b.dataset.fold) {
    const c = Number(b.dataset.fold);
    routesOpen.set(c, !(routesOpen.get(c) ?? false));
  } else if (b.dataset.area) {
    const c = Number(b.dataset.area);
    if (hl.areaEdit?.company === c) endAreaEdit();
    else startAreaEdit(c);
  } else if (b.dataset.unfocus) {
    const [c, l] = b.dataset.unfocus.split(':').map(Number);
    session.act({ type: 'setFocus', company: c, location: l, on: false });
  }
  refreshPanels(session.obs());
});
document.addEventListener('click', (e) => {
  const co = (e.target as HTMLElement).closest<HTMLElement>('#mycos .co');
  if (co && !(e.target as HTMLElement).closest('button')) activeCompany = Number(co.dataset.company);
});

// ------------------------------------------------------------------ log

/**
 * Payday: a banner over the map with what you were paid, company by company, a "+$" that floats up
 * from your cash, and the cash itself flashing. Dividends are the big moment of each 3 minutes.
 */
function showPayout(paid: { company: number; amount: number; final: boolean }[]) {
  const total = paid.reduce((a, p) => a + p.amount, 0);
  const banner = $('payout');
  const final = paid.some((p) => p.final);
  banner.innerHTML = total
    ? `<div class="pay-title">${final ? 'Final dividends!' : 'Payday!'}</div><div class="pay-total">+${money(total)}</div><div class="pay-rows">${paid
        .sort((a, b) => b.amount - a.amount)
        .map((p) => `<span>${sw(p.company)}${coName(p.company)} ${money(p.amount)}</span>`)
        .join('')}</div>`
    : `<div class="pay-title">Dividends paid</div><div class="pay-rows"><span>${watching ? `${seatIcon(0)} holds` : 'You hold'} no shares that paid this time.</span></div>`;
  banner.innerHTML += '<div class="pay-close">click to close</div>';
  banner.classList.remove('show');
  void banner.offsetWidth; // restart the animation
  banner.classList.add('show');
  banner.onclick = () => banner.classList.remove('show');
  // Once it has faded out, it mustn't catch clicks meant for the map.
  banner.onanimationend = () => banner.classList.remove('show');
  if (!total) return;
  const me = $('me');
  me.classList.remove('paid');
  void me.offsetWidth;
  me.classList.add('paid');
  const plus = document.createElement('div');
  plus.className = 'pay-float';
  plus.textContent = `+${money(total)}`;
  me.appendChild(plus);
  setTimeout(() => plus.remove(), 1800);
}

/**
 * Saturation: how much of the last minute each of your routes' trucks spent queued (waiting for a
 * load at the producer, for the shop to want more, or for a turn at the bay), sampled twice a
 * second of game time. A route whose trucks wait more than SATURATED of the time has more trucks
 * than it can use.
 */
const waitLog = new Map<string, { t: number; n: number; atProducer: number; atShop: number }[]>();
const SATURATED = 0.2;
let lastWaitSample = -1;

function sampleWaiting(obs: Observation) {
  if (obs.phase !== 'running' || obs.t - lastWaitSample < 0.5) return;
  lastWaitSample = obs.t;
  const mine = new Set(myCompanies(obs));
  const where = new Map<number, number>();
  for (const [loc, ids] of Object.entries(obs.queues)) for (const id of ids) where.set(id, Number(loc));
  const now = new Map<string, { n: number; atProducer: number; atShop: number }>();
  for (const t of obs.trucks) {
    if (!t.route || !mine.has(t.company)) continue;
    const x = now.get(t.route) ?? { n: 0, atProducer: 0, atShop: 0 };
    x.n++;
    if (t.state === 'queued') {
      const l = where.get(t.id);
      if (l !== undefined && session.game.town.locations[l].kind === 'producer') x.atProducer++;
      else if (l !== undefined && session.game.town.locations[l].kind === 'consumer') x.atShop++;
    }
    now.set(t.route, x);
  }
  for (const [key, x] of now) {
    const log = waitLog.get(key) ?? [];
    log.push({ t: obs.t, ...x });
    while (log.length && log[0].t < obs.t - 60) log.shift();
    waitLog.set(key, log);
  }
  for (const key of [...waitLog.keys()]) if (!now.has(key)) waitLog.delete(key);
  hl.saturated = new Set([...waitLog.keys()].filter((k) => waiting(k)?.saturated));
}

/** A route's waiting over the last minute (null until it has 20 seconds of samples). */
function waiting(key: string): { share: number; saturated: boolean; where: 'producer' | 'shop' } | null {
  const log = waitLog.get(key);
  if (!log || log.length < 40) return null;
  const n = log.reduce((a, x) => a + x.n, 0);
  const p = log.reduce((a, x) => a + x.atProducer, 0);
  const c = log.reduce((a, x) => a + x.atShop, 0);
  const share = n ? (p + c) / n : 0;
  return { share, saturated: share > SATURATED, where: p >= c ? 'producer' : 'shop' };
}

/**
 * The game's story for the end-of-game charts: every 10 seconds of play, each player's cash and
 * each company's value (treasury plus what it paid for trucks and factories), total earnings, and
 * earnings over the last minute.
 */
const history: { t: number; cash: number[]; value: number[]; earned: number[]; perMin: number[] }[] = [];
/** Delivery income so far, by company. */
const earned = new Map<number, number>();
let lastHistory = -Infinity;

function sampleHistory(obs: Observation) {
  if (obs.phase === 'opening' || obs.t - lastHistory < 10) return;
  lastHistory = obs.t;
  const total = obs.companies.map((c) => earned.get(c.id) ?? 0);
  const minuteAgo = [...history].reverse().find((h) => h.t <= obs.t - 60);
  history.push({
    t: obs.t,
    cash: obs.players.map((p) => p.cash),
    value: obs.companies.map((c) => c.treasury + c.assets),
    earned: total,
    perMin: total.map((x, i) => (minuteAgo ? (x - minuteAgo.earned[i]) * (60 / (obs.t - minuteAgo.t)) : history.length ? x * (60 / obs.t) : 0)),
  });
}

/** A simple line chart: one line per series, time along the bottom. */
function drawChart(cv: HTMLCanvasElement, series: { label: string; color: string; points: [number, number][] }[], fmt: (v: number) => string) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const pad = { l: 46, r: 22, t: 10, b: 24 };
  const all = series.flatMap((s) => s.points);
  if (!all.length) return;
  const tMax = Math.max(...all.map((p) => p[0]), 1);
  const vMax = Math.max(1, ...all.map((p) => p[1])) * 1.08;
  const X = (t: number) => pad.l + (t / tMax) * (W - pad.l - pad.r);
  const Y = (v: number) => H - pad.b - (v / vMax) * (H - pad.t - pad.b);
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#7d766b';
  ctx.strokeStyle = '#e2dccf';
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = (vMax / 4) * k;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(v));
    ctx.lineTo(W - pad.r, Y(v));
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmt(v), pad.l - 6, Y(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let m = 0; m <= tMax / 60; m += tMax > 900 ? 5 : 3) ctx.fillText(`${m}:00`, X(m * 60), H - pad.b + 6);
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach(([t, v], k) => (k ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    ctx.stroke();
  }
}

/** What kind of business a location is (or was, if it just closed and the lot no longer says). */
function bizName(id: number): string {
  const k = knownBusiness.get(id);
  if (!k) return 'business';
  return k.kind === 'producer' ? names(k.good).source : names(k.good).shop;
}
/** Each business's kind and good as last seen (a closed one is gone from the view by the time its event is read). */
const knownBusiness = new Map<number, { kind: 'producer' | 'consumer'; good: number }>();

/** What each company's last payout paid per share. */
const lastDividend = new Map<number, number>();

/** Deliveries per route (time, price), for its earnings per minute. */
const routeLog = new Map<string, { since: number; hits: { t: number; price: number }[] }>();
/** Each company's deliveries, for its income rate. */
const companyLog = new Map<number, { since: number; hits: { t: number; price: number }[] }>();

/** When this game started running (deliveries can't come before). */
let runningSince: number | null = null;

/** What a company's deliveries earned per minute lately (null until there's a minute to go on). */
function companyRate(company: number, now: number): number | null {
  if (runningSince === null) return null;
  const log = companyLog.get(company) ?? { since: now, hits: [] };
  companyLog.set(company, log);
  log.hits = log.hits.filter((h) => h.t > now - RATE_WINDOW);
  const span = Math.min(RATE_WINDOW, now - runningSince);
  return span < 60 ? null : (log.hits.reduce((a, h) => a + h.price, 0) * 60) / span;
}
/** Seconds of history a route's earnings rate is taken over. */
const RATE_WINDOW = 120;

/** A route's earnings per minute over the last RATE_WINDOW seconds (or since it started, once it's had a minute). */
function routeRate(key: string, now: number, trucks: number): string {
  let log = routeLog.get(key);
  if (!log) {
    log = { since: now, hits: [] };
    routeLog.set(key, log);
  }
  log.hits = log.hits.filter((h) => h.t > now - RATE_WINDOW);
  const span = Math.min(RATE_WINDOW, now - log.since);
  if (span < 60) return 'earning… (give it a minute)';
  const perMin = (log.hits.reduce((a, h) => a + h.price, 0) * 60) / span;
  const each = trucks ? perMin / trucks : 0;
  return `$${perMin.toFixed(1)}/min · $${each.toFixed(1)} per truck`;
}

/** The line under a saturated route's row: where its trucks are waiting, and what to do about it. */
function saturatedNote(key: string, good: number): string {
  const w = waiting(key);
  if (!w || !w.saturated) return '';
  const n = names(good);
  const where = w.where === 'producer' ? `at the ${n.source}: it can't make ${n.raw} fast enough` : `at the ${n.shop}: it doesn't want more ${n.product} yet`;
  // Short in the card; the whole story when you hover over it.
  return `<span class="wait" title="Trucks waiting ${where}. They spent ${Math.round(100 * w.share)}% of the last minute waiting, so another truck won't help: take one off, or put it on another route.">⏳ Too many trucks</span>`;
}

const logList = document.createElement('ol');

function handleEvents(evs: GameEvent[]) {
  const obs = session.obs();
  const g = session.game;
  const mine = new Set(myCompanies(obs));
  // The log panel is gone; entries still go to an offscreen list (handy for debugging).
  const ol = logList;
  const truckRoute = new Map(obs.trucks.map((t) => [t.id, t.route]));
  const paidNow: { company: number; amount: number; final: boolean }[] = [];
  let payoutSeen = false;
  for (const e of evs) {
    if (e.type === 'delivered') {
      earned.set(e.company, (earned.get(e.company) ?? 0) + e.price);
      const clog = companyLog.get(e.company) ?? { since: e.t, hits: [] };
      clog.hits.push({ t: e.t, price: e.price });
      companyLog.set(e.company, clog);
      const key = truckRoute.get(e.truck);
      if (key) {
        const log = routeLog.get(key) ?? { since: e.t, hits: [] };
        log.hits.push({ t: e.t, price: e.price });
        routeLog.set(key, log);
      }
    }
    let text: string | null = null;
    let cls = '';
    // A pickup or delivery by any company: blink its arc on the free sites whose zone it's in.
    if (e.type === 'loaded' || e.type === 'delivered') {
      const node = g.town.locations[e.location].node;
      for (const site of Object.keys(obs.depotPrices).map(Number))
        if (siteReach(site)[node] <= g.cfg.depots.districtBlocks) {
          const m = hl.flash.get(site) ?? new Map<number, number>();
          m.set(e.company, e.t);
          hl.flash.set(site, m);
        }
    }
    if (e.type === 'rejected') {
      if (!watching) toast(cap(e.reason) + '.', 'error'); // a watched bot's mistakes aren't yours
      continue;
    }
    if (e.type === 'payout') {
      payoutSeen = true;
      lastDividend.set(e.company, e.perShare + e.bonusPerShare);
      if (e.paid[session.seat]) paidNow.push({ company: e.company, amount: e.paid[session.seat], final: !!e.final });
    }
    if (e.type === 'orderCancelled' && e.player === session.seat && e.reason === 'beaten' && !watching) toast(`Your ${e.side} for ${coName(e.company)} was ${e.side === 'bid' ? 'outbid' : 'undercut'}.`, 'error');
    if (e.type === 'saleWon') text = `${cap(playerName(e.player, obs.me))} bought a share of ${coName(e.company)} for ${money(e.amount)}`;
    else if (e.type === 'trade')
      text =
        e.buyer === 'company'
          ? `${cap(playerName(e.seller, obs.me))} sold a share of ${coName(e.company)} back to it for ${money(e.price)}`
          : `${cap(playerName(e.buyer, obs.me))} bought a share of ${coName(e.company)} from ${playerName(e.seller, obs.me)} for ${money(e.price)}`;
    else if (e.type === 'askPosted' && e.player === obs.me && !watching) text = `${cap(playerName(e.player, obs.me))} ${e.player === obs.me && !watching ? 'offer' : 'offers'} a share of ${coName(e.company)} for ${money(e.price)}`;
    else if (e.type === 'payout' && e.paid[session.seat]) {
      text = `Dividend from ${coName(e.company)}: ${money(e.paid[session.seat])}${e.final ? ' (final)' : ''}`;
      cls = 'good';
    } else if (e.type === 'opened') text = `[${at(e.location)}] A ${e.kind === 'producer' ? names(e.good).source : names(e.good).shop} opened`;
    else if (e.type === 'closed') {
      text = `[${at(e.location)}] A ${bizName(e.location)} closed`;
      cls = 'bad';
    } else if (e.type === 'closing') {
      text = `[${at(e.location)}] A ${bizName(e.location)} is about to close: serve it to save it`;
      cls = 'bad';
    } else if (e.type === 'siteOpened') {
      text = `[${at(e.site)}] A new factory site is up for grabs`;
      const site = g.town.locations[e.site];
      renderer.puff(site.x, site.y);
    } else if (e.type === 'boughtDepot') {
      text = `[${at(e.site)}] ${coName(e.company)} bought a factory for ${money(e.price)}`;
      const site = g.town.locations[e.site];
      renderer.puff(site.x, site.y);
    }
    else if (e.type === 'end') text = 'Game over';
    if (!text) continue;
    const li = document.createElement('li');
    li.textContent = `${obs.phase === 'opening' ? '' : `${fmtClock(g.cfg.durationSec - e.t)} `}${text}`;
    if (cls) li.className = cls;
    ol.prepend(li);
  }
  while (ol.children.length > 120) ol.lastChild!.remove();
  if (payoutSeen) showPayout(paidNow);
}

// ------------------------------------------------------------------ end screen

let shownEnd = false;
function endScreen(obs: Observation) {
  if (obs.phase !== 'ended' || shownEnd) return;
  shownEnd = true;
  const ranking = [...obs.players].sort((a, b) => b.cash - a.cash);
  const rows = ranking
    .map((p, i) => `<tr class="${p.id === obs.me && !watching ? 'me' : ''}"><td>${i + 1}</td><td>${p.id === obs.me && !watching ? 'You' : seatName(p.id)}</td><td>${money(p.cash)}</td></tr>`)
    .join('');
  const place = ranking.findIndex((p) => p.id === obs.me) + 1;
  const ov = $('overlay');
  const title = watching ? `${seatName(ranking[0].id)} wins!` : place === 1 ? 'You win!' : `You finished ${ordinal(place)}`;
  // The final sample, so the charts run to the end.
  lastHistory = -Infinity;
  sampleHistory({ ...obs, phase: 'running' } as Observation);
  const tabs: [string, string][] = [['cash', 'Players: cash'], ['value', 'Companies: value'], ['earned', 'Companies: total earned'], ['perMin', 'Companies: earnings per minute']];
  ov.innerHTML = `<div class="card end"><h1>${title}</h1><table>${rows}</table>
    <div class="chart-tabs">${tabs.map(([k, l], i) => `<button data-chart="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>
    <canvas id="end-chart"></canvas><div class="chart-legend" id="end-legend"></div>
    <button id="btn-again">Play${watching ? '' : ' again'}</button>${watching ? ' <button id="btn-watch-again">Watch another</button>' : ''}</div>`;
  ov.hidden = false;
  const show = (key: string) => {
    ov.querySelectorAll<HTMLElement>('[data-chart]').forEach((b) => b.classList.toggle('on', b.dataset.chart === key));
    const players = key === 'cash';
    const n = players ? obs.players.length : obs.companies.length;
    const series = Array.from({ length: n }, (_, i) => ({
      label: players ? (i === obs.me && !watching ? 'You' : seatName(i)) : `${coTicker(i)} · ${coName(i)}`,
      color: players ? ['#23201b', '#8a8273', '#c9a24a', '#5f86a8'][i % 4] : companyColor(i),
      points: history.map((h) => [h.t, (h as unknown as Record<string, number[]>)[key][i]] as [number, number]),
    }));
    drawChart($<HTMLCanvasElement>('end-chart'), series, (v) => (key === 'perMin' ? `$${v.toFixed(0)}/m` : `$${Math.round(v)}`));
    $('end-legend').innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
  };
  ov.querySelectorAll<HTMLElement>('[data-chart]').forEach((b) => (b.onclick = () => show(b.dataset.chart!)));
  show('cash');
  $('btn-again').onclick = () => newGame();
  ov.querySelector<HTMLElement>('#btn-watch-again')?.addEventListener('click', () => newGame(true));
}
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;

/**
 * How to play: a short walkthrough. Each page has pictures from the game (`img`, in public/guide)
 * and/or a row of building icons drawn like the map draws them (`icons`), then what to do.
 */
type GuideIcons = 'producers' | 'shops' | 'chain';
const GUIDE: { img?: string[]; icons?: GuideIcons; flow?: boolean; title: string; text: string }[] = [
  {
    img: ['overview'],
    flow: true,
    title: 'Welcome to Signature Required!',
    text: `<p>You're an <b>investor</b> in a busy little town's trucking companies. After 15 minutes, the <span class="hl">richest player wins</span>.</p>
      <p>The next pages show you how to take control of a company, choose where it delivers, buy factories, raise money and get paid.</p>
      <p class="muted small">Or <a href="#" id="watch-bots">just watch the bots play</a> for a while.</p>`,
  },
  {
    img: ['auction'],
    title: 'Take control of a company!',
    text: `<p>The game opens with a <b>sale</b> of one share of each company: <span class="hl">bid in its card</span> along the bottom, and the highest bid gets it. Whoever holds the most shares of a company <span class="hl">controls it</span>: they're its president and run its trucks. A tie keeps the president in charge, so to take a company over, hold more shares than its president. Its share boxes show the line of succession, president first. You're an investor, not the company, so spread your bets across several if you like.</p>
      <p>Your bid goes <b>straight into the company</b>. That's how companies pay for trucks and factories, so a share won for next to nothing leaves your company with nothing to build with. Bid like you mean it!</p>`,
  },
  {
    img: ['routes'],
    icons: 'chain',
    title: 'Your trucks run themselves!',
    text: "<p>A company <b>routes its own trucks</b>. Each picks up raw material at a <b>producer</b>, has it made into the product at one of the company's <b>factories</b>, and delivers it to a <b>shop</b>: <span class=\"hl\">timber → furniture, wheat → bread, crude oil → fuel</span>. Shorter trips and better-paying shops come first. Shops with a gold <b>$</b> coin pay 50% more.</p><p><span class=\"hl\">Every delivery earns money</span>, so as president, <b>buy trucks</b> (in your company's panel) to make more of them. The number on a route is how many trucks run it.</p>",
  },
  {
    img: ['area'],
    title: 'Choose where it delivers!',
    text: `<p>In your company's panel, <b>Edit area</b> sets its <b>delivery area</b>: the shops it serves. <span class="hl">Click or drag over blocks</span> to add them, and right-click or right-drag to take them out. It still fetches from producers anywhere. With no area, it delivers anywhere.</p><p><b>Double-click</b> a producer or shop while editing to <span class="hl">focus</span> on it (up to ${session.cfg.maxFocus}): trucks go there first, even outside the area. Handy for moving in on a rival's best shop.</p>`,
  },
  {
    img: ['factory'],
    title: 'Unclaimed factories!',
    text: `<p>The white factories are <b>unclaimed</b>: any company can buy one, at full price $${session.cfg.depots.depotBase}. But a company that <span class="hl">serves the producers and shops nearby</span> gets a discount, up to ${Math.round(100 * session.cfg.depots.maxSubsidy)}% off.</p><p>Hover over a site, or over a company card, to see how close each company is. A <b>★</b> means the full discount.${session.cfg.depots.newSiteEverySec > 0 ? ' New sites turn up every few minutes in the parts of town no factory reaches.' : ''}</p>`,
  },
  {
    img: ['buy'],
    title: 'Buy another factory!',
    text: `<p>Each factory lets your company run <b>${session.cfg.depots.capacity} more trucks</b>. When your company is at its truck limit, or you want to move into another part of town, buy one: <b>click a free factory site</b> on the map, and buy it at your company's price. Its trucks <span class="hl">start work from there</span> too. Serving the gold zone round a site makes it cheaper.</p>`,
  },
  {
    img: ['sale'],
    title: 'Raise money with a share offering!',
    text: `<p>A company's <b>empty share boxes</b> are shares it still owns. Anyone can offer one: hover its card and click <b>Offer a share</b>. Everyone then has <span class="hl">${session.cfg.auctions.clockSec} seconds to bid</span> in the card, or <b>Pass</b>. A late bid adds a few seconds, up to ${session.cfg.auctions.maxSec} seconds in all.</p><p>The highest bid gets the share, if it's at least the company's price, and <span class="hl">the money goes to the company</span> to spend on trucks and factories. It's also how you buy into a company you don't run.</p>`,
  },
  {
    img: ['shares', 'company'],
    title: 'Get paid!',
    text: "<p>Half of each delivery goes to the company and half to its <b>dividend pot</b>, which is <span class=\"hl\">paid to shareholders every 3 minutes</span>. Your shares and your next payout show at the top right.</p><p>Shares trade in the <b>company cards</b>: <b>Sell</b> and <b>Buy</b> trade at once, and hovering a card lets you place your own price. Late on, a company with cash <span class=\"hl\">buys shares back</span>. After 15 minutes, the richest player wins. Good luck!</p>",
  },
];

/**
 * How the game works, as a little diagram for the welcome page: buy shares, grow companies, then
 * earn dividends and sell higher (both from the company's growth). Drawn here, so it stays sharp.
 */
function guideFlow(): string {
  const you = '#fbe9a9';
  const co = '#d9ecd9';
  const node = (x: number, y: number, icon: string, fill: string, title: string, sub: string) =>
    `<circle cx="${x}" cy="${y}" r="21" fill="${fill}" stroke="#23201b" stroke-width="2"/><text x="${x}" y="${y + 7}" text-anchor="middle" font-size="20">${icon}</text>` +
    `<text class="ft" x="${x}" y="${y + 39}" text-anchor="middle">${title}</text><text class="fs" x="${x}" y="${y + 52}" text-anchor="middle">${sub}</text>`;
  const arrow = 'stroke="#8a8273" stroke-width="2" fill="none" marker-end="url(#flow-h)"';
  return `<svg class="guide-flow" viewBox="0 0 250 292" role="img" aria-label="Buy shares, grow companies, then earn dividends and sell higher">
    <defs><marker id="flow-h" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8a8273"/></marker></defs>
    ${node(125, 24, '💵', you, 'Buy shares', 'your money funds it')}
    <line x1="125" y1="84" x2="125" y2="104" ${arrow}/>
    ${node(125, 130, '🏭', co, 'Grow companies', 'trucks deliver goods')}
    <path d="M108,190 C94,198 74,200 64,210" ${arrow}/>
    <path d="M142,190 C156,198 176,200 186,210" ${arrow}/>
    ${node(62, 234, '💰', you, 'Earn dividends', 'every 3 minutes')}
    ${node(188, 234, '📈', you, 'Sell higher', 'shares worth more')}
  </svg>`;
}

/** A row of building icons for a walkthrough page. */
function guideIcons(kind: GuideIcons): string {
  const goods = session.cfg.town.goods.map((_, g) => g);
  const icon = (k: 'producer' | 'consumer' | 'factory', g = 0, label = '') =>
    `<figure><canvas class="gicon" data-k="${k}" data-g="${g}"></canvas>${label ? `<figcaption>${label}</figcaption>` : ''}</figure>`;
  if (kind === 'producers') return `<div class="gicons">${goods.map((g) => icon('producer', g, cap(names(g).source))).join('')}</div>`;
  if (kind === 'shops') return `<div class="gicons">${goods.map((g) => icon('consumer', g, cap(names(g).shop))).join('')}</div>`;
  const col = (k: 'producer' | 'consumer') => `<div class="gcol">${goods.map((g) => icon(k, g)).join('')}</div>`;
  return `<div class="gchain">${col('producer')}<span class="garrow">→</span>${icon('factory', 0, 'Factory')}<span class="garrow">→</span>${col('consumer')}</div>`;
}

/** Draw the icon canvases in the help card, the way the map draws those buildings. */
function paintGuideIcons(root: HTMLElement) {
  const dpr = window.devicePixelRatio || 1;
  root.querySelectorAll<HTMLCanvasElement>('canvas.gicon').forEach((cv) => {
    const size = cv.dataset.k === 'factory' ? 64 : 50;
    cv.width = size * dpr;
    cv.height = size * dpr;
    cv.style.width = `${size}px`;
    cv.style.height = `${size}px`;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const k = cv.dataset.k!;
    if (k === 'factory') drawFactory(ctx, size / 2, size / 2, size * 0.38, companyColor(0));
    else drawBusiness(ctx, k as 'producer' | 'consumer', Number(cv.dataset.g), size / 2, size / 2 + 2, size * 0.34);
  });
}

function showHelp(step = 0) {
  const ov = $('overlay');
  const base = import.meta.env.BASE_URL;
  const st = GUIDE[step];
  const last = step === GUIDE.length - 1;
  // A page with the how-it-works diagram: picture and words on the left, the diagram down the right.
  const body = `${st.img ? `<div class="guide-imgs">${st.img.map((i) => `<img src="${base}guide/${i}.webp" alt="">`).join('')}</div>` : ''}
    ${st.icons ? guideIcons(st.icons) : ''}
    <h2>${step > 0 ? `${step}. ` : ''}${st.title}</h2>${st.text}`;
  ov.innerHTML = `<div class="card help wide${st.flow ? ' with-flow' : ''}"><div class="guide-step">
    ${st.flow ? `<div class="flow-cols"><div class="flow-left">${body}</div><div class="flow-right">${guideFlow()}</div></div>` : body}
    <div class="guide-nav"><button data-step="${step - 1}" ${step === 0 ? 'disabled' : ''}>← Back</button><span class="dots">${GUIDE.map((_, k) => `<span class="${k === step ? 'on' : ''}" data-step="${k}"></span>`).join('')}</span>${last ? '<button id="btn-close" class="go">Start playing</button>' : `<button data-step="${step + 1}" class="go">Next →</button>`}</div>
    ${last ? '' : '<button id="btn-skip" class="link">Skip</button>'}</div></div>`;
  ov.hidden = false;
  paintGuideIcons(ov);
  const wasPaused = helpWasPaused ?? session.paused;
  helpWasPaused = wasPaused;
  if (!session.multiplayer) session.paused = true; // online, the game goes on for everyone
  ov.querySelectorAll<HTMLElement>('[data-step]').forEach((b) => (b.onclick = () => showHelp(Number(b.dataset.step))));
  const close = () => {
    ov.hidden = true;
    session.paused = wasPaused;
    helpWasPaused = null;
  };
  // Opened from the start menu: Start playing starts the game; Skip goes back to the menu.
  ov.querySelector<HTMLElement>('#btn-close')?.addEventListener('click', () => (onStart ? play() : close()));
  ov.querySelector<HTMLElement>('#btn-skip')?.addEventListener('click', () => {
    if (!onStart) return close();
    helpWasPaused = null;
    showStart();
  });
  ov.querySelector<HTMLElement>('#watch-bots')?.addEventListener('click', (e) => {
    e.preventDefault();
    helpWasPaused = null;
    newGame(true);
  });
}
/** Whether the game was paused before the help card opened (kept while flipping its pages). */
let helpWasPaused: boolean | null = null;

/** The start menu is up (or one of its cards, opened from it): closing those comes back to it. */
let onStart = false;

/** The first screen: play, learn how, play online, watch the bots, or change the settings. */
function showStart() {
  onStart = true;
  const ov = $('overlay');
  ov.innerHTML = `<div class="card start"><h1>Signature Required</h1>
    <p class="muted">Invest in a town's trucking companies and get rich on their deliveries.</p>
    <div class="start-buttons">
      <button id="st-play" class="go">Play</button>
      <button id="st-help" class="plain">How to play</button>
      <button id="st-online" class="plain">Play online</button>
      <button id="st-watch" class="plain">Watch the bots</button>
      <button id="st-settings" class="plain">⚙ Settings</button>
    </div>
    <p class="muted small">New here? <b>How to play</b> walks you through it in a minute.</p></div>`;
  ov.hidden = false;
  if (!session.multiplayer) session.paused = true; // the game behind waits
  $('st-play').onclick = play;
  $('st-help').onclick = () => showHelp();
  $('st-online').onclick = () => showOnline();
  $('st-watch').onclick = () => newGame(true);
  $('st-settings').onclick = () => showSettings();
}

/** From the start menu into the game waiting behind it. */
function play() {
  onStart = false;
  helpWasPaused = null;
  $('overlay').hidden = true;
  if (!session.multiplayer) session.paused = false;
  $('btn-pause').textContent = session.paused ? '▶' : '⏸';
}

// ------------------------------------------------------------------ loop and controls

function frame(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  session.update(dt);
  const obs = session.obs();
  handleEvents(session.takeEvents());
  for (const l of obs.locations) knownBusiness.set(l.id, { kind: l.kind, good: l.good });
  // Online: someone left, or the host did.
  const notices = (session as { notices?: string[] }).notices;
  while (notices?.length) toast(notices.shift()!, 'info');
  if ((session as { lostHost?: boolean }).lostHost && !shownEnd) hostGone();
  sampleWaiting(obs);
  sampleHistory(obs);
  // Where to draw each truck: on its route in its lane (smooth between ticks), or in a building's line.
  const ahead = Math.max(0, session.renderT - obs.t);
  const drawn = motion.update(obs, ahead, session.cfg.trucks, session.cfg.tickSec);
  shown.clear();
  for (const [id, sp] of drawn) shown.set(id, sp);

  tooltip(obs);
  hl.spotlight = new Set(obs.sales.map((x) => x.company)); // every company holding a sale
  hl.meterFor = obs.companies.map((c) => c.id); // public: everyone sees every company's progress
  const trucksNow = [...shown].map(([id, sp]) => ({ id, ...sp }));
  redraw = () => renderer.draw(obs, trucksNow, hl, now / 1000);
  redraw();
  if (now - lastUi > 250) {
    lastUi = now;
    refreshPanels(obs);
  }
  endScreen(obs);
  requestAnimationFrame(frame);
}

function togglePause() {
  if (!session.canControlTime) return toast('Only the host can pause.', 'info');
  session.paused = !session.paused;
  $('btn-pause').textContent = session.paused ? '▶' : '⏸';
}

function newGame(watch = false) {
  const { seed: _replay, ...fresh } = overridesFromUrl(); // a new game gets a new town
  beginMatch(new Session({ overrides: mergeOverrides(loadSettings(), fresh), watch }));
}

/** Switch the screen to a match (solo, watching, hosted or joined), resetting everything per game. */
function beginMatch(m: Match) {
  session.dispose();
  session = m;
  watching = m.watch;
  pickCompanySlots(session.cfg.companies, session.cfg.seed);
  routeLog.clear();
  companyLog.clear();
  runningSince = null;
  knownBusiness.clear();
  lastDividend.clear();
  history.length = 0;
  earned.clear();
  lastHistory = -Infinity;
  waitLog.clear();
  lastWaitSample = -1;
  hl.saturated = new Set();
  // Online, time runs at 1× and only the host can pause.
  const speedSel = $<HTMLSelectElement>('speed');
  speedSel.disabled = session.multiplayer;
  if (session.multiplayer) speedSel.value = '1';
  session.speed = Number(speedSel.value);
  ($('btn-pause') as HTMLButtonElement).disabled = !session.canControlTime;
  $('btn-pause').textContent = session.paused ? '▶' : '⏸';
  renderer.setTown(session.game.town);
  motion.reset();
  renderer.via = session.cfg.trucks.viaDepot;
  renderer.serviceSec = session.cfg.trucks.serviceSec;
  renderer.processSec = session.cfg.trucks.signOffSec;
  renderer.palletPrice = session.cfg.money.palletPrice;
  renderer.resize(true);
  viewMoved = false;
  logList.innerHTML = '';
  $('overlay').hidden = true;
  onStart = false;
  shown.clear();
  reachCache.clear();
  hl.picked = [];
  hl.buyFor = null;
  activeCompany = null;
  shownEnd = false;
  hl.district = session.cfg.depots.districtBlocks;
  hl.siteBase = session.cfg.depots.depotBase;
  hl.maxSubsidy = session.cfg.depots.maxSubsidy;
  hl.flash.clear();
}

$('btn-pause').onclick = togglePause;
// Hovering a company card shows the subsidy meters on every free factory site.
document.addEventListener('pointermove', (e) => {
  const card = (e.target as HTMLElement | null)?.closest?.('[data-cohover]') as HTMLElement | null;
  hl.cardCompany = card ? Number(card.dataset.cohover) : null;
  const row = (e.target as HTMLElement | null)?.closest?.('[data-routerow]') as HTMLElement | null;
  hl.listRoute = row ? row.dataset.routerow! : null;
});
$('btn-help').onclick = () => showHelp();
$<HTMLSelectElement>('speed').onchange = (e) => (session.speed = Number((e.target as HTMLSelectElement).value));
$('btn-new').onclick = () => {
  // Online, a new game leaves this one (and, for the host, ends it for everyone).
  if (session.multiplayer && !session.done && !confirm(session.canControlTime ? 'Start a new game? This ends the online game for everyone.' : 'Leave this online game?')) return;
  newGame();
};
$('btn-settings').onclick = () => showSettings();

/** The ⚙ card: tune the game, then start a new one with those settings (kept in this browser). */
function showSettings() {
  const ov = $('overlay');
  const defaults = makeGameConfig({});
  const current = makeGameConfig(loadSettings());
  const decimals = (st: Setting) => (String(st.step).split('.')[1] ?? '').length;
  const shown = (cfg: GameConfig, st: Setting) => (valueIn(cfg, st) * (st.scale ?? 1)).toFixed(decimals(st));
  const groups = [...new Set(SETTINGS.map((st) => st.group))];
  ov.innerHTML = `<div class="card settings"><h1>Settings</h1><p class="muted small">These apply when you start a new game, and are kept in this browser.</p>
    ${groups
      .map(
        (gname) => `<h2>${gname}</h2>${SETTINGS.map((st, i) => (st.group !== gname ? '' : `<label class="set-row" data-i="${i}" title="${st.hint ?? ''}"><span>${st.label}</span>
          <span class="set-in"><input type="number" data-i="${i}" min="${st.min}" max="${st.max}" step="${st.step}" value="${shown(current, st)}">${st.unit ? `<em>${st.unit}</em>` : ''}</span>
          <span class="set-def">default ${shown(defaults, st)}</span></label>`)).join('')}`,
      )
      .join('')}
    <div class="set-buttons"><button id="set-start">Start a new game</button><button id="set-watch" class="plain">Watch the bots play</button><button id="set-reset" class="plain">Reset to defaults</button><button id="set-close" class="plain">Close</button></div></div>`;
  ov.hidden = false;
  const wasPaused = session.paused;
  if (!session.multiplayer) session.paused = true;
  const inputs = [...ov.querySelectorAll<HTMLInputElement>('input[data-i]')];
  const mark = () =>
    inputs.forEach((inp) => {
      const st = SETTINGS[Number(inp.dataset.i)];
      inp.closest('.set-row')!.classList.toggle('changed', inp.value !== shown(defaults, st));
    });
  inputs.forEach((inp) => inp.addEventListener('input', mark));
  mark();
  const close = () => {
    ov.hidden = true;
    session.paused = wasPaused;
    if (onStart) showStart();
  };
  $('set-close').onclick = close;
  $('set-reset').onclick = () => {
    for (const inp of inputs) inp.value = shown(defaults, SETTINGS[Number(inp.dataset.i)]);
    mark();
  };
  const start = (watch: boolean) => {
    const values = new Map<Setting, number>();
    for (const inp of inputs) {
      const st = SETTINGS[Number(inp.dataset.i)];
      const v = Number(inp.value);
      if (Number.isFinite(v)) values.set(st, Math.min(st.max, Math.max(st.min, v)));
    }
    saveSettings(overridesFrom(values));
    ov.hidden = true;
    newGame(watch);
  };
  $('set-start').onclick = () => start(false);
  $('set-watch').onclick = () => start(true);
}
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === ' ' && hl.areaEdit) {
    // While editing, Space is for moving the map (P still pauses).
    e.preventDefault();
    spaceHeld = true;
    canvas.classList.add('panning');
  } else if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
    e.preventDefault();
    togglePause();
  } else if (e.key === 'Escape') {
    sitePop = null;
    hl.picked = [];
    hl.buyFor = null;
    endAreaEdit();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  spaceHeld = false;
  canvas.classList.remove('panning');
});
window.addEventListener('resize', () => renderer.resize(false));

renderer.resize(true);
requestAnimationFrame(frame);
// ------------------------------------------------------------------ playing online

/** The name you play under online (remembered in this browser). */
function savedName(): string {
  try {
    return localStorage.getItem('sr-name') ?? '';
  } catch {
    return '';
  }
}
function rememberName(n: string) {
  try {
    localStorage.setItem('sr-name', n);
  } catch {
    // Storage blocked: fine, they'll type it again next time.
  }
}

let lobby: HostLobby | GuestLobby | null = null;
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The Play online card: host a room or join one. */
function showOnline(joinCode = '') {
  lobby?.close();
  lobby = null;
  const ov = $('overlay');
  ov.innerHTML = `<div class="card online"><h1>Play online</h1>
    <p class="muted small">One person hosts; friends join with the room code. Bots take any empty seats, and any seat whose player leaves.</p>
    <label class="field"><span>Your name</span><input id="on-name" maxlength="16" value="${esc(savedName())}" placeholder="Name"></label>
    <div class="online-cols">
      <div><h2>Host</h2><p class="muted small">Uses your ⚙ settings.</p><button id="on-host">Host a game</button></div>
      <div><h2>Join</h2><label class="field"><span>Room code</span><input id="on-code" maxlength="4" value="${esc(joinCode)}" placeholder="ABCD"></label><button id="on-join">Join</button></div>
    </div>
    <p id="on-err" class="bad small"></p>
    <button id="on-close" class="plain">Back</button></div>`;
  ov.hidden = false;
  const name = () => {
    const n = $<HTMLInputElement>('on-name').value.trim().slice(0, 16) || 'Player';
    rememberName(n);
    return n;
  };
  const err = (m: string) => ($('on-err').textContent = m);
  $('on-close').onclick = () => {
    lobby?.close();
    lobby = null;
    ov.hidden = true;
    if (onStart) showStart();
  };
  $('on-host').onclick = async () => {
    const host = new HostLobby(name(), Math.max(2, Math.min(4, makeGameConfig(loadSettings()).players)));
    lobby = host;
    err('Opening a room…');
    try {
      await host.open();
    } catch (e) {
      return err((e as Error).message);
    }
    host.onChange = () => hostRoom(host);
    host.onError = err;
    hostRoom(host);
  };
  $('on-join').onclick = async () => {
    const code = normalizeCode($<HTMLInputElement>('on-code').value);
    if (code.length !== 4) return err('Room codes are 4 letters.');
    const guest = new GuestLobby();
    lobby = guest;
    err('Joining…');
    guest.onChange = () => guestRoom(guest, code);
    guest.onError = (m) => toast(m, 'error');
    guest.onStart = (m) => {
      lobby = null;
      beginMatch(m);
    };
    try {
      await guest.join(code, name());
    } catch (e) {
      return err((e as Error).message);
    }
    guestRoom(guest, code);
  };
}

const playerList = (players: { seat: number; name: string; host: boolean }[], total: number) =>
  `<ol class="lobby-list">${Array.from({ length: total }, (_, s) => {
    const p = players.find((x) => x.seat === s);
    return `<li>${p ? `<b>${esc(p.name)}</b>${p.host ? ' <span class="muted">(host)</span>' : ''}` : '<span class="muted">a bot, unless someone joins</span>'}</li>`;
  }).join('')}</ol>`;

/** The host's waiting room: the code, an invite link, who's in, and Start. */
function hostRoom(host: HostLobby) {
  const ov = $('overlay');
  const link = `${location.origin}${location.pathname}?join=${host.code}`;
  const total = Math.max(2, Math.min(4, makeGameConfig(loadSettings()).players));
  ov.innerHTML = `<div class="card online"><h1>Room ${host.code}</h1>
    <p>Send friends the code, or this link:</p>
    <div class="invite"><input readonly value="${link}" id="on-link"><button id="on-copy" class="plain">Copy</button></div>
    <h2>Players</h2>${playerList(host.players, total)}
    <p class="muted small">Keep this tab open: it runs the game for everyone.</p>
    <div class="set-buttons"><button id="on-start">Start game</button><button id="on-cancel" class="plain">Close the room</button></div></div>`;
  ov.hidden = false;
  $('on-copy').onclick = () => {
    $<HTMLInputElement>('on-link').select();
    navigator.clipboard?.writeText(link).then(() => toast('Invite link copied.', 'info'), () => {});
  };
  $('on-cancel').onclick = () => {
    host.close();
    lobby = null;
    ov.hidden = true;
  };
  $('on-start').onclick = () => {
    lobby = null;
    const { seed: _replay, ...fresh } = overridesFromUrl();
    beginMatch(host.start(mergeOverrides(loadSettings(), fresh)));
  };
}

/** A guest's waiting room. */
function guestRoom(guest: GuestLobby, code: string) {
  const ov = $('overlay');
  const host = guest.players.find((p) => p.host);
  ov.innerHTML = `<div class="card online"><h1>Room ${code}</h1>
    <p>You're in. Waiting for ${host ? esc(host.name) : 'the host'} to start the game…</p>
    <h2>Players</h2>${playerList(guest.players, Math.max(guest.players.length, 4))}
    <button id="on-leave" class="plain">Leave</button></div>`;
  ov.hidden = false;
  $('on-leave').onclick = () => {
    guest.close();
    lobby = null;
    ov.hidden = true;
  };
}

/** The host closed their tab: the game is over. */
function hostGone() {
  shownEnd = true;
  const ov = $('overlay');
  ov.innerHTML = `<div class="card"><h1>The host left</h1><p>The game ran in their tab, so it has ended.</p><button id="btn-again">Play solo</button> <button id="btn-online2" class="plain">Play online</button></div>`;
  ov.hidden = false;
  $('btn-again').onclick = () => newGame();
  $('btn-online2').onclick = () => showOnline();
}

$('btn-online').onclick = () => showOnline();

const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam) showOnline(normalizeCode(joinParam));
else if (!watching) showStart();

// For poking at a running match from the browser console.
(window as unknown as { sr: unknown }).sr = {
  get session() {
    return session;
  },
  renderer,
  hl,
  /** Where each truck is drawn (for tests). */
  shown,
  motion,
};
