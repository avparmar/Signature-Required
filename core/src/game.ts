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
import { initLocations, newLocationState, raiseLevel, updateCycles, type CycleEvent, type LocationState } from './economy.js';
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
}

/** opening: the opening share sales, before the game clock starts. */
export type Phase = 'opening' | 'running' | 'ended';

// ------------------------------------------------------------------ routes

/** A standing assignment: trucks based at `depot` carry `producer`'s good to `consumer`. */
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
  | { type: 'start'; t: number }
  | { type: 'boughtTruck'; t: number; company: number; truck: number; depot: number; price: number }
  | { type: 'boughtDepot'; t: number; company: number; site: number; price: number }
  | { type: 'invested'; t: number; player: number; location: number; level: number; price: number }
  | { type: 'opened'; t: number; location: number; kind: 'producer' | 'consumer'; good: number }
  | { type: 'routeChanged'; t: number; company: number; depot: number; producer: number; consumer: number; trucks: number }
  /** A route lost one of its ends (closure); its trucks are free again at the depot. */
  | { type: 'routeLost'; t: number; company: number; depot: number; producer: number; consumer: number; trucks: number }
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
  companies: (Company & { presidents: number[]; dividendPerShare: number })[];
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
      },
    );
    this.events = Array.from({ length: cfg.players }, () => []);
    this.saleCooldownUntil = this.companies.map(() => 0);
    this.books = this.companies.map(() => ({ bid: null, ask: null }));
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
    this.updateSales();
    if (this.phase === 'opening') return; // the town waits until the opening round is over

    for (const e of updateCycles(this.locations, this.t, this.cfg.cycles, this.rng)) {
      this.emit('all', e);
      if (e.type === 'closed') this.removeLocation(e.location);
    }
    this.maybeOpen();
    this.maybeNewSite();
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
      case 'assignRoute':
      case 'unassignRoute': {
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
          c.treasury -= price;
          seller.cash += price;
          this.emit('all', { type: 'trade', t: this.t, company: c.id, buyer: 'company', seller: player, price });
        } else {
          const bid = this.books[c.id].bid;
          if (!bid) return reject('nobody is bidding for a share of this company');
          // During the company's own sale, its bids are for the company's share: the money goes to the company.
          if (this.sales.some((x) => x.company === c.id)) return reject("the company is selling a share: its bids are for that one, so you can't sell yours to them now");
          if (bid.player === player) return reject("that's your own bid");
          this.books[c.id].bid = null;
          const buyer = this.players[bid.player];
          buyer.held -= bid.price;
          buyer.cash -= bid.price;
          seller.cash += bid.price;
          c.shares[c.shares.indexOf(player)] = bid.player;
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
        if (!sale) return reject('that company has no sale running');
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
        if (this.phase !== 'running') return reject('sales open once the game starts');
        const c = this.companies[action.company];
        if (!c) return reject(`no company ${action.company}`);
        if (!c.shares.includes(null)) return reject('the company has no shares of its own left to sell');
        if (this.sales.some((x) => x.company === c.id)) return reject('this company already has a sale running');
        if (this.elapsed < this.saleCooldownUntil[c.id] - 1e-9)
          return reject(`it held a sale recently; try again in ${Math.ceil(this.saleCooldownUntil[c.id] - this.elapsed)}s`);
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
      routes: this.routes(),
      trucks: this.trucks.trucks.map((t) => ({
        ...t,
        path: [...t.path],
        orders: t.orders.map((o) => ({ ...o, via: o.via ? [...o.via] : undefined })),
        cargo: t.cargo ? { ...t.cargo } : null,
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
