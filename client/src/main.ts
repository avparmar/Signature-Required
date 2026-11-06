/**
 * The client: a solo game against bots in real time.
 *
 * - The town, trucks and routes are drawn by render.ts; drag to pan, scroll to zoom.
 * - Routes (#33): click a producer and a consumer of the same good (and optionally one of your
 *   depots first) to send a free truck on that route. Click a route line to add a truck, right-click
 *   it to take one off. Esc or right-click on the map clears the selection.
 * - Company panel (#34): treasury, fleet, depots and routes for companies you run; buy trucks and
 *   depots (affordable sites light up on the map with your price).
 * - The share market lives in the company cards: each company's sale (when one is running), its
 *   standing bid and ask, what the company pays to buy a share back, and a box to bid or ask.
 */
import { distancesFrom, makeGameConfig, minimumBid, type GameConfig, type GameConfigOverrides, type GameEvent, type Location, type Observation } from '@sr/core';
import { Renderer, type Spot, companyColor, companySlot, coordOf, drawBusiness, drawFactory, goodColor, pickCompanySlots, type Highlights } from './render.js';
import { Session } from './session.js';
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
  ['Tealwater Trucking', 'TWT'],
  ['Magenta Moth Movers', 'MMM'],
  ['Lime Lizard Lines', 'LLL'],
  ['Skyhook Shipping', 'SKY'],
];
const coName = (c: number) => COMPANY_NAMES[companySlot(c)][0];
const coTicker = (c: number) => COMPANY_NAMES[companySlot(c)][1];
/** A holding as a chip in the company's colour: ticker, shares, and a crown for its president. */
const holdingChip = (c: number, n: number, pres: boolean) =>
  `<span class="chip co-chip${pres ? ' pres' : ''}" style="background:${companyColor(c)}" title="${coName(c)}: ${n} share${n === 1 ? '' : 's'}${pres ? ', president' : ''}">${pres ? '♔ ' : ''}${coTicker(c)} ×${n}</span>`;
// While watching the bots, Player 1 isn't you.
const playerName = (p: number, me: number) => (p === me && !watching ? 'you' : seatName(p));
/** A seat's name: the person's name online, otherwise Player N. */
const seatName = (p: number) => session.names[p] || `Player ${p + 1}`;
/** Each seat's icon, so players are easy to tell apart wherever they appear (names alone aren't, online). */
const SEAT_ICONS = ['🦊', '🐻', '🐸', '🐧', '🦉', '🐙', '🐯', '🐨'];
const seatIcon = (p: number) => SEAT_ICONS[p % SEAT_ICONS.length];
/** A short label: icon plus their name (trimmed) online, otherwise PN. */
const seatShort = (p: number) => `${seatIcon(p)} ${session.names[p] ? session.names[p].slice(0, 8) : `P${p + 1}`}`;
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
  spotlight: null,
  district: session.cfg.depots.districtBlocks,
  meterFor: [],
  cardCompany: null,
  siteBase: session.cfg.depots.depotBase,
  maxSubsidy: session.cfg.depots.maxSubsidy,
  flash: new Map(),
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
  $('me-title').textContent = watching ? 'Player 1 (a bot: you\'re watching)' : 'You';
  $('mycos-title').textContent = watching ? "Player 1's companies" : 'Your companies';
  if (watching) {
    hint.textContent = 'Watching the bots play. Change the speed at the top; New game to play yourself.';
    return;
  }
  if (hl.buyFor !== null) {
    hint.textContent = `Buying a factory for ${coName(hl.buyFor)}: click a highlighted site (Esc to cancel).`;
    return;
  }
  if (obs.phase === 'opening') {
    hint.textContent = 'Opening round: bid for shares in the company cards on the left. The president of a company runs it.';
    return;
  }
  const picks = hl.picked.map((id) => g.town.locations[id]);
  const p = picks.find((l) => l.kind === 'producer');
  const c = picks.find((l) => l.kind === 'consumer');
  if (p && !c) hint.textContent = `${cap(names(p.good!).source)} picked: now a ${names(p.good!).shop} to sell the ${names(p.good!).product} to.`;
  else if (c && !p) hint.textContent = `${cap(names(c.good!).shop)} picked: now a ${names(c.good!).source} to supply it.`;
  else if (picks.length) hint.textContent = 'Factory picked: now a producer and a shop.';
  else if (myCompanies(obs).length === 0) hint.textContent = 'You run no company yet: own the most shares of one to become its president.';
  else hint.textContent = 'Click a producer and a shop of the same good to send a truck. Right-click a route to take one off.';
}

// ------------------------------------------------------------------ routes from clicks

function tryAssign(obs: Observation) {
  const g = session.game;
  const picks = hl.picked.map((id) => g.town.locations[id]);
  const p = picks.find((l) => l.kind === 'producer');
  const c = picks.find((l) => l.kind === 'consumer');
  if (!p || !c) return;
  if (p.good !== c.good) {
    toast(`A ${names(c.good!).shop} doesn't sell ${names(p.good!).product}.`, 'error');
    hl.picked = hl.picked.filter((id) => id !== c.id);
    return;
  }
  const pickedDepot = picks.find((l) => l.kind === 'depot');
  const company = pickedDepot ? obs.depots[pickedDepot.id] : currentCompany(obs);
  if (company === null || company === undefined) {
    toast('You need to be president of a company to run trucks.', 'error');
    hl.picked = [];
    return;
  }
  if (freeTrucks(obs, company) === 0) {
    toast(`${coName(company)} has no free truck. Buy one in the company panel.`, 'error');
    return;
  }
  const depot = pickedDepot ? pickedDepot.id : bestDepot(obs, company, p, c);
  if (depot === null) return;
  session.act({ type: 'assignRoute', depot, producer: p.id, consumer: c.id });
  activeCompany = company;
  hl.picked = [];
}

/** The company's factory that makes the shortest trip from producer, via it, to the shop. */
function bestDepot(obs: Observation, company: number, producer: Location, shop: Location): number | null {
  let best: number | null = null;
  let bestLen = Infinity;
  for (const [site, owner] of Object.entries(obs.depots)) {
    if (owner !== company) continue;
    const d = siteReach(Number(site));
    const len = d[producer.node] + d[shop.node];
    if (len < bestLen) {
      bestLen = len;
      best = Number(site);
    }
  }
  return best;
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
  const g = session.game;
  const l = renderer.locationAt(sx, sy);
  const route = l ? null : renderer.routeAt(sx, sy, obs.routes);
  if (right) {
    if (route) {
      if (!obs.companies[route.company].presidents.includes(obs.me)) return toast(`That route belongs to ${coName(route.company)}.`, 'error');
      session.act({ type: 'unassignRoute', depot: route.depot, producer: route.producer, consumer: route.consumer });
      activeCompany = route.company;
      return;
    }
    hl.picked = [];
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
  if (obs.phase === 'opening' && l && l.kind !== 'lot') return toast('Routes open when the clock starts, after the opening sales.', 'info');
  if (obs.phase !== 'running') return;
  if (route && !l) {
    if (!obs.companies[route.company].presidents.includes(obs.me)) return toast(`That route belongs to ${coName(route.company)}.`, 'error');
    if (freeTrucks(obs, route.company) === 0) return toast('No free truck: buy one in the company panel.', 'error');
    session.act({ type: 'assignRoute', depot: route.depot, producer: route.producer, consumer: route.consumer });
    activeCompany = route.company;
    return;
  }
  if (!l) {
    hl.picked = [];
    return;
  }
  if (l.kind === 'depot') {
    const owner = obs.depots[l.id];
    if (owner === undefined) return toast('An unclaimed factory site. Buy it from your company\'s card (Pick on map…).', 'info');
    if (!obs.companies[owner].presidents.includes(obs.me)) return toast(`That factory belongs to ${coName(owner)}.`, 'error');
    hl.picked = hl.picked.filter((id) => g.town.locations[id].kind !== 'depot');
  } else hl.picked = hl.picked.filter((id) => g.town.locations[id].kind !== l.kind);
  hl.picked.push(l.id);
  tryAssign(obs);
}

// ------------------------------------------------------------------ canvas events

const canvas = $<HTMLCanvasElement>('map');
let drag: { x: number; y: number; moved: boolean } | null = null;
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) drag = { x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener('mousemove', (e) => {
  const box = canvas.getBoundingClientRect();
  mouse = { x: e.clientX - box.left, y: e.clientY - box.top, inside: e.target === canvas };
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
canvas.addEventListener('dblclick', () => {
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
    return;
  }
  const g = session.game;
  const l = renderer.locationAt(mouse.x, mouse.y, true);
  const route = l ? null : renderer.routeAt(mouse.x, mouse.y, obs.routes);
  hl.hover = l && l.kind !== 'lot' ? l.id : null;
  hl.hoverRoute = route?.key ?? null;
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
  if (!html) {
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
      ? 'Opening sales: one share of each company, before the clock starts'
      : obs.phase === 'ended'
        ? 'Game over'
        : `Next payout in ${fmtClock(obs.nextPayoutAt - obs.t)}`;
  // The last 10 seconds before a payout: the countdown lights up.
  $('phase').classList.toggle('soon', obs.phase === 'running' && obs.nextPayoutAt - obs.t <= 10);

  // You: cash and shares.
  let html = `<div class="row big"><span>Cash</span><b>${money(me.cash)}</b></div>`;
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
  $('players').innerHTML = obs.players
    .filter((p) => p.id !== obs.me)
    .map((p) => {
      const held = obs.companies.filter((c) => c.shares.includes(p.id));
      const shares = held
        .map((c) => {
          const n = c.shares.filter((s) => s === p.id).length;
          return holdingChip(c.id, n, c.presidents.includes(p.id));
        })
        .join('');
      return `<div class="pl"><span class="icon">${seatIcon(p.id)}</span><b>${seatName(p.id)}</b><span class="cash">${money(p.cash)}</span><span class="chips">${shares || '<span class="muted small">no shares</span>'}</span></div>`;
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
  press(kk.placeSell, () => session.act({ type: 'ask', company: id, price: Number(kk.slider.value) }));
  return k;
}

/** The least a bid could be now to stand (and, in a sale, to count). */
function leastBid(obs: Observation, id: number): number {
  const book = obs.books[id];
  const min = minimumBid(book, obs.me, session.cfg.auctions);
  return obs.sales.some((x) => x.company === id) ? Math.max(min, obs.minPrice[id]) : Math.max(1, min);
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
    const routes = obs.routes.filter((r) => r.company === c.id).length;
    // One chip per shareholder with how many shares they hold (you first, presidents crowned),
    // then the shares the company owns itself.
    const holders = new Map<number, number>();
    for (const sh of c.shares) if (sh !== null) holders.set(sh, (holders.get(sh) ?? 0) + 1);
    const order = [...holders.keys()].sort((a, b) => (a === obs.me ? -1 : b === obs.me ? 1 : holders.get(b)! - holders.get(a)! || a - b));
    const own = c.shares.filter((sh) => sh === null).length;
    const mine = holders.get(obs.me) ?? 0;
    const chips =
      order
        .map((pl) => {
          const pres = c.presidents.includes(pl);
          const n = holders.get(pl)!;
          const you = pl === obs.me && !watching;
          return `<span class="chip${you ? ' you' : ''}${pres ? ' pres' : ''}" title="${you ? 'You' : seatName(pl)}: ${n} share${n === 1 ? '' : 's'}${pres ? ', president' : ''}">${pres ? '♔ ' : ''}${you ? `${seatIcon(pl)} You` : seatIcon(pl)} ×${n}</span>`;
        })
        .join('') + (own ? `<span class="chip bank" title="Shares the company owns itself: sold in sales">company ×${own}</span>` : '');
    const sale = obs.sales.find((x) => x.company === c.id);
    const book = obs.books[c.id];
    const who = (p: number) => (p === obs.me && !watching ? 'you' : seatShort(p));
    const pinned = pinnedCards.has(c.id);
    let html = `<div class="row head"><span>${sw(c.id)}<b>${coName(c.id)}</b></span><span><button class="pin${pinned ? ' on' : ''}" data-pin="${c.id}" title="${pinned ? 'Unpin: fold this card back down' : 'Pin this card open'}">${pinned ? 'Unpin' : 'Pin'}</button><span title="Treasury">${money(c.treasury)}</span></span></div>`;
    let saleBtn = '';
    if (acting && obs.phase === 'running' && own && !sale && c.presidents.length) {
      const cooldown = obs.saleCooldownUntil[c.id] - obs.elapsed;
      saleBtn = `<button class="mini" data-startsale="${c.id}" ${cooldown > 0 ? 'disabled' : ''} title="Put one of the company's own shares up for sale. The best bid at the end gets it, if it's at least ${money(obs.minPrice[c.id])}; the money goes to the company.">${cooldown > 0 ? `Sale in ${Math.ceil(cooldown)}s` : 'Start a sale'}</button>`;
    }
    html += `<div class="chips">${chips}${saleBtn}</div>`;
    html += `<div class="row small quick-stats"><span title="Company value: trucks and factories at what they cost, plus cash">Value <b>${money(obs.value[c.id])}</b></span><span title="Next dividend per share, so far">Div <b>${money(c.dividendPerShare)}</b></span><span title="${trucks} trucks, ${depots} factor${depots === 1 ? 'y' : 'ies'}">🚚 <b>${trucks}</b> 🏭 <b>${depots}</b></span></div>`;
    // Folded, the card stops here (plus a line for a running sale); hovering or pinning shows the rest.
    if (sale) {
      const best = book.bid;
      html += `<div class="row small sale-line fold-only"><b>${sale.opening ? 'Opening sale' : 'Sale'} ${Math.ceil(sale.timeLeft)}s</b><span>${best ? `highest bid ${money(best.price)}${best.player === obs.me && !watching ? ' (you)' : ''}` : 'no bids yet'}</span></div>`;
    }
    html += '<div class="more">';
    html += `<div class="row small muted"><span>${trucks} trucks · ${depots} factor${depots === 1 ? 'y' : 'ies'} · ${routes} route${routes === 1 ? '' : 's'}</span></div>`;
    html += `<div class="row small muted"><span>Dividend per share</span><span>last ${lastDividend.has(c.id) ? money(lastDividend.get(c.id)!) : '—'} · next ${money(c.dividendPerShare)}</span></div>`;
    // A sale running: the share goes to the best bid at the end, if it's at least the minimum.
    if (sale) {
      const best = book.bid;
      const enough = best !== null && best.price >= obs.minPrice[c.id];
      const last = sale.age + sale.timeLeft >= session.cfg.auctions.maxSec - 0.05 && sale.timeLeft < session.cfg.auctions.softCloseSec;
      html += `<div class="sale"><div class="row"><b>${sale.opening ? 'Opening sale' : 'Selling a company share'}</b><b>${Math.ceil(sale.timeLeft)}s</b></div>`;
      html += `<div class="row small"><span>Highest bid</span><span>${best ? `${money(best.price)} (${who(best.player)})` : 'none yet'}</span></div>`;
      if (obs.minPrice[c.id] > 0) html += `<div class="row small muted"><span>Sells for at least</span><span>${money(obs.minPrice[c.id])}${best && !enough ? ' · not met yet' : ''}</span></div>`;
      if (best?.player === obs.me && !watching) html += `<div class="good small">${enough ? 'You’re winning it.' : 'Your bid is below the minimum.'}</div>`;
      if (last) html += `<div class="muted small">Final seconds: bids no longer add time.</div>`;
      html += `</div>`;
    }
    // The market: standing orders (yours can be withdrawn), the company's buy-back price, and starting a sale.
    if (obs.phase === 'running') {
      const rows: string[] = [];
      const order = (side: 'bid' | 'ask', o: { player: number; price: number }) => {
        const yours = o.player === obs.me && !watching;
        return `<div class="row small"><span>${side === 'bid' ? 'Buying' : 'Selling'}: ${money(o.price)} (${who(o.player)})</span>${acting && yours ? `<button class="mini" data-cancel="${c.id}:${side}">Withdraw</button>` : ''}</div>`;
      };
      if (book.bid && !sale) rows.push(order('bid', book.bid));
      if (book.ask) rows.push(order('ask', book.ask));
      const cb = obs.companyBid[c.id];
      if (cb !== null) rows.push(`<div class="row small"><span title="Half the company value per share, while its cash covers that">Company buys back at ${money(cb)}</span></div>`);
      html += rows.join('');
    }
    html += '</div>';
    if (k.info.dataset.html !== html) {
      k.info.innerHTML = html;
      k.info.dataset.html = html;
    }
    k.root.classList.toggle('selling', !!sale);
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
    k.buyNow.innerHTML = otherAsk === null ? 'Nobody selling' : canBuy ? `Buy for <b>${money(otherAsk)}</b> <span class="from">${seller}</span>` : `${seller} sells for <b>${money(otherAsk)}</b>`;
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
    k.sellNow.innerHTML = sellAt === null ? 'Nobody buying' : `Sell for <b>${money(sellAt)}</b> <span class="from">${buyer}</span>`;
    k.sellNow.disabled = !canSell;
    k.sellNow.classList.toggle('note', !canSell);
    k.sellNow.title = sellAt === null ? 'Nobody is buying right now' : toCompany ? 'Sell one of your shares back to the company at once' : `Sell one of your shares to ${seatName(book.bid!.player)} at once`;
    // The slider runs from the least buy order that would stand to just below the standing ask
    // (or, with nobody selling, well above the company's worth per share).
    const low = leastBid(obs, c.id);
    const perShare = Math.ceil(obs.value[c.id] / c.shares.length);
    const high = Math.max(low, otherAsk !== null ? otherAsk - 1 : Math.max(low + 20, Math.ceil(perShare * 1.5)));
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
    k.hi.title = otherAsk !== null ? 'Just below the standing sell price' : 'Nobody is selling: well above the company value per share';
    // Place a buy order at that price (in a sale, that's your bid), or a sell order for one of your shares.
    k.placeBuy.textContent = myBid ? 'Raise buy' : sale ? 'Bid' : 'Place buy';
    k.placeBuy.disabled = v < low || (otherAsk !== null && v >= otherAsk) || v - myBid > free;
    k.placeBuy.title = v - myBid > free ? 'Not enough cash' : `Offer ${money(v)} for a share${sale ? ' in this sale' : ''}; it holds that cash until it's filled, beaten or withdrawn`;
    k.placeSell.textContent = book.ask?.player === obs.me ? 'Lower sell' : 'Place sell';
    k.placeSell.hidden = !!sale;
    const sellOk = mine > 0 && v > (otherBid ?? 0) && v > (cb ?? 0) && (otherAsk === null || v <= otherAsk - cfg.minRaise) && (book.ask?.player !== obs.me || v < book.ask.price);
    k.placeSell.disabled = !sellOk;
    k.placeSell.title = !mine ? "You don't own a share" : sellOk ? `Offer one of your shares for ${money(v)}` : 'At this price, sell now instead (or undercut the standing price)';
  });
}

function refreshMyCompanies(obs: Observation) {
  const g = session.game;
  const mine = myCompanies(obs);
  const box = $('mycos');
  let html = '';
  if (!mine.length) html = '<div class="muted small">You aren’t president of any company. Own the most shares of one to run it.</div>';
  for (const id of mine) {
    const c = obs.companies[id];
    const trucks = obs.trucks.filter((t) => t.company === id);
    const free = freeTrucks(obs, id);
    const factories = Object.values(obs.depots).filter((o) => o === id).length;
    const limit = factories * g.cfg.depots.capacity;
    html += `<div class="co${currentCompany(obs) === id ? ' active' : ''}" data-company="${id}" data-cohover="${id}"><div class="row big"><span>${sw(id)}<b>${coName(id)}</b></span><b>${money(c.treasury)}</b></div>`;
    const full = trucks.length >= limit;
    const nextTruck = g.cfg.depots.truckPrice + g.cfg.depots.truckPriceStep * trucks.length;
    const canPay = c.treasury >= nextTruck;
    const home = Object.entries(obs.depots).find(([, o]) => o === id)?.[0];
    html += `<div class="row small"><span>${trucks.length}/${limit} trucks: ${free} free</span>${home === undefined ? '' : `<button data-truck="${id}:${home}" ${full || !canPay ? 'disabled' : ''} title="${full ? `Fleet full: each factory adds ${g.cfg.depots.capacity}` : canPay ? '' : 'Not enough in the treasury'}">Buy truck ${money(nextTruck)}</button>`}</div>`;
    const myFactories = Object.entries(obs.depots).filter(([, o]) => o === id).map(([site]) => at(Number(site)));
    html += `<div class="row small muted"><span>Factor${myFactories.length === 1 ? 'y' : 'ies'}: ${myFactories.join(', ')}</span></div>`;
    // The free factory sites nearest this company's factories, with its price for each.
    const sites = Object.keys(obs.depotPrices).map(Number);
    if (sites.length) {
      const own = Object.entries(obs.depots).filter(([, o]) => o === id).map(([site]) => g.town.locations[Number(site)].node);
      const dist = (site: number) => Math.min(...own.map((n) => siteReach(site)[n]));
      const near = sites.sort((a, b) => dist(a) - dist(b)).slice(0, 3);
      html += `<div class="row small"><span class="muted">Nearby factory sites</span><button data-depot="${id}" class="${hl.buyFor === id ? 'on' : ''}">${hl.buyFor === id ? 'Cancel' : 'Pick on map…'}</button></div><div class="sites">`;
      for (const site of near) {
        const price = obs.depotPrices[site][id];
        html += `<button data-buysite="${id}:${site}" ${c.treasury < price ? 'disabled' : ''} title="${Math.round(dist(site))} blocks away${price < g.cfg.depots.depotBase ? ', local subsidy' : ''}">${at(site)} ${money(price)}</button>`;
      }
      html += '</div>';
    } else html += '<div class="row small muted"><span>No unclaimed factory sites left</span></div>';
    const routes = obs.routes
      .filter((r) => r.company === id)
      .sort((a, b) => g.town.locations[a.producer].good! - g.town.locations[b.producer].good! || a.key.localeCompare(b.key));
    if (routes.length) {
      // Long lists fold away (into a count per good) until you open them; short ones stay open.
      const open = routesOpen.get(id) ?? routes.length <= ROUTES_FOLD_AT;
      const total = routes.reduce((n, r) => n + r.trucks, 0);
      html += `<button class="sub fold" data-fold="${id}">${open ? '▾' : '▸'} Routes · ${routes.length} · ${total} truck${total === 1 ? '' : 's'}</button>`;
      if (!open) {
        const byGood = new Map<number, number>();
        for (const r of routes) byGood.set(g.town.locations[r.producer].good!, (byGood.get(g.town.locations[r.producer].good!) ?? 0) + 1);
        html += `<div class="row small muted"><span>${[...byGood].map(([good, n]) => `<span class="dot" style="background:${goodColor(good)}"></span>${cap(names(good).product)} ×${n}`).join(' &nbsp; ')}</span></div>`;
      }
      if (open) for (const r of routes) {
        const p = g.town.locations[r.producer];
        html += `<div class="row small route-row${hl.hoverRoute === r.key ? ' hot' : ''}${hl.saturated.has(r.key) ? ' saturated' : ''}" data-routerow="${r.key}"><span><span class="dot" style="background:${goodColor(p.good!)}"></span>${cap(names(p.good!).product)} ${at(r.producer)} → ${at(r.depot)} → ${at(r.consumer)}<span class="rate" title="What this route earned per minute over the last ${RATE_WINDOW / 60} minutes">${routeRate(r.key, obs.t, r.trucks)}</span>${saturatedNote(r.key, p.good!)}</span><span class="route-ctl"><button data-unroute="${r.key}">−</button> ${r.trucks} <button data-route="${r.key}" ${freeTrucks(obs, id) ? '' : 'disabled'}>+</button></span></div>`;
      }
    }
    html += '</div>';
  }
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
}

/** Which companies' route lists you've opened or folded (otherwise: open while short). */
const routesOpen = new Map<number, boolean>();
const ROUTES_FOLD_AT = 5;

// Panel buttons (delegated, since the panels re-render). They act on press rather than click:
// a panel can re-render between press and release, which would swallow a click.
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.side button');
  if (!b || b.disabled) return;
  const obs = session.obs();
  if (b.dataset.pin) {
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
    const n = obs.routes.filter((r) => r.company === c).length;
    routesOpen.set(c, !(routesOpen.get(c) ?? n <= ROUTES_FOLD_AT));
  } else if (b.dataset.route || b.dataset.unroute) {
    const key = (b.dataset.route ?? b.dataset.unroute)!;
    const r = obs.routes.find((x) => x.key === key);
    if (!r) return;
    session.act({ type: b.dataset.route ? 'assignRoute' : 'unassignRoute', depot: r.depot, producer: r.producer, consumer: r.consumer });
    activeCompany = r.company;
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
    : `<div class="pay-title">Dividends paid</div><div class="pay-rows"><span>${watching ? 'Player 1 holds' : 'You hold'} no shares that paid this time.</span></div>`;
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
const GUIDE: { img?: string[]; icons?: GuideIcons; title: string; text: string }[] = [
  {
    img: ['overview'],
    title: 'Welcome to Signature Required!',
    text: `<p>You're an <b>investor</b> in a busy little town. Trucking companies haul goods from producers to shops, and you <span class="hl">buy shares in them</span>. Every delivery fills their dividend pots, and the pots get paid out to shareholders. After 15 minutes, the <b>richest player wins</b>.</p>
      <p>The next pages show you how to:</p>
      <ol class="guide-list"><li>take control of a company</li><li>set up a route: producer, factory, shop</li><li>run your routes from the sidebar</li><li>buy more factories</li><li>get paid</li></ol>
      <p class="muted small">Or <a href="#" id="watch-bots">just watch the bots play</a> for a while. To play with friends, use <b>Play online</b> at the top.</p>`,
  },
  {
    img: ['auction'],
    title: 'Take control of a company!',
    text: `<p>The game opens with a <b>sale</b> of one share of each company: <span class="hl">bid in its card</span> along the bottom, and the highest bid gets it. Whoever holds the most shares of a company <span class="hl">controls it</span>: they're its president and run its trucks. You're an investor, not the company, so spread your bets across several if you like.</p>
      <p>Your bid goes <b>straight into the company</b>. That's how companies pay for trucks and factories, so a share won for next to nothing leaves your company with nothing to build with. Bid like you mean it!</p>`,
  },
  {
    img: ['route-1'],
    icons: 'producers',
    title: 'Pick a producer!',
    text: '<p>Click a <b>producer</b>: the round buildings that make raw materials. It gets a ring, and the hint at the bottom of the map tells you what to pick next.</p>',
  },
  {
    img: ['route-2'],
    icons: 'shops',
    title: 'Then a shop that buys the final product!',
    text: "<p>Now click a <b>shop</b> that sells what your producer's material becomes: <span class=\"hl\">timber → furniture, wheat → bread, crude oil → fuel</span>.</p><p>Shops with a gold <b>$</b> coin are premium: they pay half as much again for each pallet.</p>",
  },
  {
    img: ['route-3'],
    icons: 'chain',
    title: 'The route is now in!',
    text: "<p>Off it goes! A truck picks up the raw material, takes it through your company's <b>factory</b> to be made into the product, delivers it to the shop, and goes round again. <span class=\"hl\">Every delivery earns money</span>. The number on the route is how many trucks run it.</p>",
  },
  {
    img: ['sidebar'],
    title: 'Run your routes from the sidebar!',
    text: "<p>Your companies panel lists each company's routes. <b>+</b> puts another truck on a route and <b>−</b> takes one off. Hover over a row to light up its route on the map. If no truck is free, use <b>Buy truck</b>: more trucks, more deliveries.</p><p>On the map, you can also click a route to add a truck, or right-click it to take one off.</p>",
  },
  {
    img: ['factory'],
    title: 'Unclaimed factories!',
    text: `<p>The white factories are <b>unclaimed</b>: any company can buy one, at full price $${session.cfg.depots.depotBase}. But a company that <span class="hl">serves the producers and shops nearby</span> gets a discount, up to ${Math.round(100 * session.cfg.depots.maxSubsidy)}% off.</p><p>Hover over a site, or over a company card, to see how close each company is. A <b>★</b> means the full discount.${session.cfg.depots.newSiteEverySec > 0 ? ' New sites turn up every few minutes in the parts of town no factory reaches.' : ''}</p>`,
  },
  {
    img: ['buy'],
    title: 'Buy another factory!',
    text: `<p>Each factory lets your company run <b>${session.cfg.depots.capacity} more trucks</b> and opens up routes near it. When your company is at its truck limit, or you want to move into another part of town, buy one: in your company's card, click <b>Pick on map…</b>. The sites you can afford light up with your price. Click one and <span class="hl">start sending trucks from it</span>.</p>`,
  },
  {
    img: ['shares', 'company'],
    title: 'Get paid!',
    text: "<p>Half of each delivery goes to the company and half to its <b>dividend pot</b>, which is <span class=\"hl\">paid to shareholders every 3 minutes</span>. Your shares and your next payout show at the top right.</p><p>Shares trade in the <b>company cards</b>: <b>Sell for</b> and <b>Buy for</b> trade at once, and hovering a card lets you place your own price, or <b>start a sale</b> of the company's own shares to raise money. Late on, a company with cash <span class=\"hl\">buys shares back</span>. After 15 minutes, the richest player wins. Good luck!</p>",
  },
];

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
  ov.innerHTML = `<div class="card help wide"><div class="guide-step">
    ${st.img ? `<div class="guide-imgs">${st.img.map((i) => `<img src="${base}guide/${i}.webp" alt="">`).join('')}</div>` : ''}
    ${st.icons ? guideIcons(st.icons) : ''}
    <h2>${step > 0 ? `${step}. ` : ''}${st.title}</h2>${st.text}
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
  ov.querySelector<HTMLElement>('#btn-close')?.addEventListener('click', close);
  ov.querySelector<HTMLElement>('#btn-skip')?.addEventListener('click', close);
  ov.querySelector<HTMLElement>('#watch-bots')?.addEventListener('click', (e) => {
    e.preventDefault();
    helpWasPaused = null;
    newGame(true);
  });
}
/** Whether the game was paused before the help card opened (kept while flipping its pages). */
let helpWasPaused: boolean | null = null;

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
  // Ease drawn truck positions towards where they are (smooth between ticks, and into queues).
  const targets = renderer.truckTargets(obs);
  const k = 1 - Math.exp(-dt * 14);
  // Pulling into (or up) a line at a building, or out of one: straight there at the truck's own speed.
  const parkStep = session.cfg.trucks.speed * dt * (session.paused ? 0 : session.speed);
  for (const [id, t] of targets) {
    const s = shown.get(id);
    const gap = s ? Math.hypot(s.x - t.x, s.y - t.y) : Infinity;
    if (!s || gap > 3) {
      shown.set(id, { ...t });
      continue;
    }
    if (t.parked || s.parked) {
      // Pulling out, it catches up with where it really is on the road (which is moving away).
      const step = t.parked ? parkStep : parkStep * 1.5;
      if (gap <= step) shown.set(id, { ...t, parked: t.parked });
      else {
        const f = step / gap;
        // Lined up along its street the whole way, rather than turning to face the next spot.
        // (Pulling out, it already faces the way it'll drive.)
        const along = { dx: t.dx, dy: t.dy };
        shown.set(id, { x: s.x + (t.x - s.x) * f, y: s.y + (t.y - s.y) * f, ...along, parked: true });
      }
      continue;
    }
    shown.set(id, { x: s.x + (t.x - s.x) * k, y: s.y + (t.y - s.y) * k, dx: t.dx, dy: t.dy });
  }

  tooltip(obs);
  hl.spotlight = obs.sales.length ? obs.sales[0].company : null;
  hl.meterFor = obs.companies.map((c) => c.id); // public: everyone sees every company's progress
  const trucksNow = [...targets.keys()].map((id) => ({ id, ...shown.get(id)! }));
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
  renderer.setTown(session.game.town);
  renderer.via = session.cfg.trucks.viaDepot;
  renderer.serviceSec = session.cfg.trucks.serviceSec;
  renderer.processSec = session.cfg.trucks.signOffSec;
  renderer.palletPrice = session.cfg.money.palletPrice;
  renderer.resize(true);
  viewMoved = false;
  logList.innerHTML = '';
  $('overlay').hidden = true;
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
  if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
    e.preventDefault();
    togglePause();
  } else if (e.key === 'Escape') {
    hl.picked = [];
    hl.buyFor = null;
  }
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
else if (!watching) showHelp();

// For poking at a running match from the browser console.
(window as unknown as { sr: unknown }).sr = {
  get session() {
    return session;
  },
  renderer,
  hl,
};
