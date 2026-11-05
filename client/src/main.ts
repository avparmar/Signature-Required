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
import { Renderer, companyColor, goodColor, type Highlights } from './render.js';
import { Session } from './session.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (x: number) => `$${Math.floor(x + 1e-9)}`;
const coName = (c: number) => `Company ${c + 1}`;
const playerName = (p: number, me: number) => (p === me ? 'you' : `player ${p + 1}`);
const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let session = new Session();
const renderer = new Renderer($<HTMLCanvasElement>('map'), session.game.town);
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
    hint.textContent = `Buying a depot for ${coName(hl.buyFor)}: click a highlighted site (Esc to cancel).`;
    return;
  }
  if (obs.phase === 'opening') {
    hint.textContent = 'Opening round: bid for shares on the right. The president of a company runs it.';
    return;
  }
  const picks = hl.picked.map((id) => g.town.locations[id]);
  const p = picks.find((l) => l.kind === 'producer');
  const c = picks.find((l) => l.kind === 'consumer');
  const goods = g.cfg.town.goods;
  if (p && !c) hint.textContent = `Now click a ${goods[p.good!]} consumer (house) to send a truck.`;
  else if (c && !p) hint.textContent = `Now click a ${goods[c.good!]} producer (factory) to send a truck.`;
  else if (picks.length) hint.textContent = 'Depot picked: now a producer and a consumer.';
  else if (myCompanies(obs).length === 0) hint.textContent = 'You run no company yet: win a share auction to become a president.';
  else hint.textContent = 'Click a producer and a consumer of the same good to send a truck. Right-click a route to take one off.';
}

// ------------------------------------------------------------------ routes from clicks

function tryAssign(obs: Observation) {
  const g = session.game;
  const picks = hl.picked.map((id) => g.town.locations[id]);
  const p = picks.find((l) => l.kind === 'producer');
  const c = picks.find((l) => l.kind === 'consumer');
  if (!p || !c) return;
  if (p.good !== c.good) {
    toast(`That ${g.cfg.town.goods[c.good!]} consumer doesn't take ${g.cfg.town.goods[p.good!]}.`, 'error');
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
  const depot = pickedDepot ? pickedDepot.id : bestDepot(obs, company, p);
  if (depot === null) {
    toast(`${coName(company)} has no free truck. Buy one in the company panel.`, 'error');
    return;
  }
  session.act({ type: 'assignRoute', depot, producer: p.id, consumer: c.id });
  activeCompany = company;
  hl.picked = [];
}

/** The company's depot with a free truck nearest the producer (by road), or null. */
function bestDepot(obs: Observation, company: number, producer: Location): number | null {
  const g = session.game;
  const d = distancesFrom(g.town.graph, producer.node);
  let best: number | null = null;
  for (const [site, owner] of Object.entries(obs.depots)) {
    if (owner !== company) continue;
    const id = Number(site);
    if (freeTrucks(obs, id) === 0) continue;
    if (best === null || d[g.town.locations[id].node] < d[g.town.locations[best].node]) best = id;
  }
  return best;
}

const freeTrucks = (obs: Observation, depot: number) =>
  obs.trucks.filter((t) => t.depot === depot && t.route === null && t.state === 'idle').length;

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
    } else toast('Click a free (dashed) depot site, or Esc to cancel.', 'error');
    return;
  }
  if (obs.phase === 'opening' && l && l.kind !== 'lot') return toast('Routes open when the clock starts, after the opening auctions.', 'info');
  if (obs.phase !== 'running') return;
  if (route && !l) {
    if (!obs.companies[route.company].presidents.includes(obs.me)) return toast(`That route belongs to ${coName(route.company)}.`, 'error');
    if (freeTrucks(obs, route.depot) === 0) return toast('No free truck at that route’s depot.', 'error');
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
    if (owner === undefined) return toast('A free depot site. Buy it from the company panel.', 'info');
    if (!obs.companies[owner].presidents.includes(obs.me)) return toast(`That depot belongs to ${coName(owner)}.`, 'error');
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
  const goods = g.cfg.town.goods;
  if (l && (l.kind === 'producer' || l.kind === 'consumer')) {
    const s = obs.locations.find((x) => x.id === l.id);
    if (s) {
      const good = goods[s.good];
      const recent = s.history.length ? Math.round((100 * s.history.reduce((a, b) => a + b, 0)) / s.history.length) : null;
      html = `<b>${cap(good)} ${s.kind === 'producer' ? 'producer' : 'consumer'}</b> · level ${s.level}/${g.cfg.cycles.maxLevel}`;
      html +=
        s.kind === 'producer'
          ? `<div>${s.stock} pallet${s.stock === 1 ? '' : 's'} waiting · makes ${s.cycleAmount} per cycle</div>`
          : `<div>Wants ${s.demand} more · pays ${money(s.price)} a pallet${s.price > g.cfg.money.palletPrice ? ' (premium)' : ''}</div>`;
      html += `<div class="muted">Next cycle in ${fmtClock(s.nextCycleAt - obs.t)}${recent !== null ? ` · ${recent}% served lately` : ''}</div>`;
      if (s.closingIn !== null) html += `<div class="bad">Closing in ${s.closingIn} cycle${s.closingIn === 1 ? '' : 's'} unless served</div>`;
      const servers = [...new Set(obs.routes.filter((r) => r.producer === l.id || r.consumer === l.id).map((r) => r.company))];
      if (servers.length) html += `<div class="muted">Served by ${servers.map(coName).join(', ')}</div>`;
    }
  } else if (l && l.kind === 'depot') {
    const owner = obs.depots[l.id];
    if (owner === undefined) {
      html = '<b>Free depot site</b>';
      const prices = obs.depotPrices[l.id];
      for (const c of myCompanies(obs)) html += `<div>${coName(c)} would pay ${money(prices[c])}${prices[c] < g.cfg.depots.depotBase ? ' (local subsidy)' : ''}</div>`;
      if (!myCompanies(obs).length) html += `<div class="muted">Full price ${money(g.cfg.depots.depotBase)}, less a subsidy for companies serving the area.</div>`;
    } else {
      const n = obs.trucks.filter((t) => t.depot === l.id).length;
      html = `<b>${coName(owner)} depot</b><div>${n}/${g.cfg.depots.capacity} trucks · ${freeTrucks(obs, l.id)} free</div>`;
    }
  } else if (l && l.kind === 'lot') {
    html = '<span class="muted">Empty lot: a business may open here.</span>';
  } else if (route) {
    const p = g.town.locations[route.producer];
    html = `<b>${coName(route.company)}</b> · ${goods[p.good!]} route · ${route.trucks} truck${route.trucks === 1 ? '' : 's'}`;
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

  // Companies: everyone's at a glance.
  $('companies').innerHTML = obs.companies
    .map((c) => {
      const trucks = obs.trucks.filter((t) => t.company === c.id).length;
      const depots = Object.values(obs.depots).filter((o) => o === c.id).length;
      const owners = c.shares.map((s) => (s === null ? '·' : s === obs.me ? '<b>Y</b>' : `${s + 1}`)).join(' ');
      return `<div class="co"><div class="row"><span>${sw(c.id)}<b>${coName(c.id)}</b></span><span>${money(c.treasury)}</span></div><div class="row muted small"><span>${trucks} trucks · ${depots} depot${depots === 1 ? '' : 's'} · ${obs.routes.filter((r) => r.company === c.id).length} routes</span><span title="Share owners (Y = you, · = bank)">${owners}</span></div><div class="row muted small"><span>Next dividend</span><span>${money(c.dividendPerShare)}/share</span></div></div>`;
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
    const min = minimumBid(a, g.cfg.auctions);
    const leading = a.highBidder === obs.me;
    html += `<div class="row big"><span>${sw(a.company)}${coName(a.company)}</span><b>${Math.ceil(a.timeLeft)}s</b></div>`;
    html += `<div class="row muted small"><span>Selling</span><span>${a.seller === null ? 'a bank share' : `a share from ${playerName(a.seller, obs.me)}`}</span></div>`;
    html += `<div class="row"><span>High bid</span><span>${a.highBidder === null ? 'none yet' : `${money(a.highBid)} (${playerName(a.highBidder, obs.me)})`}</span></div>`;
    const c = obs.companies[a.company];
    html += `<div class="row muted small"><span>Treasury · trucks</span><span>${money(c.treasury)} · ${obs.trucks.filter((t) => t.company === c.id).length}</span></div>`;
    if (leading) html += '<div class="good small">You’re the high bidder.</div>';
    const spendable = me.cash - me.held + (leading ? a.highBid : 0);
    html += `<div class="bidrow"><button data-bid="${min}" ${spendable < min || leading ? 'disabled' : ''}>Bid ${money(min)}</button><button data-bid="${min + 5}" ${spendable < min + 5 || leading ? 'disabled' : ''}>${money(min + 5)}</button><button data-bid="${min + 20}" ${spendable < min + 20 || leading ? 'disabled' : ''}>${money(min + 20)}</button></div>`;
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
    const free = trucks.filter((t) => t.route === null && t.state === 'idle').length;
    const broken = trucks.filter((t) => t.state === 'broken' || t.limping).length;
    const servicing = trucks.filter((t) => t.state === 'repairing' || (t.toService && !t.limping)).length;
    html += `<div class="co${currentCompany(obs) === id ? ' active' : ''}" data-company="${id}"><div class="row big"><span>${sw(id)}<b>${coName(id)}</b></span><b>${money(c.treasury)}</b></div>`;
    html += `<div class="row small muted"><span>${trucks.length} trucks: ${free} free, ${trucks.length - free} on routes</span><span>${broken ? `<span class="bad">${broken} broken</span> ` : ''}${servicing ? `${servicing} servicing` : ''}</span></div>`;
    for (const [site, owner] of Object.entries(obs.depots)) {
      if (owner !== id) continue;
      const s = Number(site);
      const n = trucks.filter((t) => t.depot === s).length;
      const full = n >= g.cfg.depots.capacity;
      const canPay = c.treasury >= g.cfg.depots.truckPrice;
      html += `<div class="row small"><span>Depot ${s}: ${n}/${g.cfg.depots.capacity} trucks, ${freeTrucks(obs, s)} free</span><button data-truck="${id}:${s}" ${full || !canPay ? 'disabled' : ''} title="${full ? 'Depot full' : canPay ? '' : 'Not enough in the treasury'}">Buy truck ${money(g.cfg.depots.truckPrice)}</button></div>`;
    }
    const prices = Object.values(obs.depotPrices).map((p) => p[id]);
    const cheapest = prices.length ? Math.min(...prices) : null;
    html += `<div class="row small"><span>${cheapest === null ? 'No free depot sites left' : `Free depot sites from ${money(cheapest)}`}</span>${cheapest === null ? '' : `<button data-depot="${id}" class="${hl.buyFor === id ? 'on' : ''}">${hl.buyFor === id ? 'Cancel' : 'Buy depot…'}</button>`}</div>`;
    const routes = obs.routes.filter((r) => r.company === id);
    if (routes.length) {
      html += '<div class="sub">Routes</div>';
      for (const r of routes) {
        const p = g.town.locations[r.producer];
        html += `<div class="row small"><span><span class="dot" style="background:${goodColor(p.good!)}"></span>${g.cfg.town.goods[p.good!]} ${r.producer}→${r.consumer} (depot ${r.depot})</span><span><button data-unroute="${r.key}">−</button> ${r.trucks} <button data-route="${r.key}" ${freeTrucks(obs, r.depot) ? '' : 'disabled'}>+</button></span></div>`;
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
    } else if (e.type === 'opened') text = `A ${g.cfg.town.goods[e.good]} ${e.kind} opened`;
    else if (e.type === 'closed') {
      text = 'A business closed';
      cls = 'bad';
    } else if (e.type === 'closing') {
      text = 'A business is about to close: serve it to save it';
      cls = 'bad';
    } else if (e.type === 'brokeDown' && mine.has(e.company)) {
      text = `A ${coName(e.company)} truck broke down`;
      cls = 'bad';
    } else if (e.type === 'boughtDepot') text = `${coName(e.company)} bought a depot for ${money(e.price)}`;
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
  <li><b>Routes:</b> click a <b>producer</b> (round factory) and a <b>consumer</b> (house) of the same good. A free truck from your nearest depot starts carrying pallets between them. Click a route line to add a truck; right-click it to take one off.</li>
  <li><b>Trucks and depots:</b> buy trucks and depots in <i>Your companies</i>. A depot site is cheaper where your company already does business.</li>
  <li><b>Wear:</b> trucks wear out faster far from your depots; they service themselves at the nearest one and can break down if worn.</li>
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
  session = new Session();
  session.speed = Number($<HTMLSelectElement>('speed').value);
  renderer.setTown(session.game.town);
  renderer.resize(true);
  $('log').innerHTML = '';
  $('overlay').hidden = true;
  shown.clear();
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
