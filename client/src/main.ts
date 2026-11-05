/**
 * Client shell: runs a solo game against bots in real time, with pause and speed, and a plain
 * debug drawing of the town. Proper rendering is #31 (town) and #32 (trucks); panels follow.
 */
import type { GameEvent, Observation } from '@sr/core';
import { Session } from './session.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const COMPANY_COLORS = ['#c8553d', '#2a7ab0', '#e0a526', '#3f8f5a', '#7b5ea7'];
const GOOD_COLORS = ['#f2f2f2', '#d9a15b', '#6b6b6b'];

let session = new Session();
let last = performance.now();
let lastUi = 0;

// ------------------------------------------------------------------ drawing (debug for now)

const canvas = $<HTMLCanvasElement>('map');
const ctx = canvas.getContext('2d')!;
let scale = 30;
let pad = 14;

function resize() {
  const wrap = $('map-wrap');
  const { blocksX, blocksY } = session.cfg.town;
  const size = Math.min(wrap.clientWidth - 16, wrap.clientHeight - 16);
  scale = Math.max(8, (size - 2 * pad) / Math.max(blocksX, blocksY));
  const dpr = window.devicePixelRatio || 1;
  const w = blocksX * scale + 2 * pad;
  const h = blocksY * scale + 2 * pad;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const X = (x: number) => pad + x * scale;
const Y = (y: number) => pad + y * scale;

function draw(obs: Observation) {
  const g = session.game;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Roads.
  ctx.strokeStyle = '#d6cfc0';
  ctx.lineWidth = Math.max(2, scale * 0.12);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const e of g.town.graph.edges) {
    const a = g.town.graph.nodes[e.a];
    const b = g.town.graph.nodes[e.b];
    ctx.moveTo(X(a.x), Y(a.y));
    ctx.lineTo(X(b.x), Y(b.y));
  }
  ctx.stroke();
  // Locations.
  const r = Math.max(3, scale * 0.22);
  for (const l of g.town.locations) {
    if (l.kind === 'lot') continue;
    ctx.beginPath();
    if (l.kind === 'depot') {
      const owner = obs.depots[l.id];
      ctx.fillStyle = owner === undefined ? '#ffffff' : COMPANY_COLORS[owner % COMPANY_COLORS.length];
      ctx.strokeStyle = '#23201b';
      ctx.lineWidth = 1.5;
      ctx.rect(X(l.x) - r, Y(l.y) - r, 2 * r, 2 * r);
    } else {
      ctx.fillStyle = GOOD_COLORS[l.good!];
      ctx.strokeStyle = l.kind === 'producer' ? '#23201b' : '#8a8273';
      ctx.lineWidth = l.kind === 'producer' ? 2.5 : 1.5;
      ctx.arc(X(l.x), Y(l.y), r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }
  // Trucks.
  const tr = Math.max(2, scale * 0.12);
  for (const t of obs.trucks) {
    ctx.beginPath();
    ctx.fillStyle = COMPANY_COLORS[t.company % COMPANY_COLORS.length];
    ctx.arc(X(t.x), Y(t.y), tr, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ panels (minimal for now)

const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function refreshPanels(obs: Observation) {
  const me = obs.players[obs.me];
  $('clock').textContent = obs.phase === 'opening' ? 'Opening' : fmtClock(obs.timeLeft);
  $('phase').textContent =
    obs.phase === 'opening'
      ? 'Opening auctions: one share of each company'
      : obs.phase === 'ended'
        ? 'Game over'
        : `Next payout in ${fmtClock(obs.nextPayoutAt - obs.t)}`;
  $('me').innerHTML = `<div class="row"><span>Cash</span><b>$${me.cash.toFixed(0)}</b></div>${
    me.held ? `<div class="row muted"><span>Held for your bid</span><span>$${me.held.toFixed(0)}</span></div>` : ''
  }`;
  $('companies').innerHTML = obs.companies
    .map((c) => {
      const mine = c.shares.filter((s) => s === obs.me).length;
      const trucks = obs.trucks.filter((t) => t.company === c.id).length;
      return `<div class="row"><span><span class="swatch" style="background:${COMPANY_COLORS[c.id % COMPANY_COLORS.length]}"></span>Company ${c.id + 1}</span><span class="muted">${trucks} trucks · $${c.treasury.toFixed(0)} · ${mine}/5 yours</span></div>`;
    })
    .join('');
  const a = obs.auction;
  $('auction').innerHTML = a
    ? `<div class="row"><span>Company ${a.company + 1}</span><span>${a.timeLeft.toFixed(0)}s</span></div><div class="row muted"><span>High bid</span><span>${a.highBidder === null ? 'none' : `$${a.highBid} (${a.highBidder === obs.me ? 'you' : `player ${a.highBidder + 1}`})`}</span></div>`
    : '<span class="muted">No auction running.</span>';
}

function log(evs: GameEvent[]) {
  const ol = $('log');
  for (const e of evs) {
    let text: string | null = null;
    if (e.type === 'auctionWon') text = `Player ${e.player + 1} bought a share of company ${e.company + 1} for $${e.amount}`;
    else if (e.type === 'payout' && e.paid[session.seat]) text = `Dividend from company ${e.company + 1}: $${e.paid[session.seat].toFixed(2)}`;
    else if (e.type === 'opened') text = `A ${session.cfg.town.goods[e.good]} ${e.kind} opened`;
    else if (e.type === 'closed') text = `A location closed`;
    else if (e.type === 'end') text = 'Game over';
    if (!text) continue;
    const li = document.createElement('li');
    li.textContent = text;
    ol.prepend(li);
  }
  while (ol.children.length > 100) ol.lastChild!.remove();
}

// ------------------------------------------------------------------ loop and controls

function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  session.update(dt);
  const obs = session.obs();
  log(session.takeEvents());
  draw(obs);
  if (now - lastUi > 200) {
    lastUi = now;
    refreshPanels(obs);
  }
  requestAnimationFrame(frame);
}

function togglePause() {
  session.paused = !session.paused;
  $('btn-pause').textContent = session.paused ? '▶' : '⏸';
}

$('btn-pause').onclick = togglePause;
$<HTMLSelectElement>('speed').onchange = (e) => (session.speed = Number((e.target as HTMLSelectElement).value));
$('btn-new').onclick = () => {
  session = new Session();
  session.speed = Number($<HTMLSelectElement>('speed').value);
  $('log').innerHTML = '';
  resize();
};
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
    e.preventDefault();
    togglePause();
  }
});
window.addEventListener('resize', resize);

resize();
requestAnimationFrame(frame);

// For poking at a running match from the browser console.
(window as unknown as { sr: unknown }).sr = {
  get session() {
    return session;
  },
};
