/**
 * The authoritative game. Advances in fixed ticks; players change it only through actions,
 * which are queued and applied at the start of the next tick in the order they arrived.
 * Same config + same actions at the same ticks = same game, every time.
 */
import { makeGameConfig, type GameConfig, type GameConfigOverrides } from './config.js';
import { minimumBid, type Auction, type AuctionEvent, type AuctionRequest } from './auctions.js';
import { depotPrice, distanceToNetwork } from './depots.js';
import { assignPrices, investCost, payPerShare } from './money.js';
import { initLocations, updateCycles, type CycleEvent, type LocationState } from './economy.js';
import { Rng } from './rng.js';
import { TruckSystem, validateOrders, type Stop, type Truck, type TruckEvent } from './trucks.js';
import { generateTown, type Town } from './town.js';

// ------------------------------------------------------------------ state

export interface Player {
  id: number;
  cash: number;
  /** Part of `cash` held for this player's leading bid (can't be spent until released). */
  held: number;
}

export interface Company {
  id: number;
  treasury: number;
  /** Money waiting for the next dividend payout. */
  pot: number;
  /** What the company has spent on trucks and depots (counts towards the final payout). */
  assets: number;
  /** Owner (player id) of each share, or null while the bank still holds it. */
  shares: (number | null)[];
}

/** opening: the opening share auctions, before the game clock starts. */
export type Phase = 'opening' | 'running' | 'ended';

// ------------------------------------------------------------------ actions & events

/**
 * Everything a player can do. Later issues add their actions here (truck orders, purchases,
 * location investment...). `noop` exists so the plumbing can be tested on its own.
 */
export type Action =
  | { type: 'noop' }
  /** Replace a truck's repeating orders (presidents of the truck's company only). */
  | { type: 'setOrders'; truck: number; stops: Stop[] }
  /** Buy a truck for a company, based at one of its depots (presidents only; from the treasury). */
  | { type: 'buyTruck'; company: number; depot: number }
  /** Buy a free depot site for a company (presidents only; from the treasury). */
  | { type: 'buyDepot'; company: number; site: number }
  /** Pay (from your own cash) to raise a producer or consumer one level. Anyone may. */
  | { type: 'invest'; location: number }
  /** Bid on the current auction (company must match, so a late bid can't land on the next one). */
  | { type: 'bid'; company: number; amount: number }
  /**
   * Put a share up for auction: a bank-held share (presidents only), or, once all of a company's
   * shares are out, one of your own. Queues if another auction is running.
   */
  | { type: 'startAuction'; company: number };

export interface QueuedAction {
  player: number;
  action: Action;
}

export type GameEvent =
  | CycleEvent
  | TruckEvent
  | AuctionEvent
  | { type: 'open'; t: number }
  | { type: 'start'; t: number }
  | { type: 'boughtTruck'; t: number; company: number; truck: number; depot: number; price: number }
  | { type: 'boughtDepot'; t: number; company: number; site: number; price: number }
  | { type: 'invested'; t: number; player: number; location: number; level: number; price: number }
  | {
      type: 'payout';
      t: number;
      company: number;
      /** Dividend paid per share from the pot. */
      perShare: number;
      /** Final payout only: the end-of-game bonus paid per share. */
      bonusPerShare: number;
      final: boolean;
      /** What each shareholder received (player id -> amount). */
      paid: Record<number, number>;
    }
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
  /** Seconds since the very start, opening round included (auction cooldowns use this). */
  elapsed: number;
  timeLeft: number;
  phase: Phase;
  players: Player[];
  /** Companies, with the pot shown as dividend per share (what one share will get next payout). */
  companies: (Company & { presidents: number[]; dividendPerShare: number })[];
  /** Game time of the next dividend payout. */
  nextPayoutAt: number;
  /** Producers and consumers: stock, demand, level, growth, next cycle. */
  locations: LocationState[];
  trucks: (Truck & { x: number; y: number })[];
  /** Trucks queued or loading at each location (location id -> truck ids, in arrival order). */
  queues: Record<number, number[]>;
  /** Owner company of each depot site (site location id -> company); free sites are absent. */
  depots: Record<number, number>;
  /** The auction running now, if any. */
  auction: Auction | null;
  /** Auctions waiting to start, in order. */
  auctionQueue: AuctionRequest[];
  /** Earliest time (seconds since the start, opening round included) each company may auction again. */
  auctionCooldownUntil: number[];
}

// ------------------------------------------------------------------ game

export class Game {
  readonly cfg: GameConfig;
  /** The map. Static for now (issue #12 may change that), so it isn't copied into observations. */
  readonly town: Town;
  /** Game-clock ticks (the 15 minutes). Doesn't advance during the opening round. */
  tick = 0;
  /** Every step taken, opening round included. */
  steps = 0;
  phase: Phase;
  auction: Auction | null = null;
  readonly auctionQueue: AuctionRequest[] = [];
  readonly auctionCooldownUntil: number[];
  /** Next company to auction in the opening round. */
  private openingNext = 0;
  readonly players: Player[];
  readonly companies: Company[];
  /** Dynamic state of every producer and consumer (depot sites aren't included). */
  readonly locations: LocationState[];
  readonly trucks: TruckSystem;
  /** Which company owns each depot site (site location id -> company). */
  readonly depotOwner = new Map<number, number>();
  /** Location state by town location id. */
  private locById = new Map<number, LocationState>();
  /** Every action ever applied, with the tick it took effect: enough to replay the game. */
  readonly actionLog: LoggedAction[] = [];
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
    this.players = Array.from({ length: cfg.players }, (_, id) => ({ id, cash: cfg.startingCash, held: 0 }));
    // Every company starts fully owned by the bank, with an empty treasury: shares are sold at
    // auction (pre-game, then during play), and that money is what gets companies going.
    this.companies = Array.from({ length: cfg.companies }, (_, id) => ({
      id,
      treasury: cfg.startingTreasury,
      pot: 0,
      assets: 0,
      shares: Array.from({ length: cfg.sharesPerCompany }, () => null),
    }));
    this.locations = initLocations(this.town.locations, cfg.cycles, this.rng);
    for (const l of this.locations) this.locById.set(l.id, l);
    const prices = assignPrices(this.locations.filter((l) => l.kind === 'consumer').map((l) => l.id), cfg.money, this.rng);
    for (const [id, price] of prices) this.locById.get(id)!.price = price;
    for (const l of this.town.locations) if (l.startCompany !== null) this.depotOwner.set(l.id, l.startCompany);
    this.trucks = new TruckSystem(
      this.town.graph,
      cfg.trucks,
      (id) => this.locById.get(id),
      (id) => this.town.locations[id].node,
      (e) => {
        if (e.type === 'delivered') {
          // Every delivery pays the company now and adds the same amount to its next dividend.
          const c = this.companies[e.company];
          c.treasury += e.price * this.cfg.money.deliveryToTreasury;
          c.pot += e.price * this.cfg.money.deliveryToPot;
        }
        this.emit('all', e);
      },
    );
    this.events = Array.from({ length: cfg.players }, () => []);
    this.auctionCooldownUntil = this.companies.map(() => 0);
    this.phase = cfg.auctions.openingRound ? 'opening' : 'running';
    this.emit('all', { type: 'start', t: 0 });
    if (this.phase === 'running') this.emit('all', { type: 'open', t: 0 });
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

  /** Seconds since the very start, opening round included. */
  get elapsed() {
    return this.steps * this.cfg.tickSec;
  }

  /** Advance one tick. */
  step() {
    if (this.done) return;
    const queued = this.queue;
    this.queue = [];
    for (const q of queued) this.apply(q);
    this.steps++;
    this.updateAuctions();
    if (this.phase === 'opening') return; // the town waits until the opening round is over

    for (const e of updateCycles(this.locations, this.t, this.cfg.cycles, this.rng)) this.emit('all', e);
    this.trucks.update(this.t, this.cfg.tickSec, (id) => this.town.locations[id].bays);
    // (Issues #6–#7 add depots and money here.)

    this.tick++;
    const ending = this.tick >= this.totalTicks;
    if (ending || this.tick % this.payoutTicks === 0) this.payDividends(ending);
    if (ending) {
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
      case 'buyTruck': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!this.presidents(c.id).includes(player)) return reject('only a president can spend company money');
        if (this.depotOwner.get(action.depot) !== c.id) return reject('that depot belongs to someone else (or nobody)');
        if (this.trucksAt(action.depot) >= this.cfg.depots.capacity) return reject('that depot is full');
        const price = this.cfg.depots.truckPrice;
        if (c.treasury < price) return reject(`the treasury has $${c.treasury.toFixed(2)}; a truck costs $${price}`);
        c.treasury -= price;
        c.assets += price;
        const truck = this.trucks.add(c.id, action.depot, this.town.locations[action.depot].node);
        this.emit('all', { type: 'boughtTruck', t: this.t, company: c.id, truck: truck.id, depot: action.depot, price });
        break;
      }
      case 'buyDepot': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!this.presidents(c.id).includes(player)) return reject('only a president can spend company money');
        const site = this.town.locations[action.site];
        if (!site || site.kind !== 'depot') return reject(`no depot site ${action.site}`);
        if (this.depotOwner.has(site.id)) return reject('that site is already taken');
        const price = this.depotPriceFor(c.id, site.id);
        if (c.treasury < price) return reject(`the treasury has $${c.treasury.toFixed(2)}; this depot costs $${price}`);
        c.treasury -= price;
        c.assets += price;
        this.depotOwner.set(site.id, c.id);
        this.emit('all', { type: 'boughtDepot', t: this.t, company: c.id, site: site.id, price });
        break;
      }
      case 'invest': {
        const l = this.locById.get(action.location);
        if (!l) return reject(`no producer or consumer ${action.location}`);
        const price = investCost(this.cfg.money, l.level);
        const p = this.players[player];
        if (p.cash - p.held < price) return reject(`you have $${(p.cash - p.held).toFixed(2)} to spend; this costs $${price}`);
        p.cash -= price;
        l.level++;
        this.emit('all', { type: 'invested', t: this.t, player, location: l.id, level: l.level, price });
        break;
      }
      case 'bid': {
        const a = this.auction;
        if (!a || a.company !== action.company) return reject(`no auction for company ${action.company} right now`);
        if (a.seller === player) return reject("you can't bid on your own share");
        const min = minimumBid(a, this.cfg.auctions);
        if (!(action.amount >= min)) return reject(`the lowest bid now is $${min}`);
        const p = this.players[player];
        const available = p.cash - p.held + (a.highBidder === player ? a.highBid : 0);
        if (available < action.amount) return reject(`you only have $${available.toFixed(2)} to bid with`);
        if (a.highBidder !== null) this.players[a.highBidder].held -= a.highBid; // release the old lead
        p.held += action.amount;
        a.highBid = action.amount;
        a.highBidder = player;
        if (a.timeLeft < this.cfg.auctions.softCloseSec) a.timeLeft = this.cfg.auctions.softCloseSec;
        this.emit('all', { type: 'bid', t: this.t, company: a.company, player, amount: action.amount, timeLeft: a.timeLeft });
        break;
      }
      case 'startAuction': {
        if (this.phase !== 'running') return reject('auctions open once the game starts');
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        let seller: number | null;
        if (c.shares.some((s) => s === null)) {
          if (!this.presidents(c.id).includes(player)) return reject('only a president can auction the bank-held shares');
          seller = null;
        } else if (c.shares.includes(player)) seller = player;
        else return reject("all shares are out and you don't own any to sell");
        if (this.elapsed < this.auctionCooldownUntil[c.id] - 1e-9)
          return reject(`no bids last time; try again in ${Math.ceil(this.auctionCooldownUntil[c.id] - this.elapsed)}s`);
        if ((this.auction && this.auction.company === c.id) || this.auctionQueue.some((r) => r.company === c.id))
          return reject('this company already has an auction running or waiting');
        this.auctionQueue.push({ company: c.id, seller, startedBy: player });
        if (this.auction) this.emit('all', { type: 'auctionQueued', t: this.t, company: c.id, position: this.auctionQueue.length });
        break;
      }
      default:
        return reject(`unknown action ${(action as { type: string }).type}`);
    }
    this.actionLog.push({ step: this.steps, tick: this.tick, player, action });
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

  /**
   * Put a free truck at a company's starting depot, skipping price and capacity checks.
   * For tests and demos only; real games buy trucks with the buyTruck action.
   */
  addTruck(company: number): Truck {
    const depot = this.town.locations.find((l) => l.startCompany === company);
    if (!depot) throw new Error(`company ${company} has no starting depot`);
    return this.trucks.add(company, depot.id, depot.node);
  }

  /** Start, count down and settle auctions. Runs every step, in both phases. */
  private updateAuctions() {
    const cfg = this.cfg.auctions;
    if (this.auction) {
      this.auction.timeLeft -= this.cfg.tickSec;
      if (this.auction.timeLeft <= 1e-9) this.settleAuction();
    }
    if (this.auction) return;
    let next: AuctionRequest | undefined;
    if (this.phase === 'opening') {
      if (this.openingNext >= this.companies.length) {
        this.phase = 'running';
        this.emit('all', { type: 'open', t: 0 });
        return;
      }
      next = { company: this.openingNext++, seller: null, startedBy: 'bank' };
    } else {
      // A company nobody owns would never get a president: the bank re-offers it after the cooldown.
      for (const c of this.companies) {
        const unowned = c.shares.every((s) => s === null);
        const waiting = this.auctionQueue.some((r) => r.company === c.id);
        if (unowned && !waiting && this.elapsed >= this.auctionCooldownUntil[c.id] - 1e-9)
          this.auctionQueue.push({ company: c.id, seller: null, startedBy: 'bank' });
      }
      next = this.auctionQueue.shift();
    }
    if (!next) return;
    const opening = this.phase === 'opening';
    this.auction = {
      ...next,
      highBid: 0,
      highBidder: null,
      timeLeft: opening ? cfg.openingClockSec : cfg.clockSec,
      opening,
    };
    this.emit('all', { type: 'auctionStart', t: this.t, company: next.company, seller: next.seller, opening, timeLeft: this.auction.timeLeft });
  }

  private settleAuction() {
    const a = this.auction!;
    this.auction = null;
    const c = this.companies[a.company];
    if (a.highBidder === null) {
      this.auctionCooldownUntil[c.id] = this.elapsed + this.cfg.auctions.noBidCooldownSec;
      this.emit('all', { type: 'auctionNoBids', t: this.t, company: c.id });
      return;
    }
    const winner = this.players[a.highBidder];
    const idx = c.shares.indexOf(a.seller);
    if (idx < 0) {
      // The seller no longer has the share (can't happen today, but don't take the money).
      winner.held -= a.highBid;
      return;
    }
    c.shares[idx] = winner.id;
    winner.held -= a.highBid;
    winner.cash -= a.highBid;
    c.treasury += a.highBid; // the money always goes to the company, even when a player sells
    this.emit('all', { type: 'auctionWon', t: this.t, company: c.id, player: winner.id, amount: a.highBid, seller: a.seller });
  }

  private get payoutTicks() {
    return Math.max(1, Math.round(this.cfg.money.payoutEverySec / this.cfg.tickSec));
  }

  /** Game time of the next payout. */
  get nextPayoutAt() {
    const k = this.payoutTicks;
    const next = (Math.floor(this.tick / k) + 1) * k;
    return Math.min(next, this.totalTicks) * this.cfg.tickSec;
  }

  /**
   * Every company pays out its pot, one equal part per share; bank-held shares' parts go unpaid.
   * The final payout adds a bonus: part of the company's assets, or a multiple of its recent
   * earnings, depending on the config.
   */
  private payDividends(final: boolean) {
    for (const c of this.companies) {
      const n = c.shares.length;
      const m = this.cfg.money;
      const bonus = !final
        ? 0
        : m.finalBonus === 'earnings'
          ? m.finalEarningsMultiple * c.pot
          : m.finalAssetShare * (c.assets + Math.max(0, c.treasury));
      const amount = c.pot + bonus;
      const paid = payPerShare(c.shares, amount);
      for (const [player, x] of paid) this.players[player].cash += x;
      this.emit('all', {
        type: 'payout',
        t: this.t,
        company: c.id,
        perShare: c.pot / n,
        bonusPerShare: bonus / n,
        final,
        paid: Object.fromEntries(paid),
      });
      c.pot = 0;
    }
  }

  /** Trucks based at a depot site. */
  trucksAt(site: number): number {
    return this.trucks.trucks.filter((t) => t.depot === site).length;
  }

  /** Depot sites a company owns. */
  depotsOf(company: number): number[] {
    return [...this.depotOwner].filter(([, c]) => c === company).map(([s]) => s).sort((a, b) => a - b);
  }

  /** What a depot site would cost this company now (rises with distance from its depots). */
  depotPriceFor(company: number, site: number): number {
    const own = this.depotsOf(company).map((s) => this.town.locations[s].node);
    const d = distanceToNetwork(this.town.graph, this.town.locations[site].node, own);
    return depotPrice(this.cfg.depots, d);
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
      elapsed: this.elapsed,
      timeLeft: Math.max(0, this.cfg.durationSec - this.t),
      phase: this.phase,
      players: this.players.map((p) => ({ ...p })),
      companies: this.companies.map((c) => ({
        ...c,
        shares: [...c.shares],
        presidents: this.presidents(c.id),
        dividendPerShare: c.pot / c.shares.length,
      })),
      nextPayoutAt: this.nextPayoutAt,
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
      depots: Object.fromEntries(this.depotOwner),
      auction: this.auction ? { ...this.auction } : null,
      auctionQueue: this.auctionQueue.map((r) => ({ ...r })),
      auctionCooldownUntil: [...this.auctionCooldownUntil],
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
      depots: [...this.depotOwner].sort((a, b) => a[0] - b[0]),
      steps: this.steps,
      auction: this.auction,
      auctionQueue: this.auctionQueue,
      auctionCooldownUntil: this.auctionCooldownUntil,
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

/** An applied action, with when it took effect: `step` counts every step (opening round included). */
export interface LoggedAction {
  step: number;
  tick: number;
  player: number;
  action: Action;
}

/** Replay a game from its config and action log; should land on the same state. */
export function replay(cfg: GameConfig, log: LoggedAction[]): Game {
  const g = new Game(cfg);
  let i = 0;
  while (!g.done) {
    // An action logged with step k was applied at the start of the step when the count was k.
    while (i < log.length && log[i].step === g.steps) {
      g.act(log[i].player, log[i].action);
      i++;
    }
    g.step();
  }
  return g;
}
