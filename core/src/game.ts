/**
 * The authoritative game. Advances in fixed ticks; players change it only through actions,
 * which are queued and applied at the start of the next tick in the order they arrived.
 * Same config + same actions at the same ticks = same game, every time.
 */
import { makeGameConfig, type GameConfig, type GameConfigOverrides } from './config.js';
import { minimumBid, shareFloor, type AuctionEvent, type Book, type CancelReason, type Sale } from './auctions.js';
import { depotPrice, subsidisedPrice, truckPriceFor } from './depots.js';
import { assignPrices, investCost, payPerShare } from './money.js';
import { chooseOpening } from './openings.js';
import { creditLot, creditOrder, pickLotProducer, pickOrderShop, postLot, postOrder } from './orders.js';
import { cycleRate, initLocations, newLocationState, raiseLevel, updateCycles, type CycleEvent, type LocationState } from './economy.js';
import { distancesFrom } from './graph.js';
import { Rng } from './rng.js';
import { TruckSystem, type Truck, type TruckEvent } from './trucks.js';
import { clearToLot, generateTown, openOnLot, type Town } from './town.js';

// ------------------------------------------------------------------ state

export interface Player {
  id: number;
  cash: number;
  /** Part of `cash` held for this player's leading bid (can't be spent until released). */
  held: number;
  /** Which icon they picked (the client has the list); each player's is different. */
  icon: number;
}

/** How many icons players can pick from. */
export const PLAYER_ICONS = 12;

export interface Company {
  id: number;
  treasury: number;
  /** Money waiting for the next dividend payout. */
  pot: number;
  /** What the company has spent on trucks and depots (counts towards the final payout). */
  assets: number;
  /** Owner (player id) of each share, or null while the company owns it itself. */
  shares: (number | null)[];
  /**
   * Its delivery area: the town blocks (x + y * blocksX) whose shops it serves. Empty: anywhere.
   * Producers can be anywhere; trucks fetch from whichever is best.
   */
  area: number[];
  /** Places (producers or shops) it sends trucks to first, wherever they are. */
  focus: number[];
}

/** opening: the opening share sales, before the game clock starts. */
export type Phase = 'opening' | 'running' | 'ended';

// ------------------------------------------------------------------ routes

/** A standing assignment: trucks based at `depot` carry `producer`'s good to `consumer`. */
/** Key for a shop's claims on one good. */
const claimKey = (shop: number, good: number) => shop * 16 + good;

export interface Route {
  key: string;
  company: number;
  depot: number;
  producer: number;
  consumer: number;
  trucks: number;
}

export function routeKey(depot: number, producer: number, consumer: number): string {
  return `${depot}>${producer}>${consumer}`;
}

// ------------------------------------------------------------------ actions & events

/**
 * Everything a player can do. Later issues add their actions here (truck orders, purchases,
 * location investment...). `noop` exists so the plumbing can be tested on its own.
 */
export type Action =
  | { type: 'noop' }
  /**
   * Put one more free truck from `depot` on the producer -> consumer route (presidents of the
   * depot's company only). The route is created if it doesn't exist.
   */
  | { type: 'assignRoute'; depot: number; producer: number; consumer: number }
  /** Take one truck off a route; it drives back to its depot and becomes free. */
  | { type: 'unassignRoute'; depot: number; producer: number; consumer: number }
  /** President: the company's delivery area (town blocks, x + y * blocksX; empty for anywhere). */
  | { type: 'setArea'; company: number; blocks: number[] }
  /** President: focus the company on a producer or shop (or stop). */
  | { type: 'setFocus'; company: number; location: number; on: boolean }
  /** Buy a truck for a company, based at one of its depots (presidents only; from the treasury). */
  | { type: 'buyTruck'; company: number; depot: number }
  /** Buy a free depot site for a company (presidents only; from the treasury). */
  | { type: 'buyDepot'; company: number; site: number }
  /** Pay (from your own cash) to raise a producer or consumer one level. Anyone may. */
  | { type: 'invest'; location: number }
  /** Post a bid for a share of a company, or raise your own (holds the cash). In a sale, this is how you bid. */
  | { type: 'bid'; company: number; amount: number }
  /** Offer one of your shares of a company for sale at a price. */
  | { type: 'ask'; company: number; price: number }
  /** Withdraw your standing bid or ask. */
  | { type: 'cancelOrder'; company: number; side: 'bid' | 'ask' }
  /** Buy at the standing ask, at once. */
  | { type: 'buy'; company: number }
  /** Sell one of your shares at once: to the standing bid, or back to the company at its bid price. */
  | { type: 'sell'; company: number; to: 'bid' | 'company' }
  /** Pick your icon (during the opening round; not one another player has). */
  | { type: 'setIcon'; icon: number }
  /** Done bidding in a company's sale (until someone bids again). */
  | { type: 'pass'; company: number }
  /** Start a sale of one of a company's own shares. Anyone may. */
  | { type: 'startSale'; company: number };

export interface QueuedAction {
  player: number;
  action: Action;
}

export type GameEvent =
  | CycleEvent
  | TruckEvent
  | AuctionEvent
  | { type: 'open'; t: number }
  /** A new unclaimed factory site, on what was an empty lot. */
  | { type: 'siteOpened'; t: number; site: number }
  /** A shop posted an order for `size` pallets (`wants`: per good). */
  | { type: 'orderPosted'; t: number; location: number; size: number; wants: number[] }
  /** A producer offered a lot of `size` pallets. */
  | { type: 'lotPosted'; t: number; location: number; size: number }
  /** A shop or producer grew a tier. */
  | { type: 'grew'; t: number; location: number; tier: number }
  /** A shop's order was filled: each company's deliveries towards it, and its share of the bonus. */
  | { type: 'orderDone'; t: number; location: number; size: number; delivered: number[]; bonus: number[] }
  | { type: 'start'; t: number }
  | { type: 'boughtTruck'; t: number; company: number; truck: number; depot: number; price: number }
  | { type: 'boughtDepot'; t: number; company: number; site: number; price: number }
  | { type: 'invested'; t: number; player: number; location: number; level: number; price: number }
  | { type: 'opened'; t: number; location: number; kind: 'producer' | 'consumer'; good: number }
  | { type: 'routeChanged'; t: number; company: number; depot: number; producer: number; consumer: number; trucks: number }
  /** A route lost one of its ends (closure); its trucks are free again at the depot. */
  | { type: 'routeLost'; t: number; company: number; depot: number; producer: number; consumer: number; trucks: number }
  | { type: 'areaChanged'; t: number; company: number; blocks: number }
  | {
      type: 'payout';
      t: number;
      company: number;
      /** Dividend paid per share from the pot. */
      perShare: number;
      /** Final payout only: the end-of-game bonus paid per share (0 unless the config adds one). */
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
  /** `presidents`: the president, if any (as a list). `succession`: shareholders in line of succession, president first. */
  companies: (Company & { presidents: number[]; succession: number[]; dividendPerShare: number })[];
  /** Game time of the next dividend payout. */
  nextPayoutAt: number;
  /** Producers and consumers: stock, demand, level, growth, next cycle. */
  locations: LocationState[];
  trucks: (Truck & { x: number; y: number })[];
  /** Every company's routes: depot -> producer -> consumer, with how many trucks run it. */
  routes: Route[];
  /** Trucks queued or loading at each location (location id -> truck ids, in arrival order). */
  queues: Record<number, number[]>;
  /** Owner company of each depot site (site location id -> company); free sites are absent. */
  depots: Record<number, number>;
  /** What each free depot site costs each company right now (site location id -> price per company). */
  depotPrices: Record<number, number[]>;
  /** Sales of companies' own shares, counting down. */
  sales: Sale[];
  /** Each company's standing bid and ask. */
  books: Book[];
  /** What each company would pay for a share now, or null if its cash doesn't cover that. */
  companyBid: (number | null)[];
  /** Lowest price each company will sell one of its own shares for (its bid price, affordable or not). */
  minPrice: number[];
  /** Each company's value: trucks and factories at what they cost, plus cash. */
  value: number[];
  /** Earliest time (seconds since the start, opening round included) each company may hold another sale. */
  saleCooldownUntil: number[];
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
  readonly sales: Sale[] = [];
  readonly books: Book[];
  readonly saleCooldownUntil: number[];
  /** Next company to sell a share of in the opening round. */
  private openingNext = 0;
  readonly players: Player[];
  readonly companies: Company[];
  /** Dynamic state of every producer and consumer (depot sites aren't included). */
  /** Live producers and consumers. Closed ones are removed; opened ones are added. */
  locations: LocationState[];
  readonly trucks: TruckSystem;
  /** Which company owns each depot site (site location id -> company). */
  readonly depotOwner = new Map<number, number>();
  /** Recent pallets loaded or delivered: when, by whom, at which road node (for depot subsidies). */
  private service: { t: number; company: number; node: number }[] = [];
  /** Drive distances from each depot site, for district membership. */
  private siteDistances = new Map<number, Float64Array>();
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
    this.players = Array.from({ length: cfg.players }, (_, id) => ({ id, cash: cfg.startingCash, held: 0, icon: id % PLAYER_ICONS }));
    // Every company starts fully owned by the bank, with an empty treasury: shares are sold at
    // auction (pre-game, then during play), and that money is what gets companies going.
    this.companies = Array.from({ length: cfg.companies }, (_, id) => ({
      id,
      treasury: cfg.startingTreasury,
      pot: 0,
      assets: 0,
      shares: Array.from({ length: cfg.sharesPerCompany }, () => null),
      area: [],
      focus: [],
    }));
    this.locations = initLocations(this.town.locations, cfg.cycles, this.rng);
    for (const l of this.locations) this.locById.set(l.id, l);
    const prices = assignPrices(this.locations.filter((l) => l.kind === 'consumer').map((l) => l.id), cfg.money, this.rng);
    for (const [id, price] of prices) this.locById.get(id)!.price = price;
    // Bands of town: shops nearer the centre pay more, and centre shops (and producers) start bigger.
    if (cfg.orders.enabled && cfg.orders.demand === 'bands')
      for (const l of this.locations) {
        const b = this.bandOf(l.id);
        if (l.kind === 'consumer') l.price = Math.round(l.price * cfg.orders.bandPay[b] * 100) / 100;
        if (b === 0) l.tier = Math.max(l.tier, cfg.orders.centreTier);
      }
    this.bandBudget = [...cfg.orders.bandDemand];
    for (const l of this.town.locations) if (l.startCompany !== null) this.depotOwner.set(l.id, l.startCompany);
    this.trucks = new TruckSystem(
      this.town.graph,
      cfg.trucks,
      (id) => this.locById.get(id),
      (id) => this.town.locations[id].node,
      (e) => {
        if (e.type === 'delivered' || e.type === 'loaded') {
          this.service.push({ t: e.t, company: e.company, node: this.town.locations[e.location].node });
        }
        if (e.type === 'delivered') {
          // Every delivery pays the company now and adds the same amount to its next dividend.
          const c = this.companies[e.company];
          c.treasury += e.price * this.cfg.money.deliveryToTreasury;
          c.pot += e.price * this.cfg.money.deliveryToPot;
        }
        this.emit('all', e);
        if (e.type === 'delivered' && this.cfg.orders.enabled) this.creditDelivery(e.location, e.company);
        if (e.type === 'loaded' && this.cfg.orders.enabled) this.creditPickup(e.location, e.company);
      },
    );
    this.events = Array.from({ length: cfg.players }, () => []);
    this.saleCooldownUntil = this.companies.map(() => 0);
    this.books = this.companies.map(() => ({ bid: null, ask: null }));
    this.phase = cfg.auctions.openingRound ? 'opening' : 'running';
    // Every company starts with a truck or two at its starting factory (free: it isn't in its value).
    for (const c of this.companies) for (let i = 0; i < cfg.startingTrucks; i++) this.addTruck(c.id);
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
    this.updateSales();
    if (this.phase === 'opening') return; // the town waits until the opening round is over

    for (const e of updateCycles(this.locations, this.t, this.cfg.cycles, this.rng)) {
      this.emit('all', e);
      if (e.type === 'closed') this.removeLocation(e.location);
    }
    this.maybeOpen();
    this.maybeNewSite();
    if (this.cfg.orders.enabled && this.phase === 'running') this.postOrders();
    this.trucks.update(this.t, this.cfg.tickSec, (id) => this.town.locations[id].bays);
    // Companies route their own trucks, once a second.
    if (this.cfg.autoRoutes && this.tick % Math.max(1, Math.round(1 / this.cfg.tickSec)) === 0) this.autoRoute();

    this.tick++;
    const ending = this.tick >= this.totalTicks;
    // Running costs: every truck costs its company a little each second, from the treasury.
    if (this.cfg.depots.upkeepPerMin > 0 && this.phase === 'running') {
      const per = (this.cfg.depots.upkeepPerMin * this.cfg.tickSec) / 60;
      for (const t of this.trucks.trucks) this.companies[t.company].treasury -= per;
    }
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
      case 'setArea': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!this.presidents(c.id).includes(player)) return reject("only a president can choose where its company delivers");
        const n = this.cfg.town.blocksX * this.cfg.town.blocksY;
        if (!Array.isArray(action.blocks) || action.blocks.some((b) => !Number.isInteger(b) || b < 0 || b >= n)) return reject('those blocks are not in town');
        c.area = [...new Set(action.blocks)].sort((a, b) => a - b);
        this.emit('all', { type: 'areaChanged', t: this.t, company: c.id, blocks: c.area.length });
        break;
      }
      case 'setFocus': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!this.presidents(c.id).includes(player)) return reject("only a president can choose where its company delivers");
        const l = this.locById.get(action.location);
        if (!l || (l.kind !== 'producer' && l.kind !== 'consumer')) return reject('you can only focus on a producer or a shop');
        if (!action.on) c.focus = c.focus.filter((x) => x !== action.location);
        else if (!c.focus.includes(action.location)) {
          if (c.focus.length >= this.cfg.maxFocus) return reject(`a company can focus on ${this.cfg.maxFocus} places at once: unfocus one first`);
          c.focus = [...c.focus, action.location];
        }
        this.replan = true;
        break;
      }
      case 'assignRoute':
      case 'unassignRoute': {
        if (this.cfg.autoRoutes) return reject('companies choose their own routes: set a delivery area or focus instead');
        const company = this.depotOwner.get(action.depot);
        if (company === undefined) return reject(`nobody owns depot ${action.depot}`);
        if (!this.presidents(company).includes(player)) return reject("only a president can direct this company's trucks");
        const p = this.town.locations[action.producer];
        const c = this.town.locations[action.consumer];
        if (!p || p.kind !== 'producer') return reject(`${action.producer} is not a producer`);
        if (!c || c.kind !== 'consumer') return reject(`${action.consumer} is not a consumer`);
        if (p.good !== c.good) return reject(`${this.cfg.town.goods[p.good!]} can't be sold at a ${this.cfg.town.goods[c.good!]} consumer`);
        const key = routeKey(action.depot, action.producer, action.consumer);
        if (action.type === 'assignRoute') {
          // Trucks are a company-wide pool: send the free truck nearest the route's factory.
          const d = this.siteDist(action.depot);
          const free = this.trucks.trucks
            .filter((t) => t.company === company && t.orders.length === 0 && t.cargo === null)
            .sort((a, b) => d[a.node] - d[b.node] || a.id - b.id)[0];
          if (!free) return reject('no free truck (buy one, or take one off another route)');
          free.depot = action.depot;
          free.home = this.town.locations[action.depot].node;
          const load = { location: action.producer, action: 'load' as const };
          const unload = { location: action.consumer, action: 'unload' as const };
          const sign = { location: action.depot, action: 'signOff' as const };
          const via = this.cfg.trucks.viaDepot;
          this.trucks.setOrders(free, via === 'hub' ? [load, sign, unload, sign] : via === 'loaded' ? [load, sign, unload] : [load, unload], this.t);
          free.route = key;
        } else {
          const onRoute = this.trucks.trucks.filter((t) => t.route === key);
          if (onRoute.length === 0) return reject('no trucks on that route');
          // Send home the one with the least invested: empty first, then whichever is furthest along.
          const truck = onRoute.find((t) => t.cargo === null) ?? onRoute[onRoute.length - 1];
          this.trucks.sendHome(truck, this.t);
        }
        const trucks = this.trucks.trucks.filter((t) => t.route === key).length;
        this.emit('all', { type: 'routeChanged', t: this.t, company, depot: action.depot, producer: action.producer, consumer: action.consumer, trucks });
        break;
      }
      case 'buyTruck': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!this.presidents(c.id).includes(player)) return reject('only a president can spend company money');
        if (this.depotOwner.get(action.depot) !== c.id) return reject('that depot belongs to someone else (or nobody)');
        if (this.trucksOf(c.id) >= this.truckLimit(c.id))
          return reject(`the fleet is full (${this.cfg.depots.capacity} trucks per factory): buy another factory`);
        const price = truckPriceFor(this.cfg.depots, this.trucksOf(c.id));
        if (c.treasury < price) return reject(`the treasury has $${c.treasury.toFixed(2)}; the next truck costs $${price.toFixed(2)}`);
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
        const price = investCost(this.cfg.money, l.level, this.cfg.cycles.startLevel);
        const p = this.players[player];
        if (p.cash - p.held < price) return reject(`you have $${(p.cash - p.held).toFixed(2)} to spend; this costs $${price}`);
        if (l.level >= this.cfg.cycles.maxLevel) return reject(`${l.kind} ${l.id} is already at the top level`);
        p.cash -= price;
        raiseLevel(l, this.cfg.cycles);
        this.emit('all', { type: 'invested', t: this.t, player, location: l.id, level: l.level, price });
        break;
      }
      case 'bid': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (this.phase === 'opening' && this.sales[0]?.company !== c.id) return reject('in the opening round, you can only bid on the company being sold');
        const amount = action.amount;
        if (!(amount >= 0) || !Number.isFinite(amount)) return reject('that bid is not a number');
        const book = this.books[c.id];
        const own = book.bid?.player === player ? book.bid.price : 0;
        const min = minimumBid(book, player, this.cfg.auctions);
        if (amount < min) return reject(book.bid?.player === player ? `raise your bid above $${own}` : `the lowest bid now is $${min}`);
        // Never below what the company itself prices a share at.
        const floor = this.minPrice(c.id);
        if (amount < floor) return reject(`bids start at the company's price, $${floor}`);
        if (book.ask && book.ask.player !== player && amount >= book.ask.price) return reject(`a share is for sale at $${book.ask.price}: buy it instead`);
        const p = this.players[player];
        if (p.cash - p.held + own < amount) return reject(`you only have $${(p.cash - p.held + own).toFixed(2)} to bid with`);
        if (book.bid) this.dropBid(c.id, book.bid.player === player ? null : 'beaten');
        p.held += amount;
        book.bid = { player, price: amount };
        // A bid near the end of a sale gives the others a moment to answer, up to the sale's limit.
        const sale = this.sales.find((x) => x.company === c.id);
        if (sale) sale.passed = []; // everyone else may answer the new bid
        if (sale && sale.timeLeft < this.cfg.auctions.softCloseSec) {
          const cap = Math.max(0, this.cfg.auctions.maxSec - sale.age);
          sale.timeLeft = Math.min(this.cfg.auctions.softCloseSec, Math.max(sale.timeLeft, cap));
        }
        this.emit('all', { type: 'bidPosted', t: this.t, company: c.id, player, price: amount });
        break;
      }
      case 'ask': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (this.phase !== 'running') return reject('the market opens once the game starts');
        if (!c.shares.includes(player)) return reject("you don't own a share of this company");
        const price = action.price;
        if (!(price >= 1) || !Number.isFinite(price)) return reject('ask at least $1');
        const book = this.books[c.id];
        if (book.bid && book.bid.player !== player && price <= book.bid.price) return reject(`someone bids $${book.bid.price}: sell to them instead`);
        const cb = this.companyBid(c.id);
        if (cb !== null && price <= cb) return reject(`the company pays $${cb}: sell to it instead`);
        if (book.ask && book.ask.player !== player && price > book.ask.price - this.cfg.auctions.minRaise)
          return reject(`undercut the asking price of $${book.ask.price} by at least $${this.cfg.auctions.minRaise}`);
        if (book.ask) this.dropAsk(c.id, book.ask.player === player ? null : 'beaten');
        book.ask = { player, price };
        this.emit('all', { type: 'askPosted', t: this.t, company: c.id, player, price });
        break;
      }
      case 'cancelOrder': {
        const book = this.books[action.company];
        if (!book) return reject(`no company ${action.company}`);
        const o = action.side === 'bid' ? book.bid : book.ask;
        if (!o || o.player !== player) return reject(`you have no ${action.side} there`);
        if (action.side === 'bid') this.dropBid(action.company, 'withdrawn');
        else this.dropAsk(action.company, 'withdrawn');
        break;
      }
      case 'buy': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (this.phase !== 'running') return reject('the market opens once the game starts');
        const ask = this.books[c.id].ask;
        if (!ask) return reject('nobody is selling a share of this company');
        if (ask.player === player) return reject("that's your own share");
        const p = this.players[player];
        if (p.cash - p.held < ask.price) return reject(`you have $${(p.cash - p.held).toFixed(2)} to spend; it costs $${ask.price}`);
        this.books[c.id].ask = null;
        const seller = this.players[ask.player];
        c.shares[c.shares.indexOf(ask.player)] = player;
        this.syncHoldings(c.id);
        p.cash -= ask.price;
        seller.cash += ask.price;
        this.emit('all', { type: 'trade', t: this.t, company: c.id, buyer: player, seller: ask.player, price: ask.price });
        this.afterSale(c.id, ask.player);
        break;
      }
      case 'sell': {
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (this.phase !== 'running') return reject('the market opens once the game starts');
        if (!c.shares.includes(player)) return reject("you don't own a share of this company");
        const seller = this.players[player];
        if (action.to === 'company') {
          const price = this.companyBid(c.id);
          if (price === null) return reject("the company can't buy a share back right now");
          c.shares[c.shares.indexOf(player)] = null;
          this.syncHoldings(c.id);
          c.treasury -= price;
          seller.cash += price;
          this.emit('all', { type: 'trade', t: this.t, company: c.id, buyer: 'company', seller: player, price });
        } else {
          const bid = this.books[c.id].bid;
          if (!bid) return reject('nobody is bidding for a share of this company');
          // During the company's own sale, its bids are for the company's share: the money goes to the company.
          if (this.sales.some((x) => x.company === c.id)) return reject("the company is offering a share: its bids are for that one, so you can't sell yours to them now");
          if (bid.player === player) return reject("that's your own bid");
          this.books[c.id].bid = null;
          const buyer = this.players[bid.player];
          buyer.held -= bid.price;
          buyer.cash -= bid.price;
          seller.cash += bid.price;
          c.shares[c.shares.indexOf(player)] = bid.player;
          this.syncHoldings(c.id);
          this.emit('all', { type: 'trade', t: this.t, company: c.id, buyer: bid.player, seller: player, price: bid.price });
        }
        this.afterSale(c.id, player);
        break;
      }
      case 'setIcon': {
        if (this.phase !== 'opening') return reject('icons are picked during the opening round');
        if (!Number.isInteger(action.icon) || action.icon < 0 || action.icon >= PLAYER_ICONS) return reject('no such icon');
        if (this.players.some((p) => p.id !== player && p.icon === action.icon)) return reject('another player has that one');
        this.players[player].icon = action.icon;
        break;
      }
      case 'pass': {
        const sale = this.sales.find((x) => x.company === action.company);
        if (!sale) return reject('that company has no share offering running');
        if (this.books[sale.company].bid?.player === player) return reject("you're the highest bidder");
        if (sale.passed.includes(player)) return;
        sale.passed.push(player);
        this.emit('all', { type: 'pass', t: this.t, company: sale.company, player });
        // Everyone who could still bid has passed: it ends now.
        const leader = this.books[sale.company].bid?.player;
        if (this.players.every((p) => p.id === leader || sale.passed.includes(p.id))) sale.timeLeft = 0;
        break;
      }
      case 'startSale': {
        if (this.phase !== 'running') return reject('share offerings open once the game starts');
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!c.shares.includes(null)) return reject('the company has no shares of its own left to sell');
        if (this.sales.some((x) => x.company === c.id)) return reject('this company already has a share offering running');
        if (this.elapsed < this.saleCooldownUntil[c.id] - 1e-9)
          return reject(`it held a share offering recently; try again in ${Math.ceil(this.saleCooldownUntil[c.id] - this.elapsed)}s`);
        this.startSale(c.id, player, false);
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
    // (A filled order needs no new plan: nothing was planned beyond its last pallet.)
    if (e.type === 'orderPosted' || e.type === 'lotPosted' || e.type === 'areaChanged' || e.type === 'boughtTruck' || e.type === 'boughtDepot') this.replan = true;
  }

  /** Events for a player not yet drained (read only: for measuring in experiments). */
  peekEvents(player: number): readonly GameEvent[] {
    return this.events[player];
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

  /** Value of a company: trucks and factories at what they cost, plus cash. */
  companyValue(company: number): number {
    const c = this.companies[company];
    return c.assets + Math.max(0, c.treasury);
  }

  /** The lowest price a company sells one of its own shares for, and what it pays for one back. */
  minPrice(company: number): number {
    const c = this.companies[company];
    return shareFloor(this.cfg.auctions, c.assets, c.treasury, c.shares.length);
  }

  /** What a company would pay for a share now, or null if its cash doesn't cover it. */
  companyBid(company: number): number | null {
    const price = this.minPrice(company);
    return price >= 1 && this.companies[company].treasury >= price ? price : null;
  }

  /** Take a company's standing bid off the book and release the cash it held. */
  private dropBid(company: number, reason: CancelReason | null) {
    const bid = this.books[company].bid;
    if (!bid) return;
    this.books[company].bid = null;
    this.players[bid.player].held -= bid.price;
    if (reason) this.emit('all', { type: 'orderCancelled', t: this.t, company, side: 'bid', player: bid.player, price: bid.price, reason });
  }

  private dropAsk(company: number, reason: CancelReason | null) {
    const ask = this.books[company].ask;
    if (!ask) return;
    this.books[company].ask = null;
    if (reason) this.emit('all', { type: 'orderCancelled', t: this.t, company, side: 'ask', player: ask.player, price: ask.price, reason });
  }

  /** After a player parted with a share: an ask they can no longer fill goes. */
  private afterSale(company: number, seller: number) {
    const ask = this.books[company].ask;
    if (ask && ask.player === seller && !this.companies[company].shares.includes(seller)) this.dropAsk(company, 'noShares');
  }

  private startSale(company: number, startedBy: number | 'bank', opening: boolean) {
    const cfg = this.cfg.auctions;
    const sale: Sale = { company, startedBy, timeLeft: opening ? cfg.openingClockSec : cfg.clockSec, age: 0, opening, passed: [] };
    this.sales.push(sale);
    this.emit('all', { type: 'saleStart', t: this.t, company, startedBy, opening, timeLeft: sale.timeLeft, minPrice: this.minPrice(company) });
  }

  /** Count down and settle sales; run the opening round; re-offer companies nobody owns. Every step. */
  private updateSales() {
    for (const sale of [...this.sales]) {
      sale.timeLeft -= this.cfg.tickSec;
      sale.age += this.cfg.tickSec;
      if (sale.timeLeft <= 1e-9) this.settleSale(sale);
    }
    if (this.phase === 'opening') {
      if (this.sales.length) return;
      if (this.openingNext >= this.companies.length) {
        this.phase = 'running';
        this.emit('all', { type: 'open', t: 0 });
        return;
      }
      this.startSale(this.openingNext++, 'bank', true);
      return;
    }
    // A company nobody owns would never get a president: the bank re-offers it after the cooldown.
    for (const c of this.companies) {
      if (!c.shares.every((x) => x === null) || this.sales.some((x) => x.company === c.id)) continue;
      if (this.elapsed >= this.saleCooldownUntil[c.id] - 1e-9) this.startSale(c.id, 'bank', false);
    }
  }

  /** A sale's clock ran out: the standing bid gets the share if it's at least the company's minimum price. */
  private settleSale(sale: Sale) {
    this.sales.splice(this.sales.indexOf(sale), 1);
    const c = this.companies[sale.company];
    const bid = this.books[c.id].bid;
    const idx = c.shares.indexOf(null);
    if (!bid || idx < 0 || bid.price < this.minPrice(c.id)) {
      this.saleCooldownUntil[c.id] = this.elapsed + this.cfg.auctions.noBidCooldownSec;
      this.emit('all', { type: 'saleUnsold', t: this.t, company: c.id });
      return;
    }
    this.books[c.id].bid = null;
    const winner = this.players[bid.player];
    c.shares[idx] = winner.id;
    this.syncHoldings(c.id);
    winner.held -= bid.price;
    winner.cash -= bid.price;
    c.treasury += bid.price;
    if (!sale.opening) this.saleCooldownUntil[c.id] = this.elapsed + this.cfg.auctions.saleCooldownSec;
    this.emit('all', { type: 'saleWon', t: this.t, company: c.id, player: winner.id, amount: bid.price, opening: sale.opening });
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
   * Every company pays out its pot, one equal part per share; the parts for shares it owns itself
   * go into its treasury.
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
      c.treasury += (amount / n) * c.shares.filter((x) => x === null).length;
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

  /** A closed location becomes an empty lot again; routes through it end and their trucks go home. */
  private removeLocation(id: number) {
    this.locations = this.locations.filter((l) => l.id !== id);
    this.locById.delete(id);
    clearToLot(this.town, id);
    for (const r of this.routes()) {
      if (r.producer !== id && r.consumer !== id) continue;
      for (const t of this.trucks.trucks) if (t.route === r.key) this.trucks.sendHome(t, this.t);
      this.emit('all', { type: 'routeLost', t: this.t, company: r.company, depot: r.depot, producer: r.producer, consumer: r.consumer, trucks: r.trucks });
    }
    this.trucks.locationClosed(id, this.t);
    for (const c of this.companies) c.focus = c.focus.filter((x) => x !== id);
  }

  // ---------------------------------------------------------------- automatic routes

  private nodeDist = new Map<number, Float64Array>();
  /** Road distances from a node (cached: the roads never change). */
  private distFrom(node: number): Float64Array {
    let d = this.nodeDist.get(node);
    if (!d) {
      d = distancesFrom(this.town.graph, node);
      this.nodeDist.set(node, d);
    }
    return d;
  }

  /** The town block a place is in (x + y * blocksX). */
  blockOf(location: number): number {
    const l = this.town.locations[location];
    return Math.floor(l.x) + Math.floor(l.y) * this.cfg.town.blocksX;
  }

  /** Whether a company would deliver to this shop: it's in the company's area (or there's no area), or a focus. */
  serves(company: number, consumer: number): boolean {
    const c = this.companies[company];
    return c.area.length === 0 || c.focus.includes(consumer) || c.area.includes(this.blockOf(consumer));
  }

  /**
   * Trucks a producer or shop can keep busy at once: about what its output (or demand) at its level
   * takes to carry, at most one more beyond that.
   */
  // ---------------------------------------------------------------- shop orders

  /**
   * Keep the town busy: post shop orders until open demand keeps pace with the fleet, then offer
   * producers' lots until each good's open supply covers its open demand.
   */
  private postOrders() {
    const cfg = this.cfg.orders;
    const goods = this.cfg.town.goods.length;
    const live = this.locations.filter((l) => !l.closed);
    const shops = live.filter((l) => l.kind === 'consumer');
    const producers = live.filter((l) => l.kind === 'producer');
    const demand = new Array(goods).fill(0);
    for (const q of shops) if (q.order) q.order.wants.forEach((w, g) => (demand[g] += w));
    const supply = new Array(goods).fill(0);
    for (const p of producers) if (p.order) supply[p.good] += p.stock;
    const freeSites = this.town.locations.filter((l) => l.kind === 'depot' && !this.depotOwner.has(l.id));
    const nearSite = (s: LocationState) => {
      const node = this.town.locations[s.id].node;
      return freeSites.some((site) => this.siteDist(site.id)[node] <= this.cfg.depots.districtBlocks);
    };
    // Goods short of demand: lots of supply on offer (or producers that could offer it) and little wanted.
    const producersOf = new Array(goods).fill(0);
    for (const p of producers) producersOf[p.good]++;
    const short = (g: number) => (producersOf[g] + supply[g]) / (1 + demand[g]);
    // Each band of town (centre, middle, outer) keeps its own open demand up, a fixed amount: or,
    // with demand following the fleet, the whole town as one.
    const groups: { shops: LocationState[]; target: number; band: number }[] =
      cfg.demand === 'bands'
        ? [0, 1, 2].map((b) => {
            const ramp = cfg.bandRampSec[b];
            const share = ramp > 0 ? Math.min(1, 0.25 + (0.75 * this.t) / ramp) : 1;
            return { shops: shops.filter((q) => this.bandOf(q.id) === b), target: this.bandBudget[b] * share * this.demandGrowth(), band: b };
          })
        : [{ shops, target: Math.max(cfg.minOpen, this.trucks.trucks.length * cfg.openPerTruck), band: -1 }];
    for (const grp of groups) {
      let open = grp.shops.reduce((a, q) => a + (q.order ? q.demand : 0), 0);
      for (let guard = 0; open < grp.target && guard < 50; guard++) {
        const shop = pickOrderShop(grp.shops, this.t, short, nearSite, cfg, this.rng);
        if (!shop) break;
        // A band whose demand has moved inward asks for less per order, as well as less in all.
        const scale = grp.band >= 0 ? Math.min(1, this.bandBudget[grp.band] / cfg.bandDemand[grp.band]) : 1;
        postOrder(shop, goods, this.companies.length, this.t, cfg, this.rng, scale);
        shop.order!.wants.forEach((w, g) => (demand[g] += w));
        open += shop.demand;
        this.emit('all', { type: 'orderPosted', t: this.t, location: shop.id, size: shop.order!.size, wants: [...shop.order!.wants] });
      }
    }
    // Lots: for each good, until what's on offer covers what's wanted. Producers near the shops that
    // want it go first.
    for (let g = 0; g < goods; g++) {
      const wanting = shops.filter((q) => q.order && q.order.wants[g] > 0);
      const nearby = (p: LocationState) => {
        const d = this.distFrom(this.town.locations[p.id].node);
        return wanting.reduce((a, q) => a + (d[this.town.locations[q.id].node] <= 8 ? q.order!.wants[g] : 0), 0);
      };
      for (let guard = 0; supply[g] < demand[g] * cfg.supplyShare && guard < 50; guard++) {
        const p = pickLotProducer(producers, g, this.t, nearby, this.rng);
        if (!p) break;
        postLot(p, this.companies.length, this.t, cfg, this.rng);
        supply[g] += p.stock;
        this.emit('all', { type: 'lotPosted', t: this.t, location: p.id, size: p.stock });
      }
    }
  }

  /** A pallet delivered to a shop with an order: count it, and on the last one pay the completion bonus. */
  private creditDelivery(location: number, company: number) {
    const s = this.locById.get(location);
    if (!s) return;
    // Bands: serving a band moves some of its demand one band in (down to the band's floor).
    const ocfg = this.cfg.orders;
    if (ocfg.demand === 'bands') {
      const b = this.bandOf(location);
      if (b > 0) {
        const floor = ocfg.bandDemand[b] * ocfg.bandFloor[b];
        const move = Math.min(ocfg.migratePerPallet, Math.max(0, this.bandBudget[b] - floor));
        this.bandBudget[b] -= move;
        this.bandBudget[b - 1] += move;
      }
    }
    const done = creditOrder(s, company, this.t, this.cfg.orders, this.rng, this.bandOf(location));
    if (!done) return;
    const total = done.size * this.cfg.orders.bonusPerPallet;
    const bonus = done.delivered.map((n) => (total * n) / done.size);
    bonus.forEach((b, c) => {
      if (b <= 0) return;
      this.companies[c].treasury += b * this.cfg.money.deliveryToTreasury;
      this.companies[c].pot += b * this.cfg.money.deliveryToPot;
    });
    this.emit('all', { type: 'orderDone', t: this.t, location, size: done.size, delivered: [...done.delivered], bonus });
    if (done.grew) this.emit('all', { type: 'grew', t: this.t, location, tier: s.tier });
  }

  /**
   * Which band of town a place is in: 0 centre, 1 middle, 2 outer, by its distance from the middle
   * of town against the furthest shop's.
   */
  bandOf(location: number): number {
    let b = this.bands.get(location);
    if (b !== undefined) return b;
    const { blocksX, blocksY } = this.cfg.town;
    const cx = blocksX / 2;
    const cy = blocksY / 2;
    if (this.bandReach === 0)
      for (const l of this.town.locations) if (l.kind === 'consumer' || l.kind === 'producer') this.bandReach = Math.max(this.bandReach, Math.hypot(l.x - cx, l.y - cy));
    const l = this.town.locations[location];
    const f = Math.hypot(l.x - cx, l.y - cy) / Math.max(1e-9, this.bandReach);
    const [a, z] = this.cfg.orders.bandEdges;
    b = f <= a ? 0 : f <= z ? 1 : 2;
    this.bands.set(location, b);
    return b;
  }
  private bands = new Map<number, number>();

  /**
   * How much the town's demand has grown by now (1 at the start). It follows a curve made at the start
   * of the game: up to a random level, in stretches of uneven pace (see OrdersConfig.growTo).
   */
  demandGrowth(): number {
    const o = this.cfg.orders;
    if (!this.growCurve) {
      // Its own random numbers, so the rest of the game's draws are the same as without it.
      const rng = new Rng(this.cfg.seed * 7919 + 13);
      const base = o.bandDemand.reduce((a, b) => a + b, 0);
      const [lo, hi] = o.growTo;
      const end = hi > 0 ? (lo + rng.next() * (hi - lo)) / base : 1;
      const paces = Array.from({ length: Math.max(1, o.growSteps) }, () => 0.3 + rng.next() * 1.4);
      const total = paces.reduce((a, b) => a + b, 0);
      let acc = 0;
      this.growCurve = { end, at: [0, ...paces.map((p) => (acc += p) / total)] };
    }
    const { end, at } = this.growCurve;
    if (end === 1 || o.growEndSec <= 0) return end;
    const f = Math.min(1, Math.max(0, this.t / o.growEndSec)) * (at.length - 1);
    const i = Math.min(at.length - 2, Math.floor(f));
    const progress = at[i] + (at[i + 1] - at[i]) * (f - i);
    return 1 + (end - 1) * progress;
  }
  private growCurve: { end: number; at: number[] } | null = null;
  /** Bands: open demand each band keeps up now (it moves inward as the town is served). */
  bandBudget: number[] = [];
  private bandReach = 0;

  /** A pallet picked up from a producer's lot: count it; the last one ends the lot. */
  private creditPickup(location: number, company: number) {
    const p = this.locById.get(location);
    if (!p) return;
    const done = creditLot(p, company, this.t, this.cfg.orders, this.rng);
    if (done?.grew) this.emit('all', { type: 'grew', t: this.t, location, tier: p.tier });
  }

  /** Pallets of a shop's order still free to claim: wanted, less trucks already sent for them. */
  private openSlots(location: number, reserved: Map<number, number>): number {
    const s = this.locById.get(location);
    return s ? s.demand - (reserved.get(location) ?? 0) : 0;
  }

  private placeCap(location: number): number {
    const l = this.locById.get(location);
    const level = l?.level ?? this.cfg.cycles.startLevel;
    const perCycle = this.cfg.cycles.palletsPerLevel * level;
    const cycleSec = (this.cfg.cycles.cycleSec[0] + this.cfg.cycles.cycleSec[1]) / 2;
    const perMin = (perCycle * 60) / cycleSec;
    const tripsPerTruckMin = this.cfg.trucks.speed / 0.25;
    return Math.max(1, Math.round((perMin / tripsPerTruckMin) * 0.75)) + 1;
  }

  /** Length of one round trip on a route, as a truck drives it. */
  private routeLength(depot: number, producer: number, consumer: number): number {
    const d = this.distFrom(this.town.locations[depot].node);
    const p = this.town.locations[producer].node;
    const q = this.town.locations[consumer].node;
    const via = this.cfg.trucks.viaDepot;
    return via === 'hub' ? 2 * (d[p] + d[q]) : via === 'loaded' ? d[p] + d[q] + this.distFrom(p)[q] : d[p] + 2 * this.distFrom(p)[q];
  }

  /**
   * Companies route their own trucks. Each free truck takes the best route it can: a producer to a
   * shop the company serves (in its delivery area, or a focus), through whichever of its factories
   * makes the trip shortest. Shorter trips and better-paying shops come first, and a place stops
   * taking trucks once it has as many as it can keep busy. Focused places come first of all, and if
   * one has none of the company's trucks, a truck from an unfocused route is freed up for it. A
   * truck whose shop leaves the area finishes its delivery and is free again.
   */
  private autoRoute() {
    if (this.phase !== 'running') return;
    // Trucks (any company) already working each place.
    const load = new Map<number, number>();
    for (const t of this.trucks.trucks) for (const s of t.orders) load.set(s.location, (load.get(s.location) ?? 0) + 1);
    const live = this.locations.filter((l) => l.kind === 'producer' || l.kind === 'consumer');
    const free: { truck: Truck; depots: number[] }[] = [];
    for (const c of this.companies) {
      const depots = [...this.depotOwner].filter(([, o]) => o === c.id).map(([s]) => s).sort((a, b) => a - b);
      const mine = this.trucks.trucks.filter((t) => t.company === c.id);
      if (this.cfg.orders.enabled) continue; // the plan handles orders (a sent truck finishes its trip)
      // Out of the area: finish up and come free.
      for (const t of mine) {
        if (!t.route || t.homing) continue;
        const consumer = Number(t.route.split('>')[2]);
        if (!this.serves(c.id, consumer)) this.trucks.sendHome(t, this.t);
      }
      // A focus with none of our trucks: free one from an unfocused route for it.
      for (const f of c.focus) {
        if (mine.some((t) => t.route && t.route.split('>').slice(1).map(Number).includes(f))) continue;
        if (mine.some((t) => t.orders.length === 0 && t.cargo === null)) continue; // a free one will go
        if ((load.get(f) ?? 0) >= this.placeCap(f)) continue; // no room there anyway: don't churn
        const spare = mine.find((t) => t.route && !t.homing && t.cargo === null && !t.route.split('>').slice(1).map(Number).some((x) => c.focus.includes(x)));
        if (spare) this.trucks.sendHome(spare, this.t);
      }
      if (depots.length === 0) continue;
      for (const t of mine) if (t.orders.length === 0 && t.cargo === null && !t.route) free.push({ truck: t, depots });
    }
    if (this.cfg.orders.enabled) this.dispatchPlanned();
    else this.assignTrucks(free, load, live);
  }

  /**
   * Routes (shops that always want more): give free trucks a route each. Each truck takes the best
   * route it can (better pay, shorter, focused first), and a place stops taking trucks once it has
   * as many as it can keep busy.
   */
  private assignTrucks(free: { truck: Truck; depots: number[] }[], load: Map<number, number>, live: LocationState[]) {
    for (const { truck, depots } of free) {
      const c = this.companies[truck.company];
      let best: { depot: number; producer: number; consumer: number; score: number } | null = null;
      for (const q of live) {
        if (q.kind !== 'consumer' || !this.serves(c.id, q.id)) continue;
        for (const p of live) {
          if (p.kind !== 'producer' || p.good !== q.good) continue;
          const busy = Math.max((load.get(p.id) ?? 0) / this.placeCap(p.id), (load.get(q.id) ?? 0) / this.placeCap(q.id));
          if (busy >= 1) continue;
          let depot = depots[0];
          let length = Infinity;
          for (const d of depots) {
            const len = this.routeLength(d, p.id, q.id);
            if (len < length) {
              length = len;
              depot = d;
            }
          }
          if (!Number.isFinite(length)) continue;
          const focused = c.focus.includes(p.id) || c.focus.includes(q.id);
          const score = ((q.price ?? this.cfg.money.palletPrice) / (length + 4)) * (1 - busy) * (focused ? 10 : 1);
          if (!best || score > best.score) best = { depot, producer: p.id, consumer: q.id, score };
        }
      }
      if (!best) continue;
      this.sendOnRoute(truck, best.depot, best.producer, best.consumer);
      load.set(best.producer, (load.get(best.producer) ?? 0) + 1);
      load.set(best.consumer, (load.get(best.consumer) ?? 0) + 1);
    }
  }

  // ---------------------------------------------------------------- the delivery plan (shop orders)

  /**
   * The plan: for every pallet still unclaimed in an open order, the truck that would get it there
   * soonest, counting trucks still on a trip from when and where they'll be free. Trucks that are
   * free now are sent on their planned trip; the rest wait for theirs. Only a truck that's been sent
   * has a pallet: plans for later can change at no cost, so nobody ever turns back.
   *
   * Replanned only when something it depends on changes: an order posted or filled, an area or
   * focus changed, a truck or factory bought, or a truck freeing up noticeably earlier or later than
   * planned (or with nothing planned for it). Otherwise a free truck just takes its planned trip.
   */
  private dispatchPlanned() {
    const free = this.trucks.trucks.filter((t) => t.orders.length === 0 && t.cargo === null && !t.route && this.depotsOf(t.company).length > 0);
    // A truck free with no plan for it (bought, sent home, or ahead of schedule): plan again.
    if (!this.replan && free.some((t) => !this.plan.has(t.id) && this.planFreeAt.get(t.id) !== undefined && this.t > this.planFreeAt.get(t.id)! + this.cfg.orders.lateSec)) this.replan = true;
    // Changes are batched: plan at most every few seconds, unless a free truck has nothing to do.
    const idleFree = free.some((t) => !this.plan.has(t.id) && !this.idleAtPlan.has(t.id));
    if ((this.replan && (idleFree || this.t >= this.lastPlanAt + this.cfg.orders.batchSec)) || this.t >= this.nextReplanAt) this.makePlan();
    for (const t of free) {
      const trip = this.plan.get(t.id);
      if (!trip) continue;
      const s = this.locById.get(trip.consumer);
      const key = claimKey(trip.consumer, trip.good);
      if (!s || !s.order || (s.order.wants[trip.good] ?? 0) - (this.claimed.get(key) ?? 0) < 1) {
        // Its pallet's gone (filled, or claimed): plan again next second.
        this.plan.delete(t.id);
        this.replan = true;
        continue;
      }
      this.sendOnRoute(t, trip.depot, trip.producer, trip.consumer);
      this.plan.delete(t.id);
      this.eta.set(t.id, this.t + trip.duration);
      this.claimed.set(key, (this.claimed.get(key) ?? 0) + 1);
    }
  }

  private makePlan() {
    this.replan = false;
    this.lastPlanAt = this.t;
    this.nextReplanAt = this.t + this.cfg.orders.replanSec;
    this.plans++;
    this.plan.clear();
    this.planFreeAt.clear();
    const speed = this.cfg.trucks.speed;
    const extra = 2 * this.cfg.trucks.serviceSec + (this.cfg.trucks.viaDepot === 'none' ? 0 : this.cfg.trucks.signOffSec);
    // Pallets each shop has claimed, good by good (trucks sent and not yet unloading there).
    this.claimed.clear();
    for (const t of this.trucks.trucks) {
      const u = t.orders.find((o) => o.action === 'unload');
      if (!u) continue;
      if (t.state === 'servicing' && t.serving?.action === 'unload' && t.at === u.location) continue;
      const load = t.orders.find((o) => o.action === 'load');
      const good = t.cargo?.good ?? (load ? this.town.locations[load.location].good : null);
      if (good === null || good === undefined) continue;
      const key = claimKey(u.location, good);
      this.claimed.set(key, (this.claimed.get(key) ?? 0) + 1);
    }
    const unclaimed = (q: LocationState, g: number) => (q.order ? (q.order.wants[g] ?? 0) - (this.claimed.get(claimKey(q.id, g)) ?? 0) : 0);
    const goods = this.cfg.town.goods.length;
    const shops = this.locations.filter((l) => l.kind === 'consumer' && !l.closed && l.order && [...Array(goods).keys()].some((g) => unclaimed(l, g) > 0));
    if (shops.length === 0) return;
    const producers = this.locations.filter((l) => l.kind === 'producer' && !l.closed);
    // Each producer's pickups: its stock now, what it makes as time goes on, and the trucks already
    // on their way to load there. A pickup is planned only if there'll be a pallet when it arrives.
    const cyc = this.cfg.cycles;
    const perSec = new Map(producers.map((p) => [p.id, cyc.producerCycles ? cycleRate(p, cyc) / p.cycleSec : 0]));
    const capOf = (p: LocationState) => (cyc.producerCycles ? cycleRate(p, cyc) * cyc.carryCycles : p.stock);
    const pickups = new Map<number, number>(producers.map((p) => [p.id, 0]));
    for (const t of this.trucks.trucks) {
      if (t.cargo !== null) continue;
      const l = t.orders.find((o) => o.action === 'load');
      if (l && pickups.has(l.location)) pickups.set(l.location, pickups.get(l.location)! + 1);
    }
    const prodById = new Map(producers.map((p) => [p.id, p]));
    const hasPallet = (producer: number, at: number) => {
      const p = prodById.get(producer)!;
      const made = Math.min(capOf(p), p.stock + perSec.get(producer)! * Math.max(0, at - this.t));
      return made - pickups.get(producer)! >= 1;
    };
    // When and where each truck is next free: now and here, or at its shop when it delivers.
    const avail: { truck: Truck; at: number; node: number; depots: number[] }[] = [];
    for (const t of this.trucks.trucks) {
      const depots = this.depotsOf(t.company);
      if (depots.length === 0) continue;
      const u = t.orders.find((o) => o.action === 'unload');
      if (u) avail.push({ truck: t, at: Math.max(this.t, this.eta.get(t.id) ?? this.t), node: this.town.locations[u.location].node, depots });
      else if (t.cargo === null) avail.push({ truck: t, at: this.t, node: t.state === 'driving' && t.path.length ? t.path[0] : t.node, depots });
    }
    // Every truck against every shop it serves: its best producer and factory, and when it'd arrive.
    // Better-paying and focused shops count as sooner (a pallet's worth is in the comparison).
    const pairs: { a: number; shop: LocationState; good: number; producer: number; depot: number; duration: number; arrive: number; key: number }[] = [];
    avail.forEach((v, a) => {
      const c = this.companies[v.truck.company];
      for (const q of shops) {
        if (!this.serves(c.id, q.id)) continue;
        for (let g = 0; g < goods; g++) {
        if (unclaimed(q, g) < 1) continue;
        let bestLen = Infinity;
        let producer = -1;
        let depot = -1;
        for (const p of producers) {
          if (p.good !== g || p.stock + perSec.get(p.id)! * 600 - pickups.get(p.id)! < 1) continue;
          for (const d of v.depots) {
            const len = this.tripLength(v.node, d, p.id, q.id);
            if (len < bestLen) {
              bestLen = len;
              producer = p.id;
              depot = d;
            }
          }
        }
        if (!Number.isFinite(bestLen)) continue;
        const duration = bestLen / speed + extra;
        const arrive = v.at + duration;
        const focused = c.focus.includes(q.id) || c.focus.includes(producer);
        const worth = (q.price ?? this.cfg.money.palletPrice) / this.cfg.money.palletPrice;
        pairs.push({ a, shop: q, good: g, producer, depot, duration, arrive, key: (arrive - this.t + 4) / worth / (focused ? 3 : 1) });
        }
      }
    });
    pairs.sort((x, y) => x.key - y.key || x.a - y.a || x.shop.id - y.shop.id || x.good - y.good);
    const open = new Map<number, number>();
    for (const q of shops) for (let g = 0; g < goods; g++) open.set(claimKey(q.id, g), unclaimed(q, g));
    const taken = new Set<number>();
    for (const pr of pairs) {
      const key = claimKey(pr.shop.id, pr.good);
      if (taken.has(pr.a) || (open.get(key) ?? 0) < 1) continue;
      const v = avail[pr.a];
      // Its producer, or the next nearest that'll have a pallet when it gets there.
      const toP = (p: number) => v.at + this.distFrom(v.node)[this.town.locations[p].node] / speed;
      if (!hasPallet(pr.producer, toP(pr.producer))) {
        let alt = -1;
        let altDepot = -1;
        let altLen = Infinity;
        for (const p of producers) {
          if (p.good !== pr.good || !hasPallet(p.id, toP(p.id))) continue;
          for (const d of v.depots) {
            const len = this.tripLength(v.node, d, p.id, pr.shop.id);
            if (len < altLen) {
              altLen = len;
              alt = p.id;
              altDepot = d;
            }
          }
        }
        if (alt < 0 || !Number.isFinite(altLen)) continue;
        pr.producer = alt;
        pr.depot = altDepot;
        pr.duration = altLen / speed + extra;
      }
      taken.add(pr.a);
      open.set(key, open.get(key)! - 1);
      pickups.set(pr.producer, pickups.get(pr.producer)! + 1);
      const truck = avail[pr.a].truck;
      this.plan.set(truck.id, { depot: pr.depot, producer: pr.producer, consumer: pr.shop.id, good: pr.good, duration: pr.duration });
      this.planFreeAt.set(truck.id, avail[pr.a].at);
    }
    // Trucks with nothing planned: when they're due free, so one coming free unplanned triggers a replan.
    for (const v of avail) if (!this.planFreeAt.has(v.truck.id)) this.planFreeAt.set(v.truck.id, v.at);
    // Free now with nothing to do: no point planning again just for them until something changes.
    this.idleAtPlan = new Set(avail.filter((v) => v.at <= this.t && !this.plan.has(v.truck.id)).map((v) => v.truck.id));
  }

  /** Drive distance from a node to a producer, through a factory, to a shop (one trip). */
  private tripLength(from: number, depot: number, producer: number, consumer: number): number {
    const p = this.town.locations[producer].node;
    const q = this.town.locations[consumer].node;
    const d = this.town.locations[depot].node;
    const via = this.cfg.trucks.viaDepot;
    const toP = this.distFrom(from)[p];
    return via === 'none' ? toP + this.distFrom(p)[q] : toP + this.distFrom(p)[d] + this.distFrom(d)[q];
  }

  /** Put a truck on a route: its orders, and the route it's on. */
  private sendOnRoute(truck: Truck, depot: number, producer: number, consumer: number) {
    truck.depot = depot;
    truck.home = this.town.locations[depot].node;
    const load = { location: producer, action: 'load' as const };
    const unload = { location: consumer, action: 'unload' as const };
    const sign = { location: depot, action: 'signOff' as const };
    const via = this.cfg.trucks.viaDepot;
    this.trucks.setOrders(truck, via === 'hub' ? [load, sign, unload, sign] : via === 'loaded' ? [load, sign, unload] : [load, unload], this.t);
    truck.route = routeKey(depot, producer, consumer);
  }

  /** Every route in play, from the trucks' assignments. */
  routes(): Route[] {
    const byKey = new Map<string, Route>();
    for (const t of this.trucks.trucks) {
      if (!t.route) continue;
      let r = byKey.get(t.route);
      if (!r) {
        const [depot, producer, consumer] = t.route.split('>').map(Number);
        r = { key: t.route, company: t.company, depot, producer, consumer, trucks: 0 };
        byKey.set(t.route, r);
      }
      r.trucks++;
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  private nextOpeningAt = -1;

  /** Open a new producer or consumer on an empty lot, about once a minute. */
  private maybeOpen() {
    const o = this.cfg.openings;
    if (o.everySec <= 0) return;
    if (this.nextOpeningAt < 0) this.nextOpeningAt = o.quietStartSec + this.rng.exp(o.everySec);
    if (this.t < this.nextOpeningAt || this.t > this.cfg.durationSec - o.quietEndSec) return;
    this.nextOpeningAt = this.t + this.rng.exp(o.everySec);
    const live = this.locations.map((s) => this.town.locations[s.id]);
    const choice = chooseOpening(this.town, live, o, this.rng);
    if (!choice) return;
    const loc = openOnLot(this.town, choice.lot, choice.kind, choice.good);
    const state = newLocationState(loc, this.cfg.cycles, this.rng, this.t);
    state.level = Math.max(1, Math.min(this.cfg.cycles.maxLevel, o.openLevel));
    if (state.kind === 'consumer') state.price = this.rng.next() < this.cfg.money.premiumShare ? this.cfg.money.premiumPrice : this.cfg.money.palletPrice;
    this.locations.push(state);
    this.locById.set(state.id, state);
    this.emit('all', { type: 'opened', t: this.t, location: loc.id, kind: choice.kind, good: choice.good });
  }

  /**
   * Every `newSiteEverySec` (from that long in, until the last two minutes), a new unclaimed factory
   * site appears on an empty lot in the worst-served part of town: where the most businesses are
   * far from every factory. Turns dead zones into something to race for.
   */
  private maybeNewSite() {
    const every = this.cfg.depots.newSiteEverySec;
    if (every <= 0 || this.t > this.cfg.durationSec - 120) return;
    const k = Math.round(this.t / this.cfg.tickSec);
    const period = Math.round(every / this.cfg.tickSec);
    if (k === 0 || k % period !== 0) return;
    const depots = this.town.locations.filter((l) => l.kind === 'depot');
    const nearestDepot = (x: number, y: number) => Math.min(...depots.map((d) => Math.hypot(d.x - x, d.y - y)));
    const far = this.locations.map((st) => this.town.locations[st.id]).filter((l) => nearestDepot(l.x, l.y) > 4);
    let best: { id: number; score: number; room: number } | null = null;
    for (const lot of this.town.locations) {
      if (lot.kind !== 'lot') continue;
      const room = nearestDepot(lot.x, lot.y);
      if (room < this.town.cfg.depotGap) continue;
      const score = far.filter((l) => Math.hypot(l.x - lot.x, l.y - lot.y) <= 4).length;
      if (!best || score > best.score || (score === best.score && room > best.room)) best = { id: lot.id, score, room };
    }
    if (!best) return;
    const site = this.town.locations[best.id];
    site.kind = 'depot';
    site.good = null;
    site.level = 1;
    site.bays = 0;
    site.startCompany = null;
    this.emit('all', { type: 'siteOpened', t: this.t, site: site.id });
  }

  /** Trucks based at a depot site (where they wait when free). */
  trucksAt(site: number): number {
    return this.trucks.trucks.filter((t) => t.depot === site).length;
  }

  /** A company's trucks. */
  trucksOf(company: number): number {
    return this.trucks.trucks.filter((t) => t.company === company).length;
  }

  /** How many trucks a company may own: each of its factories adds `capacity`. */
  truckLimit(company: number): number {
    return this.depotsOf(company).length * this.cfg.depots.capacity;
  }

  /** Depot sites a company owns. */
  depotsOf(company: number): number[] {
    return [...this.depotOwner].filter(([, c]) => c === company).map(([s]) => s).sort((a, b) => a - b);
  }

  /**
   * A company's progress (0 to 1) towards the full discount at a site: its pickups and deliveries in
   * the site's district over the subsidy window, against the target. 0 below the minimum.
   */
  districtShare(company: number, site: number): number {
    const n = this.districtCounts(site)[company];
    const cfg = this.cfg.depots;
    if (n < cfg.subsidyMinPallets) return 0;
    return Math.min(1, n / cfg.subsidyTarget);
  }

  /** Pallets loaded and delivered per company in a site's district over the subsidy window (cached per tick). */
  private districtCounts(site: number): number[] {
    if (this.districtCache.t !== this.t) this.districtCache = { t: this.t, counts: new Map() };
    const hit = this.districtCache.counts.get(site);
    if (hit) return hit;
    const cfg = this.cfg.depots;
    const cutoff = this.t - cfg.subsidyWindowSec;
    if (this.service.length && this.service[0].t < cutoff) this.service = this.service.filter((s) => s.t >= cutoff);
    const d = this.siteDistances.get(site) ?? distancesFrom(this.town.graph, this.town.locations[site].node);
    this.siteDistances.set(site, d);
    const counts = this.companies.map(() => 0);
    for (const s of this.service) if (d[s.node] <= cfg.districtBlocks) counts[s.company]++;
    this.districtCache.counts.set(site, counts);
    return counts;
  }
  private districtCache: { t: number; counts: Map<number, number[]> } = { t: -1, counts: new Map() };
  /** Shop orders: when each truck that's been sent is expected to have delivered. */
  private eta = new Map<number, number>();
  /** The delivery plan: each planned truck's next trip, and how long it takes. */
  private plan = new Map<number, { depot: number; producer: number; consumer: number; good: number; duration: number }>();
  /** When each truck was expected to be free, as of the last plan. */
  private planFreeAt = new Map<number, number>();
  /** Pallets each shop has claimed by trucks already sent, per good (key: claimKey). */
  private claimed = new Map<number, number>();
  /** Something the plan depends on changed. */
  private replan = true;
  private nextReplanAt = 0;
  private lastPlanAt = -Infinity;
  private idleAtPlan = new Set<number>();
  /** How many times the plan's been made (for measuring). */
  plans = 0;

  /** Drive distances from a depot site (cached). */
  private siteDist(site: number): Float64Array {
    const d = this.siteDistances.get(site) ?? distancesFrom(this.town.graph, this.town.locations[site].node);
    this.siteDistances.set(site, d);
    return d;
  }

  /** A company's nearest depot to a road node, and the drive distance to it. */
  nearestDepot(company: number, node: number): { node: number; dist: number } | null {
    let best: { node: number; dist: number } | null = null;
    for (const [site, owner] of this.depotOwner) {
      if (owner !== company) continue;
      const dist = this.siteDist(site)[node];
      if (!best || dist < best.dist) best = { node: this.town.locations[site].node, dist };
    }
    return best;
  }

  /** What a depot site would cost this company now. */
  depotPriceFor(company: number, site: number): number {
    if (this.cfg.depots.pricing === 'subsidy') return subsidisedPrice(this.cfg.depots, this.districtShare(company, site));
    // Distance pricing, using the site's cached distances (roads are undirected).
    const d = this.siteDistances.get(site) ?? distancesFrom(this.town.graph, this.town.locations[site].node);
    this.siteDistances.set(site, d);
    const own = this.depotsOf(company).map((s) => this.town.locations[s].node);
    return depotPrice(this.cfg.depots, own.length ? Math.min(...own.map((n) => d[n])) : Infinity);
  }

  /** Dynamic state of a producer or consumer, by its town location id. */
  location(id: number): LocationState | undefined {
    return this.locById.get(id);
  }

  /**
   * Each player's holding in each company, and when they came to hold that many (a counter, in the
   * order holdings changed): a tie for the most shares goes to whoever got there first.
   */
  private holdings: Map<number, { n: number; since: number }>[] = [];
  private holdingSeq = 0;

  /** Note any change in who holds how many of a company's shares (a changed holding starts afresh). */
  private syncHoldings(company: number) {
    const h = (this.holdings[company] ??= new Map());
    const counts = new Map<number, number>();
    for (const owner of this.companies[company].shares) if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    for (const p of [...h.keys()]) if (!counts.has(p)) h.delete(p);
    for (const [p, n] of [...counts].sort((a, b) => a[0] - b[0])) if (h.get(p)?.n !== n) h.set(p, { n, since: this.holdingSeq++ });
  }

  /**
   * The company's president, as a list (empty if no player holds a share): whoever holds the most
   * shares. A tie goes to whoever got to that many first, so a president keeps the company until
   * someone holds more, and if the president sells down, the longest-standing of the biggest holders
   * takes over.
   */
  presidents(company: number): number[] {
    return this.succession(company).slice(0, 1);
  }

  /** The company's shareholders in line of succession: the president first, then who'd take over, and so on. */
  succession(company: number): number[] {
    this.syncHoldings(company);
    return [...this.holdings[company]].sort((a, b) => b[1].n - a[1].n || a[1].since - b[1].since).map(([p]) => p);
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
        area: [...c.area],
        focus: [...c.focus],
        presidents: this.presidents(c.id),
        succession: this.succession(c.id),
        dividendPerShare: c.pot / c.shares.length,
      })),
      nextPayoutAt: this.nextPayoutAt,
      locations: this.locations.map((l) => ({ ...l, history: [...l.history] })),
      routes: this.routes(),
      trucks: this.trucks.trucks.map((t) => ({
        ...t,
        path: [...t.path],
        orders: t.orders.map((o) => ({ ...o, via: o.via ? [...o.via] : undefined })),
        cargo: t.cargo ? { ...t.cargo } : null,
        berth: t.berth ? { ...t.berth } : null,
        pendingOrders: t.pendingOrders ? [...t.pendingOrders] : null,
        ...this.trucks.position(t),
      })),
      queues: Object.fromEntries([...this.trucks.queues].map(([k, v]) => [k, [...v]])),
      depots: Object.fromEntries(this.depotOwner),
      depotPrices: Object.fromEntries(
        this.town.locations
          .filter((l) => l.kind === 'depot' && !this.depotOwner.has(l.id))
          .map((l) => [l.id, this.companies.map((c) => this.depotPriceFor(c.id, l.id))]),
      ),
      sales: this.sales.map((x) => ({ ...x, passed: [...x.passed] })),
      books: this.books.map((b) => ({ bid: b.bid ? { ...b.bid } : null, ask: b.ask ? { ...b.ask } : null })),
      companyBid: this.companies.map((c) => this.companyBid(c.id)),
      minPrice: this.companies.map((c) => this.minPrice(c.id)),
      value: this.companies.map((c) => this.companyValue(c.id)),
      saleCooldownUntil: [...this.saleCooldownUntil],
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
      holdings: this.holdings.map((h) => [...h].sort((a, b) => a[0] - b[0])),
      sales: this.sales,
      books: this.books,
      saleCooldownUntil: this.saleCooldownUntil,
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
