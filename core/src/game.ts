/**
 * The authoritative game. Advances in fixed ticks; players change it only through actions,
 * which are queued and applied at the start of the next tick in the order they arrived.
 * Same config + same actions at the same ticks = same game, every time.
 */
import { makeGameConfig, type GameConfig, type GameConfigOverrides } from './config.js';
import { initLocations, updateCycles, type CycleEvent, type LocationState } from './economy.js';
import { Rng } from './rng.js';
import { TruckSystem, validateOrders, type Stop, type Truck, type TruckEvent } from './trucks.js';
import { generateTown, type Town } from './town.js';

// ------------------------------------------------------------------ state

export interface Player {
  id: number;
  cash: number;
}

export interface Company {
  id: number;
  treasury: number;
  /** Owner (player id) of each share, or null while the bank still holds it. */
  shares: (number | null)[];
}

export type Phase = 'running' | 'ended';

// ------------------------------------------------------------------ actions & events

/**
 * Everything a player can do. Later issues add their actions here (truck orders, purchases,
 * location investment...). `noop` exists so the plumbing can be tested on its own.
 */
export type Action =
  | { type: 'noop' }
  /** Replace a truck's repeating orders (presidents of the truck's company only). */
  | { type: 'setOrders'; truck: number; stops: Stop[] };

export interface QueuedAction {
  player: number;
  action: Action;
}

export type GameEvent =
  | CycleEvent
  | TruckEvent
  | { type: 'start'; t: number }
  | { type: 'end'; t: number }
  | { type: 'rejected'; t: number; action: Action; reason: string };

/** Who an event is for: everyone, or one player. */
type Audience = 'all' | number;

// ------------------------------------------------------------------ observation

/** What a player sees. The game is fully transparent, so this is the whole dynamic state. */
export interface Observation {
  me: number;
  tick: number;
  t: number;
  timeLeft: number;
  phase: Phase;
  players: Player[];
  companies: (Company & { presidents: number[] })[];
  /** Producers and consumers: stock, demand, level, growth, next cycle. */
  locations: LocationState[];
  trucks: (Truck & { x: number; y: number })[];
  /** Trucks queued or loading at each location (location id -> truck ids, in arrival order). */
  queues: Record<number, number[]>;
}

// ------------------------------------------------------------------ game

export class Game {
  readonly cfg: GameConfig;
  /** The map. Static for now (issue #12 may change that), so it isn't copied into observations. */
  readonly town: Town;
  tick = 0;
  phase: Phase = 'running';
  readonly players: Player[];
  readonly companies: Company[];
  /** Dynamic state of every producer and consumer (depot sites aren't included). */
  readonly locations: LocationState[];
  readonly trucks: TruckSystem;
  /** Location state by town location id. */
  private locById = new Map<number, LocationState>();
  /** Every action ever applied, with the tick it took effect: enough to replay the game. */
  readonly actionLog: { tick: number; player: number; action: Action }[] = [];
  private queue: QueuedAction[] = [];
  private events: GameEvent[][];
  /** Game-time randomness (separate from the town generator, so map and play don't interfere). */
  readonly rng: Rng;

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
    if (cfg.players < 1) throw new Error('need at least one player');
    if (cfg.companies < cfg.players) throw new Error('need at least one company per player');
    this.town = generateTown(cfg.town);
    this.rng = new Rng(cfg.seed * 2654435761 + 17);
    this.players = Array.from({ length: cfg.players }, (_, id) => ({ id, cash: cfg.startingCash }));
    // Every company starts fully owned by the bank, with an empty treasury: shares are sold at
    // auction (pre-game, then during play), and that money is what gets companies going.
    this.companies = Array.from({ length: cfg.companies }, (_, id) => ({
      id,
      treasury: cfg.startingTreasury,
      shares: Array.from({ length: cfg.sharesPerCompany }, () => null),
    }));
    this.locations = initLocations(this.town.locations, cfg.cycles, this.rng);
    for (const l of this.locations) this.locById.set(l.id, l);
    this.trucks = new TruckSystem(
      this.town.graph,
      cfg.trucks,
      (id) => this.locById.get(id),
      (id) => this.town.locations[id].node,
      (e) => this.emit('all', e),
    );
    this.events = Array.from({ length: cfg.players }, () => []);
    this.emit('all', { type: 'start', t: 0 });
  }

  get t() {
    return this.tick * this.cfg.tickSec;
  }

  get totalTicks() {
    return Math.round(this.cfg.durationSec / this.cfg.tickSec);
  }

  get done() {
    return this.phase === 'ended';
  }

  /** Queue an action; it takes effect at the start of the next step. */
  act(player: number, action: Action) {
    if (player < 0 || player >= this.players.length) throw new Error(`no player ${player}`);
    this.queue.push({ player, action });
  }

  /** Advance one tick. */
  step() {
    if (this.done) return;
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) this.apply(q);

    for (const e of updateCycles(this.locations, this.t, this.cfg.cycles, this.rng)) this.emit('all', e);
    this.trucks.update(this.t, this.cfg.tickSec, (id) => this.town.locations[id].bays);
    // (Issues #6–#7 add depots and money here.)

    this.tick++;
    if (this.tick >= this.totalTicks) {
      this.phase = 'ended';
      this.emit('all', { type: 'end', t: this.t });
    }
  }

  /** Advance until the game ends (or a tick limit), for headless runs. */
  runToEnd(maxTicks = Infinity) {
    let n = 0;
    while (!this.done && n++ < maxTicks) this.step();
  }

  private apply({ player, action }: QueuedAction) {
    const reject = (reason: string) => this.emit(player, { type: 'rejected', t: this.t, action, reason });
    if (this.done) return reject('game over');
    switch (action.type) {
      case 'noop':
        break;
      case 'setOrders': {
        const truck = this.trucks.trucks[action.truck];
        if (!truck) return reject(`no truck ${action.truck}`);
        if (!this.presidents(truck.company).includes(player)) return reject('only a president of this company can give its trucks orders');
        const why = validateOrders(action.stops, (id) => this.town.locations[id]?.kind, this.town.graph.nodes.length);
        if (why) return reject(why);
        this.trucks.setOrders(truck, action.stops.map((st) => ({ ...st, via: st.via ? [...st.via] : undefined })), this.t);
        break;
      }
      default:
        return reject(`unknown action ${(action as { type: string }).type}`);
    }
    this.actionLog.push({ tick: this.tick, player, action });
  }

  private emit(to: Audience, e: GameEvent) {
    if (to === 'all') for (const q of this.events) q.push(e);
    else this.events[to].push(e);
  }

  /** Events for a player since the last call. */
  drainEvents(player: number): GameEvent[] {
    const out = this.events[player];
    this.events[player] = [];
    return out;
  }

  /** Put a new truck at a company's starting depot (no cost or capacity checks yet; see #6). */
  addTruck(company: number): Truck {
    const depot = this.town.locations.find((l) => l.startCompany === company);
    if (!depot) throw new Error(`company ${company} has no starting depot`);
    return this.trucks.add(company, depot.node);
  }

  /** Dynamic state of a producer or consumer, by its town location id. */
  location(id: number): LocationState | undefined {
    return this.locById.get(id);
  }

  /** Players holding the most shares of a company (more than one means co-presidents). */
  presidents(company: number): number[] {
    const counts = new Map<number, number>();
    for (const owner of this.companies[company].shares) if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    const max = Math.max(0, ...counts.values());
    return [...counts].filter(([, n]) => n === max && max > 0).map(([p]) => p).sort((a, b) => a - b);
  }

  observe(player: number): Observation {
    return {
      me: player,
      tick: this.tick,
      t: this.t,
      timeLeft: Math.max(0, this.cfg.durationSec - this.t),
      phase: this.phase,
      players: this.players.map((p) => ({ ...p })),
      companies: this.companies.map((c) => ({ ...c, shares: [...c.shares], presidents: this.presidents(c.id) })),
      locations: this.locations.map((l) => ({ ...l, history: [...l.history] })),
      trucks: this.trucks.trucks.map((t) => ({
        ...t,
        route: [...t.route],
        orders: t.orders.map((o) => ({ ...o, via: o.via ? [...o.via] : undefined })),
        cargo: t.cargo ? { ...t.cargo } : null,
        pendingOrders: t.pendingOrders ? [...t.pendingOrders] : null,
        ...this.trucks.position(t),
      })),
      queues: Object.fromEntries([...this.trucks.queues].map(([k, v]) => [k, [...v]])),
    };
  }

  /** Short fingerprint of the full dynamic state, for checking two runs match. */
  stateHash(): string {
    const s = JSON.stringify({
      tick: this.tick,
      phase: this.phase,
      players: this.players,
      companies: this.companies,
      locations: this.locations,
      trucks: this.trucks.trucks,
      queues: [...this.trucks.queues].sort((a, b) => a[0] - b[0]),
    });
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

/** Convenience: a new game from config overrides. */
export function newGame(o: GameConfigOverrides = {}): Game {
  return new Game(makeGameConfig(o));
}

/** Replay a game from its config and action log; should land on the same state. */
export function replay(cfg: GameConfig, log: { tick: number; player: number; action: Action }[]): Game {
  const g = new Game(cfg);
  let i = 0;
  while (!g.done) {
    // Actions logged at tick k were queued during tick k-1, i.e. before step() k ran.
    while (i < log.length && log[i].tick === g.tick) {
      g.act(log[i].player, log[i].action);
      i++;
    }
    g.step();
  }
  return g;
}
