/**
 * The client: a solo game against bots in real time.
 *
 * - The town, trucks and routes are drawn by render.ts; drag to pan, scroll to zoom.
 * - Routes (#33): click a producer and a consumer of the same good (and optionally one of your
 *   depots first) to send a free truck on that route. Click a route line to add a truck, right-click
 *   it to take one off. Esc or right-click on the map clears the selection.
 * - Company panel (#34): treasury, fleet, depots and routes for companies you run; buy trucks and
 *   depots (affordable sites light up on the map with your price).
 * - Auction panel (#35): bid on the running auction; presidents can put bank-held shares up.
 */
import { distancesFrom, minimumBid, type GameEvent, type Location, type Observation } from '@sr/core';
import { Renderer, companyColor, coordOf, goodColor, type Highlights } from './render.js';
import { Session } from './session.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (x: number) => `$${Math.floor(x + 1e-9)}`;
/** A pallet price, to the cent. */
const cents = (x: number) => `$${x.toFixed(2)}`;
/** Names for a good: its raw material, product, producer and consumer. */
const names = (good: number) => {
  const t = session.cfg.town;
  return { raw: t.raws[good], product: t.goods[good], source: t.sources[good], shop: t.shops[good] };
};
const coName = (c: number) => `Company ${c + 1}`;
const playerName = (p: number, me: number) => (p === me ? 'you' : `player ${p + 1}`);
const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Rule options from the page address, for trying settings out: ?via=none (direct routes, no
 * factory stop) or ?via=hub (the factory on both legs). The default is the loaded leg.
 */
function overridesFromUrl() {
  const via = new URLSearchParams(location.search).get('via');
  if (via === 'none' || via === 'loaded' || via === 'hub') return { trucks: { viaDepot: via } } as const;
  return {};
}

let session = new Session({ overrides: overridesFromUrl() });
const renderer = new Renderer($<HTMLCanvasElement>('map'), session.game.town);
renderer.via = session.cfg.trucks.viaDepot;
let last = performance.now();
let lastUi = 0;

// ------------------------------------------------------------------ selection and input state

const hl: Highlights = { hover: null, picked: [], hoverRoute: null, buyFor: null };
/** Company the player last acted for (route clicks default to it). */
let activeCompany: number | null = null;
/** Smoothed on-screen truck positions (town coordinates). */
const shown = new Map<number, { x: number; y: number; dx: number; dy: number }>();
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
  if (hl.buyFor !== null) {
    hint.textContent = `Buying a factory for ${coName(hl.buyFor)}: click a highlighted site (Esc to cancel).`;
    return;
  }
  if (obs.phase === 'opening') {
    hint.textContent = 'Opening round: bid for shares on the right. The president of a company runs it.';
    return;
  }
  const picks = hl.picked.map((id) => g.town.locations[id]);
  const p = picks.find((l) => l.kind === 'producer');
  const c = picks.find((l) => l.kind === 'consumer');
  if (p && !c) hint.textContent = `${cap(names(p.good!).source)} picked: now a ${names(p.good!).shop} to sell the ${names(p.good!).product} to.`;
  else if (c && !p) hint.textContent = `${cap(names(c.good!).shop)} picked: now a ${names(c.good!).source} to supply it.`;
  else if (picks.length) hint.textContent = 'Factory picked: now a producer and a shop.';
  else if (myCompanies(obs).length === 0) hint.textContent = 'You run no company yet: win a share auction to become a president.';
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
  if (obs.phase === 'opening' && l && l.kind !== 'lot') return toast('Routes open when the clock starts, after the opening auctions.', 'info');
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
    if (owner === undefined) return toast('A free factory site. Buy it from the company panel.', 'info');
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
  },
  { passive: false },
);
canvas.addEventListener('dblclick', () => renderer.fit());

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
  if (l && (l.kind === 'producer' || l.kind === 'consumer')) {
    const s = obs.locations.find((x) => x.id === l.id);
    if (s) {
      const n = names(s.good);
      const recent = s.history.length ? Math.round((100 * s.history.reduce((a, b) => a + b, 0)) / s.history.length) : null;
      html = `<b>${cap(s.kind === 'producer' ? n.source : n.shop)} ${at(l.id)}</b> · level ${s.level}/${g.cfg.cycles.maxLevel}`;
      html +=
        s.kind === 'producer'
          ? `<div>${s.stock} load${s.stock === 1 ? '' : 's'} of ${n.raw} waiting · ${s.cycleAmount} per cycle</div><div class="muted">A factory turns it into ${n.product}</div>`
          : `<div>Wants ${s.demand} more ${n.product} · pays ${cents(s.price)} a pallet${s.price > g.cfg.money.palletPrice ? ' (premium)' : ''}</div>`;
      html += `<div class="muted">Next cycle in ${fmtClock(s.nextCycleAt - obs.t)}${recent !== null ? ` · ${recent}% served lately` : ''}</div>`;
      if (s.closingIn !== null) html += `<div class="bad">Closing in ${s.closingIn} cycle${s.closingIn === 1 ? '' : 's'} unless served</div>`;
      const servers = [...new Set(obs.routes.filter((r) => r.producer === l.id || r.consumer === l.id).map((r) => r.company))];
      if (servers.length) html += `<div class="muted">Served by ${servers.map(coName).join(', ')}</div>`;
    }
  } else if (l && l.kind === 'depot') {
    const owner = obs.depots[l.id];
    if (owner === undefined) {
      html = `<b>Free factory site ${at(l.id)}</b>`;
      const prices = obs.depotPrices[l.id];
      for (const c of myCompanies(obs)) html += `<div>${coName(c)} would pay ${money(prices[c])}${prices[c] < g.cfg.depots.depotBase ? ' (local subsidy)' : ''}</div>`;
      if (!myCompanies(obs).length) html += `<div class="muted">Full price ${money(g.cfg.depots.depotBase)}, less a subsidy for companies serving the area.</div>`;
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
  const x = Math.min(mouse.x + 16, wrap.width - tip.offsetWidth - 8);
  const y = Math.min(mouse.y + 16, wrap.height - tip.offsetHeight - 8);
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
      ? 'Opening auctions: one share of each company, before the clock starts'
      : obs.phase === 'ended'
        ? 'Game over'
        : `Next payout in ${fmtClock(obs.nextPayoutAt - obs.t)}`;

  // You: cash and shares.
  let html = `<div class="row big"><span>Cash</span><b>${money(me.cash)}</b></div>`;
  if (me.held) html += `<div class="row muted"><span>Held for your bid</span><span>${money(me.held)}</span></div>`;
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
          return `<span class="holding">${sw(c.id)}${c.id + 1}×${n}${c.presidents.includes(p.id) ? '<span class="tag">P</span>' : ''}</span>`;
        })
        .join(' ');
      return `<div class="co"><div class="row"><span><b>Player ${p.id + 1}</b></span><span>${money(p.cash)}</span></div><div class="small">${shares || '<span class="muted">No shares</span>'}</div></div>`;
    })
    .join('');

  // Companies: everyone's at a glance.
  $('companies').innerHTML = obs.companies
    .map((c) => {
      const trucks = obs.trucks.filter((t) => t.company === c.id).length;
      const depots = Object.values(obs.depots).filter((o) => o === c.id).length;
      const owners = c.shares.map((s) => (s === null ? '·' : s === obs.me ? '<b>Y</b>' : `${s + 1}`)).join(' ');
      return `<div class="co"><div class="row"><span>${sw(c.id)}<b>${coName(c.id)}</b></span><span>${money(c.treasury)}</span></div><div class="row muted small"><span>${trucks} trucks · ${depots} factor${depots === 1 ? 'y' : 'ies'} · ${obs.routes.filter((r) => r.company === c.id).length} routes</span><span title="Share owners (Y = you, · = bank)">${owners}</span></div><div class="row muted small"><span>Next dividend</span><span>${money(c.dividendPerShare)}/share</span></div></div>`;
    })
    .join('');

  refreshAuction(obs);
  refreshMyCompanies(obs);
  updateHint(obs);
  void g;
}

const sw = (c: number) => `<span class="swatch" style="background:${companyColor(c)}"></span>`;

function refreshAuction(obs: Observation) {
  const g = session.game;
  const a = obs.auction;
  const me = obs.players[obs.me];
  const box = $('auction');
  let html = '';
  if (a) {
    const leading = a.highBidder === obs.me;
    html += `<div class="row big"><span>${sw(a.company)}${coName(a.company)}</span><b>${Math.ceil(a.timeLeft)}s</b></div>`;
    html += `<div class="row muted small"><span>Selling</span><span>${a.seller === null ? 'a bank share' : `a share from ${playerName(a.seller, obs.me)}`}</span></div>`;
    html += `<div class="row"><span>High bid</span><span>${a.highBidder === null ? 'none yet' : `${money(a.highBid)} (${playerName(a.highBidder, obs.me)})`}</span></div>`;
    const c = obs.companies[a.company];
    html += `<div class="row muted small"><span>Treasury · trucks</span><span>${money(c.treasury)} · ${obs.trucks.filter((t) => t.company === c.id).length}</span></div>`;
    if (leading) html += '<div class="good small">You’re the high bidder.</div>';
  } else html += '<div class="muted small">No auction running.</div>';
  if (obs.auctionQueue.length) html += `<div class="muted small">Next up: ${obs.auctionQueue.map((r) => coName(r.company)).join(', ')}</div>`;
  // Presidents can put a bank share up.
  if (obs.phase === 'running') {
    for (const id of myCompanies(obs)) {
      const c = obs.companies[id];
      const bank = c.shares.filter((s) => s === null).length;
      const queued = (a && a.company === id) || obs.auctionQueue.some((r) => r.company === id);
      const cooldown = obs.auctionCooldownUntil[id] - obs.elapsed;
      if (bank && !queued)
        html += `<div class="row small"><span>${sw(id)}${coName(id)}: ${bank} bank share${bank === 1 ? '' : 's'}</span><button data-auction="${id}" ${cooldown > 0 ? 'disabled' : ''}>${cooldown > 0 ? `wait ${Math.ceil(cooldown)}s` : 'Auction one'}</button></div>`;
    }
  }
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
  // The bid row stays put (it isn't re-rendered), so adjusting or typing isn't interrupted. The
  // amount starts at the minimum for each new auction and never sits below it.
  const form = $<HTMLFormElement>('bid-custom');
  form.hidden = !a || a.highBidder === obs.me;
  if (a) {
    const min = minimumBid(a, g.cfg.auctions);
    const input = $<HTMLInputElement>('bid-amount');
    const fresh = form.dataset.auction !== `${a.company}:${obs.auctionQueue.length}` && document.activeElement !== input;
    if (fresh) form.dataset.auction = `${a.company}:${obs.auctionQueue.length}`;
    input.min = String(min);
    if (document.activeElement !== input && (fresh || !(Number(input.value) >= min))) input.value = String(min);
    const spendable = me.cash - me.held;
    $<HTMLButtonElement>('bid-go').disabled = Number(input.value) > spendable;
    $<HTMLButtonElement>('bid-down').disabled = Number(input.value) - 5 < min;
    $<HTMLButtonElement>('bid-up').disabled = Number(input.value) + 5 > spendable;
  }
}

$('bid-down').addEventListener('click', () => {
  const input = $<HTMLInputElement>('bid-amount');
  input.value = String(Math.max(Number(input.min), Math.floor(Number(input.value)) - 5));
  refreshAuction(session.obs());
});
$('bid-up').addEventListener('click', () => {
  const input = $<HTMLInputElement>('bid-amount');
  input.value = String(Math.floor(Number(input.value) || Number(input.min)) + 5);
  refreshAuction(session.obs());
});

// A bid of any amount: you may want to put more into a company than the minimum.
$<HTMLFormElement>('bid-custom').addEventListener('submit', (e) => {
  e.preventDefault();
  const obs = session.obs();
  const a = obs.auction;
  const input = $<HTMLInputElement>('bid-amount');
  const amount = Math.floor(Number(input.value));
  if (!a || !Number.isFinite(amount)) return;
  const min = minimumBid(a, session.cfg.auctions);
  const me = obs.players[obs.me];
  const spendable = me.cash - me.held;
  if (amount < min) return toast(`The lowest bid now is ${money(min)}.`, 'error');
  if (amount > spendable) return toast(`You have ${money(spendable)} to bid with.`, 'error');
  session.act({ type: 'bid', company: a.company, amount });
  input.blur();
});

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
    html += `<div class="co${currentCompany(obs) === id ? ' active' : ''}" data-company="${id}"><div class="row big"><span>${sw(id)}<b>${coName(id)}</b></span><b>${money(c.treasury)}</b></div>`;
    const full = trucks.length >= limit;
    const canPay = c.treasury >= g.cfg.depots.truckPrice;
    const home = Object.entries(obs.depots).find(([, o]) => o === id)?.[0];
    html += `<div class="row small"><span>${trucks.length}/${limit} trucks: ${free} free</span>${home === undefined ? '' : `<button data-truck="${id}:${home}" ${full || !canPay ? 'disabled' : ''} title="${full ? `Fleet full: each factory adds ${g.cfg.depots.capacity}` : canPay ? '' : 'Not enough in the treasury'}">Buy truck ${money(g.cfg.depots.truckPrice)}</button>`}</div>`;
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
    } else html += '<div class="row small muted"><span>No free factory sites left</span></div>';
    const routes = obs.routes.filter((r) => r.company === id);
    if (routes.length) {
      html += '<div class="sub">Routes</div>';
      for (const r of routes) {
        const p = g.town.locations[r.producer];
        html += `<div class="row small"><span><span class="dot" style="background:${goodColor(p.good!)}"></span>${cap(names(p.good!).product)} ${at(r.producer)} → ${at(r.depot)} → ${at(r.consumer)}</span><span><button data-unroute="${r.key}">−</button> ${r.trucks} <button data-route="${r.key}" ${freeTrucks(obs, id) ? '' : 'disabled'}>+</button></span></div>`;
      }
    }
    html += '</div>';
  }
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
}

// Panel buttons (delegated, since the panels re-render). They act on press rather than click:
// a panel can re-render between press and release, which would swallow a click.
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.side button');
  if (!b || b.disabled) return;
  const obs = session.obs();
  if (b.dataset.bid) {
    session.act({ type: 'bid', company: obs.auction!.company, amount: Number(b.dataset.bid) });
  } else if (b.dataset.auction) {
    const id = Number(b.dataset.auction);
    session.act({ type: 'startAuction', company: id });
    activeCompany = id;
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

function handleEvents(evs: GameEvent[]) {
  const obs = session.obs();
  const g = session.game;
  const mine = new Set(myCompanies(obs));
  const ol = $('log');
  for (const e of evs) {
    let text: string | null = null;
    let cls = '';
    if (e.type === 'rejected') {
      toast(cap(e.reason) + '.', 'error');
      continue;
    }
    if (e.type === 'auctionWon') text = `${cap(playerName(e.player, obs.me))} bought a share of ${coName(e.company)} for ${money(e.amount)}`;
    else if (e.type === 'payout' && e.paid[session.seat]) {
      text = `Dividend from ${coName(e.company)}: ${money(e.paid[session.seat])}${e.final ? ' (final)' : ''}`;
      cls = 'good';
    } else if (e.type === 'opened') text = `A ${e.kind === 'producer' ? names(e.good).source : names(e.good).shop} opened`;
    else if (e.type === 'closed') {
      text = 'A business closed';
      cls = 'bad';
    } else if (e.type === 'closing') {
      text = 'A business is about to close: serve it to save it';
      cls = 'bad';
    } else if (e.type === 'boughtDepot') text = `${coName(e.company)} bought a factory for ${money(e.price)}`;
    else if (e.type === 'end') text = 'Game over';
    if (!text) continue;
    const li = document.createElement('li');
    li.textContent = `${obs.phase === 'opening' ? '' : `${fmtClock(g.cfg.durationSec - e.t)} `}${text}`;
    if (cls) li.className = cls;
    ol.prepend(li);
  }
  while (ol.children.length > 120) ol.lastChild!.remove();
}

// ------------------------------------------------------------------ end screen

let shownEnd = false;
function endScreen(obs: Observation) {
  if (obs.phase !== 'ended' || shownEnd) return;
  shownEnd = true;
  const ranking = [...obs.players].sort((a, b) => b.cash - a.cash);
  const rows = ranking
    .map((p, i) => `<tr class="${p.id === obs.me ? 'me' : ''}"><td>${i + 1}</td><td>${p.id === obs.me ? 'You' : `Player ${p.id + 1}`}</td><td>${money(p.cash)}</td></tr>`)
    .join('');
  const place = ranking.findIndex((p) => p.id === obs.me) + 1;
  const ov = $('overlay');
  ov.innerHTML = `<div class="card"><h1>${place === 1 ? 'You win!' : `You finished ${ordinal(place)}`}</h1><table>${rows}</table><button id="btn-again">Play again</button></div>`;
  ov.hidden = false;
  $('btn-again').onclick = newGame;
}
const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;

function showHelp() {
  const ov = $('overlay');
  ov.innerHTML = `<div class="card help"><h1>How to play</h1>
  <p>You're an investor. Buy shares of trucking companies at auction; whoever holds the most shares of a company is its president and runs it. Every 3 minutes each company pays its dividend to its shareholders. After 15 minutes, the richest player wins.</p>
  <ul>
  <li><b>Routes:</b> click a <b>producer</b> (round: sawmill, farm or oil well) and a <b>shop</b> (house) of the same good. A free truck picks up the raw material, takes it through your company's factory to be made into product, and delivers it to the shop. Click a route line to add a truck; right-click it to take one off.</li>
  <li><b>Factories:</b> every load goes through one, so where your factories are decides which routes pay. Each factory also adds ${session.cfg.depots.capacity} to your truck limit. A factory site is cheaper where your company already does business.</li>
  <li><b>Businesses</b> grow when served well (dots under each one show its level) and close if neglected (flashing red).</li>
  <li><b>Map:</b> drag to pan, scroll to zoom, double-click to fit. P or Space pauses.</li>
  </ul><button id="btn-close">Got it</button></div>`;
  ov.hidden = false;
  const wasPaused = session.paused;
  session.paused = true;
  $('btn-close').onclick = () => {
    ov.hidden = true;
    session.paused = wasPaused;
  };
}

// ------------------------------------------------------------------ loop and controls

function frame(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  session.update(dt);
  const obs = session.obs();
  handleEvents(session.takeEvents());
  // Ease drawn truck positions towards where they are (smooth between ticks, and into queues).
  const targets = renderer.truckTargets(obs);
  const k = 1 - Math.exp(-dt * 14);
  for (const [id, t] of targets) {
    const s = shown.get(id);
    if (!s || Math.hypot(s.x - t.x, s.y - t.y) > 3) shown.set(id, { ...t });
    else shown.set(id, { x: s.x + (t.x - s.x) * k, y: s.y + (t.y - s.y) * k, dx: t.dx, dy: t.dy });
  }
  tooltip(obs);
  renderer.draw(
    obs,
    [...targets.keys()].map((id) => ({ id, ...shown.get(id)! })),
    hl,
    now / 1000,
  );
  if (now - lastUi > 250) {
    lastUi = now;
    refreshPanels(obs);
  }
  endScreen(obs);
  requestAnimationFrame(frame);
}

function togglePause() {
  session.paused = !session.paused;
  $('btn-pause').textContent = session.paused ? '▶' : '⏸';
}

function newGame() {
  session = new Session({ overrides: overridesFromUrl() });
  session.speed = Number($<HTMLSelectElement>('speed').value);
  renderer.setTown(session.game.town);
  renderer.via = session.cfg.trucks.viaDepot;
  renderer.resize(true);
  $('log').innerHTML = '';
  $('overlay').hidden = true;
  shown.clear();
  reachCache.clear();
  hl.picked = [];
  hl.buyFor = null;
  activeCompany = null;
  shownEnd = false;
}

$('btn-pause').onclick = togglePause;
$('btn-help').onclick = showHelp;
$<HTMLSelectElement>('speed').onchange = (e) => (session.speed = Number((e.target as HTMLSelectElement).value));
$('btn-new').onclick = newGame;
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
showHelp();

// For poking at a running match from the browser console.
(window as unknown as { sr: unknown }).sr = {
  get session() {
    return session;
  },
  renderer,
};
