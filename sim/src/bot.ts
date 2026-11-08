/**
 * A simple investor bot. It only uses what any player can see: the town, the config, the
 * observation and public events.
 *
 * - Bidding: values a share as the dividends it expects the company to pay for the rest of the
 *   game (from its fleet, or the fleet the money would buy) plus its slice of the final asset
 *   payout, and bids up to a fraction of that. Winning control is worth a little extra.
 * - As president: plans what it wants to buy next and sells a bank share for it if it could pay 75%
 *   of the price itself (and backs the sale with its own bid), buys a truck while one will still
 *   earn a fair part of its price by the end, sends each new or idle truck to the best producer -> consumer route near its depot
 *   (avoiding routes that are already crowded), and buys a nearby depot when its depots are full.
 * - Spare cash: occasionally levels up the bottleneck location on a route its companies run.
 */
import {
  truckPriceFor,
  minimumBid,
  distanceToNetwork,
  distancesFrom,
  investCost,
  type Action,
  type GameConfig,
  type GameEvent,
  type Location,
  type Observation,
  type Town,
} from '@sr/core';

export interface BotPersonality {
  /** Bid up to this fraction of a share's estimated value. */
  greed: number;
  /** Expects the company to reinvest what it earns (more trucks, then more factories) when valuing
   *  its shares, rather than only counting the fleet its cash can buy today. */
  growth?: boolean;
  /** Never put more than this share of available cash into one bid. */
  maxCashPerBid: number;
  /** Extra value (as a fraction) for a share that would make this bot president. */
  controlBonus: number;
  /** Keep at least this much cash before investing in locations. */
  investReserve: number;
  /**
   * Speculator: believes developing a company it controls will pay off, so it picks one company
   * and goes all in on it, valuing its shares as if the company will be fully funded and built
   * out. It keeps a reserve to buy into other companies, but only at a discount.
   */
  /**
   * Controller: eager to run one company (the one with the most routes near its start, or the one
   * it ends up leading) and bids for its shares whenever that helps it take or keep control, but
   * never more than `budget` for one share. Elsewhere it bids like anyone else.
   */
  controller?: { budget: number };
  speculator?: {
    /** What it assumes the company's other shares will eventually sell for (never anchors on a $0 bid). */
    assumedSharePrice: number;
    /** Share of starting cash it won't spend on its own company, kept for bargains elsewhere. */
    reserveFrac: number;
    /** Buys into other companies only below this fraction of their value. */
    discount: number;
  };
}

export const PERSONALITIES: Record<string, BotPersonality> = {
  balanced: { growth: true, greed: 0.8, maxCashPerBid: 0.6, controlBonus: 0.25, investReserve: 60 },
  cautious: { growth: true, greed: 0.6, maxCashPerBid: 0.4, controlBonus: 0.1, investReserve: 90 },
  aggressive: { growth: true, greed: 1.0, maxCashPerBid: 0.8, controlBonus: 0.4, investReserve: 40 },
  controller: { growth: true, greed: 0.9, maxCashPerBid: 0.8, controlBonus: 0.5, investReserve: 40, controller: { budget: 40 } },
  speculator: {
    growth: true,
    greed: 1.0,
    maxCashPerBid: 1.0,
    controlBonus: 0.5,
    investReserve: 40,
    speculator: { assumedSharePrice: 25, reserveFrac: 0.25, discount: 0.5 },
  },
};

/**
 * Rules of thumb, scaled from what the #5 demo measured at the original settings (trucks at 0.25
 * blocks/s made ~1 delivery a minute; a route saturated at ~3 trucks when a consumer wanted ~3
 * pallets every 45s).
 */
function deliveriesPerTruckMin(cfg: GameConfig): number {
  return 1.0 * (cfg.trucks.speed / 0.25);
}
function trucksPerRoute(cfg: GameConfig): number {
  const c = cfg.cycles;
  const demand = c.palletsPerLevel * c.startLevel;
  const supply = c.palletsPerLevel * c.startLevel;
  const palletsPerMin = (Math.min(demand, supply) * 60) / ((cfg.cycles.cycleSec[0] + cfg.cycles.cycleSec[1]) / 2);
  return Math.max(1, Math.round(palletsPerMin / deliveriesPerTruckMin(cfg) * 0.75));
}

/** A company's sale, as a bidder sees it. */
interface SaleView {
  company: number;
  highBid: number;
  highBidder: number | null;
  /** The least a new bid must be to beat the standing one and count (the company's minimum price). */
  min: number;
}

interface Route {
  /** Depot (town location id) the route runs from. */
  depot: number;
  producer: number;
  consumer: number;
  /** Rough round trip from the company's depot, in blocks. */
  length: number;
}

export class Bot {
  private lastThink = -Infinity;
  private lastInvest = -Infinity;
  private lastBuyIn = -Infinity;
  private lastOrder = -Infinity;
  /** When it started a sale of each company (to remember its plans until the sale is on). */
  private startedAt = new Map<number, number>();
  /** Auctions it started to buy into a company, and the opening bid it means to make. */
  private buyInBid = new Map<number, number>();
  /** Deliveries per company in the last few minutes (from events). */
  private recent: { t: number; company: number; price: number }[] = [];

  private readonly perTruckMin: number;
  private readonly perRoute: number;

  constructor(
    readonly me: number,
    private town: Town,
    private cfg: GameConfig,
    readonly personality: BotPersonality = PERSONALITIES.balanced,
    /** Seconds between full decisions (bids are answered every step). */
    private thinkEverySec = 1,
  ) {
    this.perTruckMin = deliveriesPerTruckMin(cfg);
    this.perRoute = trucksPerRoute(cfg);
  }

  decide(obs: Observation, events: GameEvent[]): Action[] {
    return this.tidy(obs, this.think(obs, events));
  }

  /**
   * Last look over its orders against the book as it stands: a bid at or above someone's asking
   * price buys their share instead (cheaper, and at once); a bid the game would turn down as too
   * low, or a second bid on the same company, is dropped.
   */
  private tidy(obs: Observation, actions: Action[]): Action[] {
    const out: Action[] = [];
    const bidOn = new Set<number>();
    const me = obs.players[this.me];
    for (const a of actions) {
      if (a.type !== 'bid') {
        out.push(a);
        continue;
      }
      if (bidOn.has(a.company)) continue;
      bidOn.add(a.company);
      const book = obs.books[a.company];
      if (book.ask && book.ask.player !== this.me && a.amount >= book.ask.price) {
        if (obs.phase === 'running' && me.cash - me.held >= book.ask.price) out.push({ type: 'buy', company: a.company });
        continue;
      }
      if (a.amount < Math.max(minimumBid(book, this.me, this.cfg.auctions), obs.minPrice[a.company])) continue;
      out.push(a);
    }
    return out;
  }

  private think(obs: Observation, events: GameEvent[]): Action[] {
    for (const e of events) {
      if (e.type === 'delivered') this.recent.push({ t: obs.t, company: e.company, price: e.price });
      if (e.type === 'opened' || e.type === 'closed') this.routeCache.clear(); // the map changed
    }
    this.recent = this.recent.filter((r) => r.t > obs.t - 180);
    // A share sale it started is over: forget the price it meant to pay (kept a moment for the sale to start).
    const selling = (c: number) => obs.sales.some((x) => x.company === c);
    for (const [c, since] of [...this.startedAt]) if (!selling(c) && obs.elapsed - since > 1.5) {
      this.raiseFloor.delete(c);
      this.buyInBid.delete(c);
      this.startedAt.delete(c);
    }
    const out: Action[] = [];
    // Sales running: bid on at most one per look (its cash is held, so the next look sees what's left),
    // and pass on the others it isn't bidding in, so they can end early.
    let bidding = false;
    for (const sale of obs.sales) {
      const bid = bidding ? null : this.bid(obs, sale.company);
      if (bid) {
        out.push(bid);
        bidding = true;
      } else if (obs.books[sale.company].bid?.player !== this.me && !sale.passed.includes(this.me) && !this.wantsToBid(obs, sale.company))
        out.push({ type: 'pass', company: sale.company });
    }
    if (obs.elapsed - this.lastThink < this.thinkEverySec) return out;
    this.lastThink = obs.elapsed;
    if (obs.phase === 'running') {
      for (const c of obs.companies) if (c.presidents.includes(this.me)) out.push(...this.runCompany(obs, c.id));
      const buyIn = this.buyIn(obs);
      if (buyIn) out.push(buyIn);
      const trade = this.trade(obs);
      if (trade) out.push(trade);
      const inv = this.invest(obs);
      if (inv) out.push(inv);
    }
    return out;
  }

  // ---------------------------------------------------------------- valuing and bidding

  /** Minutes of play left (the whole game during the opening round). */
  private minutesLeft(obs: Observation) {
    return obs.phase === 'opening' ? this.cfg.durationSec / 60 : obs.timeLeft / 60;
  }

  /**
   * Expected value of one share of a company if `extraCash` were added to its treasury: the
   * dividends it will pay, plus (with `exit`) about what it could be sold back to the company for
   * near the end, discounted because only the first few sellers get the company's price.
   */
  shareValue(obs: Observation, company: number, extraCash: number, optimistic = false, exit = true): number {
    const c = obs.companies[company];
    const trucks = obs.trucks.filter((t) => t.company === company).length;
    // An optimist assumes the company will buy the depots it needs; otherwise count what it has.
    const capacity = optimistic
      ? Infinity
      : Object.values(obs.depots).filter((o) => o === company).length * this.cfg.depots.capacity;
    // The company will also raise money from its other unsold shares, at about this price.
    const unsoldAfter = Math.max(0, c.shares.filter((s) => s === null).length - 1);
    // A cheap bid today doesn't mean the company stays broke: its other shares will sell too, for at
    // least about a truck's price each (enough to get it going), whatever this one goes for.
    const assumed = optimistic ? Math.max(extraCash, this.personality.speculator?.assumedSharePrice ?? 0) : Math.max(extraCash, this.cfg.depots.truckPrice);
    const futureRaise = unsoldAfter * assumed;
    const routes = new Set(this.routesFor(obs, company).map((r) => `${r.producer}-${r.consumer}`)).size;
    const m = this.cfg.money;
    const d = this.cfg.depots;
    const perTruckPerMin = this.perTruckMin * m.palletPrice;
    // What it's been earning recently counts as a floor on its fleet's earning power.
    const recentPerMin = this.recent.filter((r) => r.company === company).reduce((sum, r) => sum + r.price, 0) / 3;
    // Play the rest of the game forward a minute at a time: the company spends its cash (and later its
    // retained earnings) on trucks, and once its factories are full, on another factory, which opens
    // up more routes.
    let cash = c.treasury + extraCash + futureRaise;
    let fleet = trucks;
    let cap = capacity;
    let routeCap = Math.max(1, routes) * this.perRoute;
    const factoryPrice = d.depotBase * (1 - d.maxSubsidy / 2);
    let assets = c.assets;
    let dividends = 0;
    const mins = Math.max(0, Math.round(this.minutesLeft(obs) - 1)); // the last stretch is discounted
    const buy = () => {
      for (;;) {
        const tp = truckPriceFor(d, fleet);
        if (fleet < Math.min(cap, routeCap) && cash >= tp) {
          cash -= tp;
          assets += tp;
          fleet++;
        } else if (this.personality.growth && fleet >= cap && cap !== Infinity && cash >= factoryPrice + tp) {
          cash -= factoryPrice;
          assets += factoryPrice;
          cap += d.capacity;
          routeCap += d.capacity;
        } else return;
      }
    };
    buy();
    for (let k = 0; k < mins; k++) {
      const perMin = Math.max(recentPerMin, fleet * perTruckPerMin);
      dividends += (perMin * m.deliveryToPot) / c.shares.length;
      cash += perMin * m.deliveryToTreasury;
      if (this.personality.growth) buy();
    }
    // Final payout bonus (if the config has one): a share of everything the company holds by then.
    const lastPerMin = Math.max(recentPerMin, fleet * perTruckPerMin);
    const bonus =
      m.finalBonus === 'earnings'
        ? (m.finalEarningsMultiple * lastPerMin * (m.payoutEverySec / 60)) / c.shares.length
        : (m.finalAssetShare * (assets + cash)) / c.shares.length;
    // Selling back to the company before the end: half its value per share then, about half the time.
    const buyback = exit ? 0.5 * ((this.cfg.auctions.buybackShare * (assets + cash)) / c.shares.length) : 0;
    return dividends + bonus + buyback;
  }

  /** Companies it's raising money for by selling a bank share, and what it will pay for that share itself. */
  private raiseFloor = new Map<number, number>();

  /** What one truck earns its company per minute (deliveries at the average price). */
  private get truckPerMin() {
    const m = this.cfg.money;
    return this.perTruckMin * (m.palletPrice * (1 - m.premiumShare) + m.premiumPrice * m.premiumShare);
  }

  /**
   * What a truck bought now will earn its company by the end of the game. Cash in the treasury is
   * worth little to shareholders (only its slice of the final payout), while a truck's deliveries
   * pay dividends, so a truck is worth buying as long as it will earn a fair part of its price.
   */
  truckReturn(obs: Observation): number {
    return this.truckPerMin * Math.max(0, this.minutesLeft(obs) - 0.75);
  }

  /** Experiments: how a company's trucks are bought ('greedy': whenever there's room and money). */
  static truckPolicy: ((company: number) => 'greedy' | 'default') | null = null;

  /** Controller's company (decided at its first auction). */
  private controlTarget: number | null = null;

  private controllerBid(obs: Observation, a: SaleView): Action | null {
    const budget = this.personality.controller!.budget;
    if (this.controlTarget === null) this.controlTarget = this.pickTarget(obs);
    // Someone else has the target locked up: switch to the company it leads, or holds most of.
    const target = obs.companies[this.controlTarget];
    const holds = (c: { shares: (number | null)[] }) => c.shares.filter((s) => s === this.me).length;
    if (!target.presidents.includes(this.me) && target.shares.every((s) => s !== null)) {
      const led = obs.companies.find((c) => c.presidents.includes(this.me));
      const most = [...obs.companies].sort((x, y) => holds(y) - holds(x))[0];
      this.controlTarget = (led ?? (holds(most) > 0 ? most : target)).id;
    }
    if (a.company !== this.controlTarget) return this.plainBid(obs, a);
    const me = obs.players[this.me];
    const available = me.cash - me.held;
    const min = a.min;
    if (min > Math.min(budget, available)) return null;
    return { type: 'bid', company: a.company, amount: min };
  }

  /** Speculator's chosen company (decided at its first look). */
  private target: number | null = null;

  /** The company whose starting depot has the most routes nearby. */
  private pickTarget(obs: Observation): number {
    let best = 0;
    let bestRoutes = -1;
    for (const c of obs.companies) {
      const n = this.routesFor(obs, c.id).length;
      if (n > bestRoutes) {
        bestRoutes = n;
        best = c.id;
      }
    }
    return best;
  }

  private speculatorBid(obs: Observation, a: SaleView): Action | null {
    const spec = this.personality.speculator!;
    if (this.target === null) this.target = this.pickTarget(obs);
    const c = obs.companies[a.company];
    // If someone else has locked up the target, switch to wherever it holds the most.
    const mine = c.shares.filter((s) => s === this.me).length;
    if (a.company !== this.target && mine > 0 && obs.companies[this.target].shares.every((s) => s !== null) && !obs.companies[this.target].presidents.includes(this.me))
      this.target = a.company;
    const me = obs.players[this.me];
    const available = me.cash - me.held;
    const min = a.min;
    const value = this.shareValue(obs, a.company, min, true);
    if (a.company === this.target) {
      // All in on its own company, minus the reserve kept for bargains.
      const reserve = spec.reserveFrac * this.cfg.startingCash;
      if (min > available - reserve) return null;
      const cap = Math.min(available - reserve, value * (1 + this.personality.controlBonus) * this.personality.greed);
      if (min > cap) return null;
      // It wants the company funded, not just owned: pay at least its assumed share price,
      // even if nobody else is bidding (a $0 win would leave its own company broke).
      return { type: 'bid', company: a.company, amount: Math.max(min, Math.min(spec.assumedSharePrice, cap)) };
    }
    // Elsewhere: only a bargain.
    if (min > available || min > value * spec.discount) return null;
    return { type: 'bid', company: a.company, amount: min };
  }

  /** Bidding in a company's sale: what the standing bid is, and the least that would beat it and count. */
  private saleView(obs: Observation, company: number): SaleView {
    const book = obs.books[company];
    const beat = book.bid ? book.bid.price + this.cfg.auctions.minRaise : this.cfg.auctions.openingBid;
    return { company, highBid: book.bid?.price ?? 0, highBidder: book.bid?.player ?? null, min: Math.max(beat, obs.minPrice[company]) };
  }

  /** Whether it means to bid in this sale (it doesn't pass on sales it started, until it has bid). */
  private wantsToBid(obs: Observation, company: number): boolean {
    return (this.raiseFloor.has(company) || this.buyInBid.has(company)) && obs.books[company].bid?.player !== this.me;
  }

  private bid(obs: Observation, company: number): Action | null {
    const a = this.saleView(obs, company);
    if (a.highBidder === this.me) return null;
    // A share it put up to raise money for its own company: it backs the sale itself, up to its floor.
    const floor = this.raiseFloor.get(a.company);
    const me0 = obs.players[this.me];
    const min0 = a.min;
    // It bids its floor straight away (not the minimum, which can be $0), so the share can't go for nothing.
    if (floor !== undefined && min0 <= floor && min0 <= me0.cash - me0.held)
      return { type: 'bid', company: a.company, amount: Math.max(min0, Math.min(floor, Math.floor(me0.cash - me0.held))) };
    // A sale it started to buy in: open with the bid it planned.
    const open = this.buyInBid.get(a.company);
    if (open !== undefined && a.highBidder === null) {
      this.buyInBid.delete(a.company);
      if (open >= min0 && open <= me0.cash - me0.held) return { type: 'bid', company: a.company, amount: open };
    }
    if (this.personality.speculator) return this.speculatorBid(obs, a);
    if (this.personality.controller) return this.controllerBid(obs, a);
    return this.plainBid(obs, a);
  }

  private plainBid(obs: Observation, a: SaleView): Action | null {
    const me = obs.players[this.me];
    const available = me.cash - me.held;
    const min = a.min;
    if (min > available * this.personality.maxCashPerBid) return null;
    const c = obs.companies[a.company];
    const myShares = c.shares.filter((s) => s === this.me).length;
    const counts = new Map<number, number>();
    for (const s of c.shares) if (s !== null) counts.set(s, (counts.get(s) ?? 0) + 1);
    const top = Math.max(0, ...[...counts].filter(([p]) => p !== this.me).map(([, n]) => n));
    // A tie keeps the president, so taking a company over takes more shares than its president has.
    const wouldControl = myShares + 1 > top || (myShares + 1 === top && c.presidents.includes(this.me));
    let value = this.shareValue(obs, a.company, min);
    if (wouldControl && !c.presidents.includes(this.me)) value *= 1 + this.personality.controlBonus;
    // Defending its company: a rival winning this share would overtake it.
    const rival = a.highBidder;
    if (c.presidents.includes(this.me) && rival !== null && rival !== this.me && (counts.get(rival) ?? 0) + 1 > myShares)
      value *= 1 + this.personality.controlBonus;
    if (min > value * this.personality.greed) return null;
    return { type: 'bid', company: a.company, amount: min };
  }

  // ---------------------------------------------------------------- running a company

  /** Producer -> consumer routes within reach of a company's depots, best first. */
  routesFor(obs: Observation, company: number): Route[] {
    const depots = Object.entries(obs.depots)
      .filter(([, o]) => o === company)
      .map(([s]) => this.town.locations[Number(s)]);
    if (depots.length === 0) return [];
    const key = depots.map((d) => d.id).join(',');
    const cached = this.routeCache.get(key);
    if (cached) return cached;
    const result = this.computeRoutes(depots);
    this.routeCache.set(key, result);
    return result;
  }

  /** Routes depend on a company's depots and the live map; cached by depot set, cleared on openings/closures. */
  private routeCache = new Map<string, Route[]>();

  private computeRoutes(depots: Location[]): Route[] {
    const reach = 7;
    const routes: Route[] = [];
    for (const depot of depots) {
      const d = distancesFrom(this.town.graph, depot.node);
      const near = (l: Location) => d[l.node] <= reach;
      const producers = this.town.locations.filter((l) => l.kind === 'producer' && near(l));
      for (const p of producers) {
        const dp = distancesFrom(this.town.graph, p.node);
        for (const q of this.town.locations) {
          if (q.kind !== 'consumer' || q.good !== p.good || !near(q)) continue;
          // Length of one round trip, as the truck will drive it.
          const via = this.cfg.trucks.viaDepot;
          const length =
            via === 'hub'
              ? 2 * (d[p.node] + d[q.node])
              : via === 'loaded'
                ? d[p.node] + d[q.node] + dp[q.node]
                : d[p.node] + 2 * dp[q.node];
          routes.push({ depot: depot.id, producer: p.id, consumer: q.id, length });
        }
      }
    }
    // Shortest first. The same producer -> consumer pair can appear from several depots.
    return routes.sort((a, b) => a.length - b.length);
  }

  /** Whether a factory at this (free) site would have an uncrowded route of its own. */
  private siteHasRoute(obs: Observation, site: Location, load: Map<number, number>): boolean {
    const key = `site:${site.id}`;
    let routes = this.routeCache.get(key);
    if (!routes) {
      routes = this.computeRoutes([site]);
      this.routeCache.set(key, routes);
    }
    return routes.some((r) => Math.max(load.get(r.producer) ?? 0, load.get(r.consumer) ?? 0) < this.perRoute + 1);
  }

  /** Trucks (any company) already working a producer or consumer. */
  private load(obs: Observation): Map<number, number> {
    const m = new Map<number, number>();
    for (const t of obs.trucks) for (const s of t.orders) m.set(s.location, (m.get(s.location) ?? 0) + 1);
    return m;
  }

  private pickRoute(obs: Observation, company: number, load: Map<number, number>, fromDepot?: number): Route | null {
    let best: Route | null = null;
    let bestScore = -Infinity;
    for (const r of this.routesFor(obs, company)) {
      if (fromDepot !== undefined && r.depot !== fromDepot) continue;
      const busy = Math.max(load.get(r.producer) ?? 0, load.get(r.consumer) ?? 0);
      if (busy >= this.perRoute + 1) continue;
      const price = obs.locations.find((l) => l.id === r.consumer)?.price ?? this.cfg.money.palletPrice;
      const score = (price / (r.length + 4)) * (1 - busy / (this.perRoute + 1));
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  private runCompany(obs: Observation, company: number): Action[] {
    const out: Action[] = [];
    const c = obs.companies[company];
    const cfg = this.cfg.depots;
    const load = this.load(obs);

    // Put every free truck (idle at its depot, no route) on the best route from that depot. Free as
    // the game counts it: no orders and nothing aboard (a truck still delivering its last pallet isn't).
    // (With automatic routes, the company does this itself.)
    for (const t of this.cfg.autoRoutes ? [] : obs.trucks) {
      if (t.company !== company || t.route !== null || t.state !== 'idle' || t.orders.length > 0 || t.cargo !== null) continue;
      // From its own factory if there's anything worth running there; otherwise from another of the
      // company's factories (trucks are a company-wide pool: the game sends the nearest free one).
      const r = this.pickRoute(obs, company, load, t.depot) ?? this.pickRoute(obs, company, load);
      if (!r) continue;
      out.push({ type: 'assignRoute', depot: t.depot, producer: r.producer, consumer: r.consumer });
      load.set(r.producer, (load.get(r.producer) ?? 0) + 1);
      load.set(r.consumer, (load.get(r.consumer) ?? 0) + 1);
    }

    // Buy a truck if there's money, room and a worthwhile route (one per think).
    const myDepots = Object.entries(obs.depots).filter(([, o]) => o === company).map(([s]) => Number(s));
    // Trucks are a company-wide pool (each factory adds `capacity`); new ones start at the factory
    // with the fewest trucks based there.
    const perDepot = (s: number) => obs.trucks.filter((t) => t.depot === s).length;
    const fleet = obs.trucks.filter((t) => t.company === company).length;
    const spare = fleet < myDepots.length * cfg.capacity ? [...myDepots].sort((a, b) => perDepot(a) - perDepot(b))[0] : undefined;
    // The next truck's price (it rises with the fleet when trucks cost more and more).
    const nextTruck = truckPriceFor(cfg, fleet);
    // With orders, a truck has to pay for itself (and its running cost) before the end, and there's
    // no point while some of the fleet is standing idle: the town has no more work for it.
    const idle = obs.trucks.filter((t) => t.company === company && t.orders.length === 0 && t.cargo === null).length;
    const upkeep = this.cfg.depots.upkeepPerMin * this.minutesLeft(obs);
    const policy = Bot.truckPolicy?.(company) ?? 'default';
    const worthIt =
      policy === 'greedy'
        ? true
        : this.cfg.orders.enabled
          ? idle === 0 && this.truckReturn(obs) - upkeep >= nextTruck
          : this.truckReturn(obs) >= 0.25 * nextTruck && this.pickRoute(obs, company, load) !== null;
    if (spare !== undefined && c.treasury >= nextTruck && worthIt) {
      out.push({ type: 'buyTruck', company, depot: spare });
      return out;
    }

    // Depots full: buy the cheapest free site if affordable (with a truck to put in it). With
    // subsidy pricing that's the site in the area the company serves most; ties go to the nearest.
    const factoryWorthIt = this.truckReturn(obs) >= nextTruck;
    if (spare === undefined && factoryWorthIt) {
      let cheapest: { site: number; price: number; dist: number } | null = null;
      for (const [siteId, prices] of Object.entries(obs.depotPrices)) {
        const l = this.town.locations[Number(siteId)];
        // Only a site with an uncrowded route of its own (a new factory opens new routes).
        if (!this.siteHasRoute(obs, l, load)) continue;
        const price = prices[company];
        // Straight-line distance to the nearest own depot: a cheap tiebreak.
        const dist = Math.min(...myDepots.map((s) => Math.hypot(this.town.locations[s].x - l.x, this.town.locations[s].y - l.y)));
        if (!cheapest || price < cheapest.price || (price === cheapest.price && dist < cheapest.dist)) cheapest = { site: l.id, price, dist };
      }
      // A factory is worth it while a truck in it still pays for itself.
      if (cheapest && c.treasury >= cheapest.price + nextTruck) {
        out.push({ type: 'buyDepot', company, site: cheapest.site });
        return out;
      }
    }

    // Raising money: a small plan for what it wants to buy next (trucks to fill its factories' room
    // and good routes, or another factory and a couple of trucks), less what it has. It sells a
    // bank share for that only if it could pay 75% of the asking price itself, and backs the sale
    // with its own bid up to that, so the share doesn't go for nothing.
    const bankShares = c.shares.some((s) => s === null);
    const busy = obs.sales.some((x) => x.company === company);
    if ((worthIt || (spare === undefined && factoryWorthIt)) && bankShares && !busy && obs.elapsed >= obs.saleCooldownUntil[company]) {
      const cheapestSite = Math.min(
        ...Object.entries(obs.depotPrices)
          .filter(([site]) => this.siteHasRoute(obs, this.town.locations[Number(site)], load))
          .map(([, p]) => p[company]),
      );
      const routes = new Set(this.routesFor(obs, company).map((r) => `${r.producer}-${r.consumer}`)).size;
      const room = Math.max(0, Math.min(myDepots.length * cfg.capacity, routes * this.perRoute) - fleet);
      const want =
        room > 0
          ? Array.from({ length: Math.min(room, 4) }, (_, i) => truckPriceFor(cfg, fleet + i)).reduce((a, b) => a + b, 0)
          : Number.isFinite(cheapestSite) && factoryWorthIt
            ? cheapestSite + nextTruck + truckPriceFor(cfg, fleet + 1)
            : 0;
      const need = want - c.treasury;
      if (need >= nextTruck) {
        const ask = Math.min(need, this.shareValue(obs, company, need) * this.personality.greed);
        const floor = Math.floor(0.75 * ask);
        const me = obs.players[this.me];
        if (floor >= Math.max(this.cfg.auctions.minRaise, obs.minPrice[company]) && me.cash - me.held >= floor) {
          out.push({ type: 'startSale', company });
          this.raiseFloor.set(company, floor);
          this.startedAt.set(company, obs.elapsed);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- buying in

  /**
   * Buying into a company it doesn't lead: when one still has bank shares that look worth more
   * than they'd cost, put one up for auction itself. It opens the bidding low, at about 60% of
   * what it would pay (so the share doesn't go for nothing), and bids on from there like anyone else.
   */
  private buyIn(obs: Observation): Action | null {
    if (obs.elapsed - this.lastBuyIn < 20) return null;
    const cfg = this.cfg.auctions;
    const me = obs.players[this.me];
    const available = (me.cash - me.held) * this.personality.maxCashPerBid;
    if (available < cfg.minRaise) return null;
    const factor = this.personality.speculator ? this.personality.speculator.discount : this.personality.greed;
    let best: { company: number; bid: number; gain: number } | null = null;
    for (const c of obs.companies) {
      if (c.presidents.length === 0 || c.presidents.includes(this.me) || !c.shares.includes(null)) continue;
      if (obs.sales.some((x) => x.company === c.id)) continue;
      if (obs.elapsed < obs.saleCooldownUntil[c.id]) continue;
      const rivalMin = Math.max(cfg.minRaise, obs.minPrice[c.id]);
      const pay = this.shareValue(obs, c.id, rivalMin) * factor;
      const bid = Math.max(rivalMin, Math.floor(0.6 * pay));
      if (pay < rivalMin || bid > available) continue;
      const gain = pay / bid;
      if (!best || gain > best.gain) best = { company: c.id, bid, gain };
    }
    if (!best) return null;
    this.lastBuyIn = obs.elapsed;
    this.buyInBid.set(best.company, best.bid);
    this.startedAt.set(best.company, obs.elapsed);
    return { type: 'startSale', company: best.company };
  }

  // ---------------------------------------------------------------- trading shares

  /**
   * Once a look: sell a share when someone pays more for it than it will still earn (the company's
   * buy-back price, or a player's standing bid), or buy at a player's ask that's a bargain.
   * A president keeps the shares it needs to stay president until the last minute.
   */
  private trade(obs: Observation): Action | null {
    const me = obs.players[this.me];
    for (const c of obs.companies) {
      const mine = c.shares.filter((s) => s === this.me).length;
      const book = obs.books[c.id];
      if (mine > 0) {
        const counts = new Map<number, number>();
        for (const s of c.shares) if (s !== null && s !== this.me) counts.set(s, (counts.get(s) ?? 0) + 1);
        const rival = Math.max(0, ...counts.values());
        const keepControl = c.presidents.includes(this.me) && mine - 1 <= rival && this.minutesLeft(obs) > 1;
        if (!keepControl) {
          const hold = this.holdValue(obs, c.id);
          const company = obs.companyBid[c.id];
          const selling = obs.sales.some((x) => x.company === c.id);
          const player = book.bid && book.bid.player !== this.me && !selling ? book.bid.price : null;
          if (company !== null && company >= hold && (player === null || company >= player)) return { type: 'sell', company: c.id, to: 'company' };
          if (player !== null && player >= hold * 1.05) return { type: 'sell', company: c.id, to: 'bid' };
        }
      }
      if (book.ask && book.ask.player !== this.me && book.ask.price <= (me.cash - me.held) * this.personality.maxCashPerBid) {
        const value = this.holdValue(obs, c.id);
        if (book.ask.price <= value * this.personality.greed * 0.9) return { type: 'buy', company: c.id };
      }
    }
    return this.placeOrders(obs);
  }

  /**
   * What keeping a share is worth to it: the same as buying one (dividends, plus a chance to sell
   * it back to the company later), except in the last 90 seconds, when there's no later.
   */
  private holdValue(obs: Observation, company: number): number {
    return this.shareValue(obs, company, 0, false, this.minutesLeft(obs) > 1.5);
  }

  /** When it posted its standing sell order for each company (to lower it if nobody bites). */
  private askSince = new Map<number, number>();

  /**
   * Standing orders, one change a look:
   * - A buy order it no longer believes in (the company looks worth less now) is withdrawn.
   * - Selling: a share it doesn't need (not one keeping it president) goes up at a markup over
   *   what it will still pay; if nobody bites in 30 seconds, the price comes down a step, never
   *   below what holding it is worth.
   * - Buying: for a company that looks worth well over the best price on offer, a modest buy
   *   order, only with plenty of spare cash (a bid holds its cash).
   */
  private placeOrders(obs: Observation): Action | null {
    const cfg = this.cfg.auctions;
    const me = obs.players[this.me];
    const spare = me.cash - me.held;
    // Withdraw a buy order it no longer believes in.
    for (const c of obs.companies) {
      const bid = obs.books[c.id].bid;
      if (bid?.player !== this.me || obs.sales.some((x) => x.company === c.id)) continue;
      if (bid.price > this.holdValue(obs, c.id) * this.personality.greed) return { type: 'cancelOrder', company: c.id, side: 'bid' };
    }
    if (obs.elapsed - this.lastOrder < 10) return null;
    for (const c of obs.companies) {
      const mine = c.shares.filter((s) => s === this.me).length;
      if (!mine) continue;
      const counts = new Map<number, number>();
      for (const s of c.shares) if (s !== null && s !== this.me) counts.set(s, (counts.get(s) ?? 0) + 1);
      const rival = Math.max(0, ...counts.values());
      if (c.presidents.includes(this.me) && mine - 1 <= rival && this.minutesLeft(obs) > 1) continue;
      const book = obs.books[c.id];
      const hold = this.holdValue(obs, c.id);
      const floor = Math.max(Math.ceil(hold), (book.bid?.price ?? 0) + 1, (obs.companyBid[c.id] ?? 0) + 1, 1);
      const mineAsk = book.ask?.player === this.me ? book.ask : null;
      if (mineAsk) {
        const since = this.askSince.get(c.id) ?? obs.elapsed;
        if (obs.elapsed - since < 30) continue;
        const lower = Math.floor(mineAsk.price * 0.9);
        if (lower < floor || lower >= mineAsk.price) continue;
        this.askSince.set(c.id, obs.elapsed);
        this.lastOrder = obs.elapsed;
        return { type: 'ask', company: c.id, price: lower };
      }
      const price = Math.max(floor, Math.round(hold * 1.25));
      if (book.ask && price > book.ask.price - cfg.minRaise) continue; // someone sells cheaper
      this.askSince.set(c.id, obs.elapsed);
      this.lastOrder = obs.elapsed;
      return { type: 'ask', company: c.id, price };
    }
    // A buy order for a share that looks cheap, with cash to spare.
    let best: { company: number; price: number; gain: number } | null = null;
    for (const c of obs.companies) {
      if (!c.shares.some((s) => s !== null && s !== this.me)) continue; // nobody to buy from
      if (obs.sales.some((x) => x.company === c.id)) continue;
      const book = obs.books[c.id];
      if (book.bid?.player === this.me) continue;
      const value = this.holdValue(obs, c.id) * this.personality.greed;
      const price = Math.floor(value * 0.7);
      if (price < Math.max(1, (book.bid?.price ?? 0) + cfg.minRaise, obs.minPrice[c.id]) || (book.ask && price >= book.ask.price)) continue;
      if (price * 3 > spare * this.personality.maxCashPerBid) continue;
      const gain = value / price;
      if (!best || gain > best.gain) best = { company: c.id, price, gain };
    }
    if (!best) return null;
    this.lastOrder = obs.elapsed;
    return { type: 'bid', company: best.company, amount: best.price };
  }

  // ---------------------------------------------------------------- location investment

  private invest(obs: Observation): Action | null {
    if (this.cfg.cycles.maxLevel <= this.cfg.cycles.startLevel) return null; // fixed levels: nothing to invest in
    if (obs.t - this.lastInvest < 60 || this.minutesLeft(obs) < 5) return null;
    const me = obs.players[this.me];
    const available = me.cash - me.held;
    // Bottleneck on my companies' busiest routes: the consumer usually (it wants 2-4 a cycle).
    const mine = new Set(obs.companies.filter((c) => c.shares.includes(this.me)).map((c) => c.id));
    const counts = new Map<number, number>();
    for (const t of obs.trucks)
      if (mine.has(t.company)) for (const s of t.orders) if (s.action === 'unload') counts.set(s.location, (counts.get(s.location) ?? 0) + 1);
    const target = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
    if (!target) return null;
    const l = obs.locations.find((x) => x.id === target[0])!;
    const cost = investCost(this.cfg.money, l.level, this.cfg.cycles.startLevel);
    if (available - cost < this.personality.investReserve) return null;
    this.lastInvest = obs.t;
    return { type: 'invest', location: l.id };
  }
}
