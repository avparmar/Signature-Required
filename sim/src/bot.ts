/**
 * A simple investor bot. It only uses what any player can see: the town, the config, the
 * observation and public events.
 *
 * - Bidding: values a share as the dividends it expects the company to pay for the rest of the
 *   game (from its fleet, or the fleet the money would buy) plus its slice of the final asset
 *   payout, and bids up to a fraction of that. Winning control is worth a little extra.
 * - As president: raises money when the company can't afford its next truck, buys trucks while it
 *   can, sends each new or idle truck to the best producer -> consumer route near its depot
 *   (avoiding routes that are already crowded), and buys a nearby depot when its depots are full.
 * - Spare cash: occasionally levels up the bottleneck location on a route its companies run.
 */
import {
  distanceToNetwork,
  distancesFrom,
  investCost,
  minimumBid,
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
  const demand = ((c.demandPerLevel[0] + c.demandPerLevel[1]) / 2) * c.startLevel;
  const supply = c.producePerLevel * c.startLevel;
  const palletsPerMin = (Math.min(demand, supply) * 60) / ((cfg.cycles.cycleSec[0] + cfg.cycles.cycleSec[1]) / 2);
  return Math.max(1, Math.round(palletsPerMin / deliveriesPerTruckMin(cfg) * 0.75));
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
    for (const e of events) {
      if (e.type === 'delivered') this.recent.push({ t: obs.t, company: e.company, price: e.price });
      if (e.type === 'opened' || e.type === 'closed') this.routeCache.clear(); // the map changed
    }
    this.recent = this.recent.filter((r) => r.t > obs.t - 180);
    const out: Action[] = [];
    const bid = this.bid(obs);
    if (bid) out.push(bid);
    else {
      // Not bidding at this price: say so, so the auction can end early.
      const a = obs.auction;
      if (a && a.highBidder !== this.me && a.seller !== this.me && !a.passed.includes(this.me)) out.push({ type: 'pass', company: a.company });
    }
    if (obs.elapsed - this.lastThink < this.thinkEverySec) return out;
    this.lastThink = obs.elapsed;
    if (obs.phase === 'running') {
      for (const c of obs.companies) if (c.presidents.includes(this.me)) out.push(...this.runCompany(obs, c.id));
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

  /** Expected value of one share of a company if `extraCash` were added to its treasury. */
  shareValue(obs: Observation, company: number, extraCash: number, optimistic = false): number {
    const c = obs.companies[company];
    const trucks = obs.trucks.filter((t) => t.company === company).length;
    // An optimist assumes the company will buy the depots it needs; otherwise count what it has.
    const capacity = optimistic
      ? Infinity
      : Object.values(obs.depots).filter((o) => o === company).length * this.cfg.depots.capacity;
    // The company will also raise money from its other unsold shares, at about this price.
    const unsoldAfter = Math.max(0, c.shares.filter((s) => s === null).length - 1);
    const assumed = optimistic ? Math.max(extraCash, this.personality.speculator?.assumedSharePrice ?? 0) : extraCash;
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
        if (fleet < Math.min(cap, routeCap) && cash >= d.truckPrice) {
          cash -= d.truckPrice;
          assets += d.truckPrice;
          fleet++;
        } else if (this.personality.growth && fleet >= cap && cap !== Infinity && cash >= factoryPrice + d.truckPrice) {
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
    // Final payout: a share of everything the company holds by then (trucks and factories at what
    // they cost, plus cash).
    const lastPerMin = Math.max(recentPerMin, fleet * perTruckPerMin);
    const bonus =
      m.finalBonus === 'earnings'
        ? (m.finalEarningsMultiple * lastPerMin * (m.payoutEverySec / 60)) / c.shares.length
        : (m.finalAssetShare * (assets + cash)) / c.shares.length;
    return dividends + bonus;
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

  private speculatorBid(obs: Observation): Action | null {
    const spec = this.personality.speculator!;
    const a = obs.auction!;
    if (this.target === null) this.target = this.pickTarget(obs);
    const c = obs.companies[a.company];
    // If someone else has locked up the target, switch to wherever it holds the most.
    const mine = c.shares.filter((s) => s === this.me).length;
    if (a.company !== this.target && mine > 0 && obs.companies[this.target].shares.every((s) => s !== null) && !obs.companies[this.target].presidents.includes(this.me))
      this.target = a.company;
    const me = obs.players[this.me];
    const available = me.cash - me.held;
    const min = minimumBid(a, this.cfg.auctions);
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

  private bid(obs: Observation): Action | null {
    const a = obs.auction;
    if (!a || a.highBidder === this.me || a.seller === this.me) return null;
    if (this.personality.speculator) return this.speculatorBid(obs);
    const me = obs.players[this.me];
    const available = me.cash - me.held;
    const min = minimumBid(a, this.cfg.auctions);
    if (min > available * this.personality.maxCashPerBid) return null;
    const c = obs.companies[a.company];
    const myShares = c.shares.filter((s) => s === this.me).length;
    const counts = new Map<number, number>();
    for (const s of c.shares) if (s !== null) counts.set(s, (counts.get(s) ?? 0) + 1);
    const top = Math.max(0, ...[...counts].filter(([p]) => p !== this.me).map(([, n]) => n));
    const wouldControl = myShares + 1 >= top;
    let value = this.shareValue(obs, a.company, min);
    if (wouldControl && !c.presidents.includes(this.me)) value *= 1 + this.personality.controlBonus;
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

    // Put every free truck (idle at its depot, no route) on the best route from that depot.
    for (const t of obs.trucks) {
      if (t.company !== company || t.route !== null || t.state !== 'idle') continue;
      const r = this.pickRoute(obs, company, load, t.depot);
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
    const worthIt = this.minutesLeft(obs) > 4 && this.pickRoute(obs, company, load) !== null;
    if (spare !== undefined && c.treasury >= cfg.truckPrice && worthIt) {
      out.push({ type: 'buyTruck', company, depot: spare });
      return out;
    }

    // Depots full: buy the cheapest free site if affordable (with a truck to put in it). With
    // subsidy pricing that's the site in the area the company serves most; ties go to the nearest.
    if (spare === undefined && worthIt) {
      let cheapest: { site: number; price: number; dist: number } | null = null;
      for (const [siteId, prices] of Object.entries(obs.depotPrices)) {
        const l = this.town.locations[Number(siteId)];
        const price = prices[company];
        // Straight-line distance to the nearest own depot: a cheap tiebreak.
        const dist = Math.min(...myDepots.map((s) => Math.hypot(this.town.locations[s].x - l.x, this.town.locations[s].y - l.y)));
        if (!cheapest || price < cheapest.price || (price === cheapest.price && dist < cheapest.dist)) cheapest = { site: l.id, price, dist };
      }
      if (cheapest && c.treasury >= cheapest.price + cfg.truckPrice) {
        out.push({ type: 'buyDepot', company, site: cheapest.site });
        return out;
      }
    }

    // Short of money for the next step: raise some by auctioning a bank-held share.
    const cheapestSite = Math.min(...Object.values(obs.depotPrices).map((p) => p[company]));
    const needs = spare !== undefined ? cfg.truckPrice : (Number.isFinite(cheapestSite) ? cheapestSite : cfg.depotBase) + cfg.truckPrice;
    const bankShares = c.shares.some((s) => s === null);
    const busy = (obs.auction && obs.auction.company === company) || obs.auctionQueue.some((r) => r.company === company);
    if (worthIt && bankShares && !busy && c.treasury < needs && obs.elapsed >= obs.auctionCooldownUntil[company]) {
      out.push({ type: 'startAuction', company });
    }
    return out;
  }

  // ---------------------------------------------------------------- location investment

  private invest(obs: Observation): Action | null {
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
