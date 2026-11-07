/**
 * Browser-to-browser multiplayer (the same approach as Bored of Pizza). The host's tab runs the
 * authoritative game; other players connect to it over WebRTC data channels (PeerJS). A free
 * public PeerJS server only introduces the browsers to each other; game traffic then flows
 * directly between them. Everything in the game is public, so each guest simply gets the host's
 * view of the game for their seat, ten times a second.
 */
import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { clearToLot, Game, openOnLot, type Action, type GameConfig, type GameConfigOverrides, type GameEvent, type Observation } from '@sr/core';
import type { Match } from './match.js';
import { Session } from './session.js';

const ID_PREFIX = 'signature-required-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** How often the host sends each player a fresh view of the game (per second). */
const SEND_HZ = 10;
/** Both sides ping every PING_SEC; silence for DROP_SEC means the other side is gone. */
const PING_SEC = 2;
const DROP_SEC = 10;

export interface LobbyPlayer {
  seat: number;
  name: string;
  host: boolean;
}

/** Messages host → guest. */
type HostMsg =
  | { t: 'welcome'; seat: number }
  | { t: 'lobby'; players: LobbyPlayer[] }
  | { t: 'start'; seat: number; names: string[]; cfg: GameConfig }
  | { t: 'obs'; obs: Observation; events: GameEvent[]; paused: boolean }
  | { t: 'notice'; text: string }
  | { t: 'full' }
  | { t: 'ping' };

/** Messages guest → host. */
type GuestMsg = { t: 'hello'; name: string } | { t: 'act'; action: Action } | { t: 'ping' };

/** Optional local PeerJS server for testing: ?peerHost=localhost&peerPort=9000&peerPath=/ */
function peerOptions(): PeerOptions {
  const q = new URLSearchParams(location.search);
  const host = q.get('peerHost');
  if (!host) return { debug: 1 };
  return { host, port: Number(q.get('peerPort') ?? 9000), path: q.get('peerPath') ?? '/', secure: q.get('peerSecure') === '1', debug: 1 };
}

function randomCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

export function normalizeCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A smaller view to send: trucks only need the next step of their path (for their heading). */
function slim(o: Observation): Observation {
  return { ...o, trucks: o.trucks.map((t) => ({ ...t, path: t.path.slice(0, 1) })) };
}

// ------------------------------------------------------------------ host

export class HostLobby {
  code = '';
  private peer: Peer | null = null;
  private guests = new Map<number, { conn: DataConnection; name: string }>();
  private heard = new Map<DataConnection, number>();
  private timer: number | undefined;
  private started = false;
  onChange: () => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor(
    private hostName: string,
    private maxPlayers = 4,
  ) {}

  /** Claim a room code on the PeerJS server (retries if the code is taken). */
  open(): Promise<string> {
    return new Promise((resolve, reject) => {
      const tryCode = (attempt: number) => {
        const code = randomCode();
        const peer = new Peer(ID_PREFIX + code, peerOptions());
        peer.on('open', () => {
          this.peer = peer;
          this.code = code;
          peer.on('connection', (conn) => this.accept(conn));
          this.timer = window.setInterval(() => this.heartbeat(), PING_SEC * 1000);
          resolve(code);
        });
        peer.on('error', (err: Error & { type?: string }) => {
          if (err.type === 'unavailable-id' && attempt < 5) {
            peer.destroy();
            tryCode(attempt + 1);
          } else if (!this.peer) reject(new Error(friendlyError(err)));
          else this.onError(friendlyError(err));
        });
      };
      tryCode(0);
    });
  }

  get players(): LobbyPlayer[] {
    return [{ seat: 0, name: this.hostName, host: true }, ...[...this.guests].map(([seat, g]) => ({ seat, name: g.name, host: false }))];
  }

  private heartbeat() {
    const now = performance.now();
    for (const [seat, g] of this.guests) {
      if (now - (this.heard.get(g.conn) ?? now) > DROP_SEC * 1000) {
        this.guests.delete(seat);
        g.conn.close();
        this.broadcastLobby();
      } else g.conn.send({ t: 'ping' } satisfies HostMsg);
    }
  }

  private accept(conn: DataConnection) {
    conn.on('data', (raw) => {
      const msg = raw as GuestMsg;
      this.heard.set(conn, performance.now());
      if (msg.t !== 'hello') return;
      const taken = new Set([0, ...this.guests.keys()]);
      const seat = Array.from({ length: this.maxPlayers }, (_, s) => s).find((s) => !taken.has(s));
      if (seat === undefined || this.started) {
        conn.send({ t: 'full' } satisfies HostMsg);
        setTimeout(() => conn.close(), 200);
        return;
      }
      this.guests.set(seat, { conn, name: (msg.name || 'Guest').slice(0, 16) });
      conn.send({ t: 'welcome', seat } satisfies HostMsg);
      this.broadcastLobby();
    });
    conn.on('close', () => {
      for (const [seat, g] of this.guests) if (g.conn === conn) this.guests.delete(seat);
      if (!this.started) this.broadcastLobby();
    });
  }

  private broadcastLobby() {
    const msg: HostMsg = { t: 'lobby', players: this.players };
    for (const g of this.guests.values()) g.conn.send(msg);
    this.onChange();
  }

  /** Start the match: people keep their seats, bots fill the rest. */
  start(overrides: GameConfigOverrides): HostMatch {
    this.started = true;
    window.clearInterval(this.timer);
    const players = Math.max(overrides.players ?? 4, 1 + Math.max(0, ...this.guests.keys()));
    const names = Array.from({ length: players }, (_, s) => (s === 0 ? this.hostName : this.guests.get(s)?.name ?? ''));
    const session = new Session({ overrides: { ...overrides, players }, seat: 0, remote: [...this.guests.keys()], names });
    const conns = new Map([...this.guests].map(([seat, g]) => [seat, g.conn]));
    return new HostMatch(session, conns, this.peer!, this.heard);
  }

  close() {
    window.clearInterval(this.timer);
    for (const g of this.guests.values()) g.conn.close();
    this.peer?.destroy();
  }
}

/** The host's match: the local session, plus sending each guest their view and taking their moves. */
export class HostMatch implements Match {
  readonly multiplayer = true;
  readonly canControlTime = true;
  readonly watch = false;
  private sinceSend = 0;
  /** Things to tell the host (players leaving). */
  notices: string[] = [];

  constructor(
    readonly session: Session,
    private conns: Map<number, DataConnection>,
    private peer: Peer,
    private heard: Map<DataConnection, number>,
  ) {
    // A backgrounded host tab gets throttled; let it catch up in bigger steps.
    session.maxStepSec = 1.5;
    for (const [seat, conn] of conns) {
      conn.send({ t: 'start', seat, names: session.names, cfg: session.cfg } satisfies HostMsg);
      this.heard.set(conn, performance.now());
      conn.on('data', (raw) => {
        this.heard.set(conn, performance.now());
        const msg = raw as GuestMsg;
        if (msg.t === 'act') this.session.actAs(seat, msg.action);
      });
      conn.on('close', () => this.dropped(seat));
    }
  }

  get game() {
    return this.session.game;
  }
  get cfg() {
    return this.session.cfg;
  }
  get seat() {
    return this.session.seat;
  }
  get names() {
    return this.session.names;
  }
  get done() {
    return this.session.done;
  }
  get paused() {
    return this.session.paused;
  }
  set paused(v: boolean) {
    this.session.paused = v;
  }
  get speed() {
    return 1;
  }
  set speed(_v: number) {
    // Fixed at 1× in multiplayer.
  }

  private dropped(seat: number) {
    const conn = this.conns.get(seat);
    if (!conn) return;
    this.conns.delete(seat); // before closing: closing fires 'close', which lands back here
    conn.close();
    const name = this.session.names[seat] || 'A player';
    this.session.replaceWithBot(seat);
    const text = `${name} left. A bot plays their seat now.`;
    this.notices.push(text);
    this.broadcast({ t: 'notice', text });
  }

  private broadcast(msg: HostMsg) {
    for (const c of this.conns.values()) c.send(msg);
  }

  update(realDt: number) {
    this.session.update(realDt);
    const now = performance.now();
    for (const [seat, conn] of this.conns) if (now - (this.heard.get(conn) ?? now) > DROP_SEC * 1000) this.dropped(seat);
    this.sinceSend += realDt;
    if (this.sinceSend >= 1 / SEND_HZ || this.session.done) {
      this.sinceSend = 0;
      for (const [seat, conn] of this.conns)
        conn.send({ t: 'obs', obs: slim(this.session.game.observe(seat)), events: this.session.takePending(seat), paused: this.session.paused } satisfies HostMsg);
    }
  }

  takeEvents() {
    return this.session.takeEvents();
  }
  obs() {
    return this.session.obs();
  }

  get renderT() {
    return this.session.renderT;
  }
  act(action: Action) {
    this.session.act(action);
  }

  dispose() {
    for (const c of this.conns.values()) c.close();
    setTimeout(() => this.peer.destroy(), 300);
  }
}

// ------------------------------------------------------------------ guest

export class GuestLobby {
  seat = -1;
  players: LobbyPlayer[] = [];
  onChange: () => void = () => {};
  onStart: (m: RemoteMatch) => void = () => {};
  onError: (msg: string) => void = () => {};
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private match: RemoteMatch | null = null;
  private lastHeard = performance.now();
  private timer: number | undefined;

  join(code: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      this.peer = peer;
      let settled = false;
      const fail = (msg: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(msg));
        } else this.onError(msg);
      };
      peer.on('error', (err: Error & { type?: string }) => fail(friendlyError(err)));
      peer.on('open', () => {
        const conn = peer.connect(ID_PREFIX + normalizeCode(code), { reliable: true, serialization: 'json' });
        this.conn = conn;
        const timer = setTimeout(() => fail("Couldn't reach that room. Check the code, or the host's network may block direct connections."), 12000);
        conn.on('open', () => {
          conn.send({ t: 'hello', name } satisfies GuestMsg);
          this.lastHeard = performance.now();
          this.timer = window.setInterval(() => {
            if (performance.now() - this.lastHeard > DROP_SEC * 1000) {
              window.clearInterval(this.timer);
              conn.close();
              if (this.match) this.match.hostLeft();
              else fail('Lost the connection to the host.');
            } else conn.send({ t: 'ping' } satisfies GuestMsg);
          }, PING_SEC * 1000);
        });
        conn.on('data', (raw) => {
          const msg = raw as HostMsg;
          this.lastHeard = performance.now();
          if (msg.t === 'ping') return;
          if (msg.t === 'full') fail('That room is full or already playing.');
          else if (msg.t === 'welcome') {
            clearTimeout(timer);
            this.seat = msg.seat;
            settled = true;
            resolve();
          } else if (msg.t === 'lobby') {
            this.players = msg.players;
            this.onChange();
          } else if (msg.t === 'start') {
            this.match = new RemoteMatch(conn, peer, msg.seat, msg.names, msg.cfg);
            this.onStart(this.match);
          } else this.match?.receive(msg);
        });
        conn.on('close', () => {
          window.clearInterval(this.timer);
          if (this.match) this.match.hostLeft();
          else fail('The host closed the room.');
        });
      });
    });
  }

  close() {
    window.clearInterval(this.timer);
    this.conn?.close();
    this.peer?.destroy();
  }
}

/** A guest's match: the latest view from the host, and moves sent back. */
export class RemoteMatch implements Match {
  readonly multiplayer = true;
  readonly canControlTime = false;
  readonly watch = false;
  /** A local copy of the game that never runs: it gives the town (kept in step) and the config. */
  readonly game: Game;
  paused = false;
  speed = 1;
  private latest: Observation | null = null;
  private events: GameEvent[] = [];
  notices: string[] = [];
  lostHost = false;

  constructor(
    private conn: DataConnection,
    private peer: Peer,
    readonly seat: number,
    readonly names: string[],
    readonly cfg: GameConfig,
  ) {
    this.game = new Game(cfg);
  }

  receive(msg: HostMsg) {
    if (msg.t === 'obs') {
      // Businesses opening and closing change the town: mirror them on the local copy.
      for (const e of msg.events) {
        if (e.type === 'opened' && this.game.town.locations[e.location]?.kind === 'lot') openOnLot(this.game.town, e.location, e.kind, e.good);
        if (e.type === 'siteOpened') {
          const l = this.game.town.locations[e.site];
          if (l) Object.assign(l, { kind: 'depot', good: null, level: 1, bays: 0, startCompany: null });
        }
        if (e.type === 'closed') {
          const l = this.game.town.locations[e.location];
          if (l && (l.kind === 'producer' || l.kind === 'consumer')) clearToLot(this.game.town, e.location);
        }
      }
      this.latest = msg.obs;
      this.latestAt = performance.now();
      this.paused = msg.paused;
      this.events.push(...msg.events);
    } else if (msg.t === 'notice') this.notices.push(msg.text);
  }

  hostLeft() {
    if (this.done) return;
    this.lostHost = true;
    this.notices.push('The host left, so the game has ended.');
  }

  get done() {
    return this.latest?.phase === 'ended' || this.lostHost;
  }

  /** When the latest view arrived (performance.now()), to run trucks on smoothly until the next. */
  private latestAt = 0;

  update() {}

  get renderT(): number {
    const o = this.obs();
    if (o.phase !== 'running' || this.paused) return o.t;
    // Updates come ten times a second: carry on for up to a little longer than that.
    return o.t + Math.min(0.15, (performance.now() - this.latestAt) / 1000);
  }

  takeEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  obs(): Observation {
    // Before the first update arrives: the untouched local copy.
    return this.latest ?? this.game.observe(this.seat);
  }

  act(action: Action) {
    if (this.done) return;
    this.conn.send({ t: 'act', action } satisfies GuestMsg);
  }

  dispose() {
    this.conn.close();
    setTimeout(() => this.peer.destroy(), 300);
  }
}

function friendlyError(err: Error & { type?: string }) {
  switch (err.type) {
    case 'peer-unavailable':
      return 'No room with that code. Check the code and try again.';
    case 'network':
    case 'server-error':
    case 'socket-error':
      return "Couldn't reach the matchmaking server. Check your internet connection.";
    case 'browser-incompatible':
      return "This browser doesn't support peer-to-peer connections.";
    default:
      return err.message || 'Connection error.';
  }
}
