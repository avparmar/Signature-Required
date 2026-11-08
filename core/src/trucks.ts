/**
 * Trucks: repeating orders, driving along streets, queueing at buildings and using loading bays.
 *
 * - A truck carries one pallet.
 * - Orders are a repeating list of stops: load at a producer, unload at a consumer.
 * - Trucks pass each other freely on streets. At a building they stop in a line on the street
 *   outside (see kerbs.ts): its loading bays either side of the driveway, then the queue behind.
 *   A truck is only served once it's at a bay, and pulls out forwards to the next junction, so
 *   parking and pulling out are real driving, at truck speed.
 * - Companies take turns: when trucks from several companies are waiting, the building serves
 *   the next company after the one it served last, so swarming a building with trucks doesn't
 *   let one company hog it. Within a company, trucks go in arrival order.
 * - No dumping: a pallet only leaves a truck when a consumer of that good accepts it.
 * - Routes run through the company's factory (`viaDepot`): every load is processed there on its
 *   way to the consumer, which also counts as the truck's servicing.
 */
import { deliverPallet, takePallet, type LocationState } from './economy.js';
import { edgeLength, routeVia, type RoadGraph } from './graph.js';
import { atGoal, berthGoal, defaultKerb, kerbLine, linePoint, spotS, stepBerth, type Berth, type KerbLine } from './kerbs.js';

export interface TruckConfig {
  /** Driving speed, blocks per second. */
  speed: number;
  /** A truck does one trip per dispatch: after delivering it's free again (heading home until sent out). */
  oneTrip: boolean;
  /** Seconds to load or unload one pallet at a bay. */
  serviceSec: number;
  /** Companies take turns at a building (true), or it's first come, first served (false). */
  takeTurns: boolean;
  /**
   * Routes through the factory: 'none' (producer ↔ consumer), 'loaded' (the default: every load is
   * processed at the factory on its way to the consumer), or 'hub' (the factory on both legs).
   */
  viaDepot: 'none' | 'loaded' | 'hub';
  /** Seconds processing a load at the factory takes. */
  signOffSec: number;
  /** Spots in a building's line are this far apart (blocks): about a truck's length. */
  spacing: number;
  /** Lanes are this far either side of the road's centre line (blocks); a U-turn is a half circle this wide. */
  lane: number;
}

export const DEFAULT_TRUCKS: TruckConfig = {
  speed: 0.35,
  oneTrip: false,
  serviceSec: 3,
  takeTurns: true,
  viaDepot: 'loaded',
  signOffSec: 3,
  spacing: 0.575,
  lane: 0.0775,
};

export interface Stop {
  /** Town location id: a producer for 'load', a consumer for 'unload', a depot for 'signOff'. */
  location: number;
  action: 'load' | 'unload' | 'signOff';
  /** Optional road nodes to drive through, in order, on the way to this stop. */
  via?: number[];
}

export interface Cargo {
  good: number;
  /** Producer it was picked up at (credited when it's delivered). */
  origin: number;
  /** Turned from raw material into product at a factory (always true when routes go direct). */
  processed: boolean;
}

export type TruckState =
  | 'idle' // no orders, or nothing it can do with them
  | 'driving'
  | 'queued' // at a building, waiting for a bay, stock or demand
  | 'servicing' // loading or unloading at a bay
  | 'processing'; // at its factory, turning a raw load into product

export interface Truck {
  id: number;
  company: number;
  /** Depot (town location id) this truck belongs to; counts against its capacity. */
  depot: number;
  state: TruckState;
  /** Node the truck is at, or last passed (a building's node while it's in that building's line). */
  node: number;
  /** The node before `node` (which way it came). */
  from: number;
  /** In a building's line (stopped, moving up, or pulling out), or null on the road. */
  berth: Berth | null;
  /** Remaining road nodes to drive through (next first) while driving. */
  path: number[];
  /** Distance travelled along the current street (from `node` towards path[0]). */
  progress: number;
  cargo: Cargo | null;
  orders: Stop[];
  /** Index of the stop the truck is heading to / working at. */
  orderIndex: number;
  /** Location the truck is queued or servicing at. */
  at: number | null;
  /** Game time a load/unload finishes. */
  busyUntil: number;
  /**
   * The load or unload under way: the pallet (or the shop's order) is claimed when it starts, so
   * no other bay takes it, but it only changes hands, and a delivery only pays, when it finishes.
   */
  serving: { action: 'load'; good: number } | { action: 'unload'; price: number } | null;
  /** Orders set while mid-street take effect at the next intersection. */
  pendingOrders: Stop[] | null;
  /** The route this truck is assigned to (see Game.routes), or null when free. */
  route: string | null;
  /** Road node of the truck's home depot. */
  home: number;
  /** Unassigned from its route: deliver anything in hand, then go back to the depot and wait. */
  homing: boolean;
  /** True while the current path leads to the depot rather than a stop. */
  toHome: boolean;
  /** At its factory for processing (state 'processing' while it lasts). */
  signing: boolean;
}

export type TruckEvent =
  | { type: 'loaded'; t: number; truck: number; company: number; location: number; good: number }
  | { type: 'delivered'; t: number; truck: number; company: number; location: number; good: number; origin: number; price: number }
  | { type: 'truckIdle'; t: number; truck: number; company: number; reason: string }
  /** Off its route with a pallet nowhere will take any more (its shop closed): it leaves it, unpaid. */
  | { type: 'dropped'; t: number; truck: number; company: number; good: number }
  | { type: 'signedOff'; t: number; truck: number; company: number; depot: number; loaded: boolean };

/** Why a set of orders is invalid, or null if it's fine. */
export function validateOrders(stops: Stop[], kindOf: (loc: number) => string | undefined, nodeCount: number): string | null {
  for (const s of stops) {
    const kind = kindOf(s.location);
    if (kind === undefined) return `no location ${s.location}`;
    if (s.action === 'load' && kind !== 'producer') return `can only load at a producer (location ${s.location} is a ${kind})`;
    if (s.action === 'unload' && kind !== 'consumer') return `can only unload at a consumer (location ${s.location} is a ${kind})`;
    if (s.action === 'signOff' && kind !== 'depot') return `can only sign off at a depot (location ${s.location} is a ${kind})`;
    for (const n of s.via ?? []) if (!Number.isInteger(n) || n < 0 || n >= nodeCount) return `no road node ${n}`;
  }
  return null;
}

export class TruckSystem {
  readonly trucks: Truck[] = [];
  /** Trucks queued or servicing at each location, in arrival order. */
  readonly queues = new Map<number, number[]>();
  /** The company each location served last, for taking turns. */
  readonly lastServed = new Map<number, number>();

  constructor(
    private graph: RoadGraph,
    private cfg: TruckConfig,
    private loc: (id: number) => LocationState | undefined,
    private nodeOf: (locationId: number) => number,
    private emit: (e: TruckEvent) => void,
  ) {}

  add(company: number, depot: number, node: number): Truck {
    const t: Truck = {
      id: this.trucks.length,
      company,
      depot,
      state: 'idle',
      node,
      from: node,
      berth: null,
      path: [],
      progress: 0,
      cargo: null,
      orders: [],
      orderIndex: 0,
      at: null,
      busyUntil: 0,
      serving: null,
      pendingOrders: null,
      route: null,
      home: node,
      homing: false,
      toHome: false,
      signing: false,
    };
    this.trucks.push(t);
    // Parked outside its depot, in the next free spot.
    const kerb = defaultKerb(this.graph, node);
    const line = kerb !== undefined ? this.line(node, kerb) : null;
    if (line && kerb !== undefined) {
      const spot = this.freeSpot(node, kerb);
      const key = `${node}:${kerb}`;
      (this.used.get(key) ?? this.used.set(key, new Set()).get(key)!).add(spot);
      t.berth = { kerb, s: spotS(line, spot, this.cfg), side: 'near', turn: 0, spot, leaving: false, seq: this.seq++ };
    }
    return t;
  }

  private lines = new Map<string, KerbLine | null>();
  private seq = 0;
  /** Spots taken in each line (building:kerb), this tick. */
  private used = new Map<string, Set<number>>();

  /** A building's line along one of its streets (cached; the roads never change). */
  line(building: number, kerb: number): KerbLine | null {
    const key = `${building}:${kerb}`;
    if (!this.lines.has(key)) this.lines.set(key, kerbLine(this.graph, building, kerb));
    return this.lines.get(key)!;
  }

  private freeSpot(building: number, kerb: number): number {
    const used = this.used.get(`${building}:${kerb}`);
    let i = 0;
    while (used?.has(i)) i++;
    return i;
  }

  /** Where a truck's spot is, as a goal for moving along its line. */
  private goalOf(truck: Truck): { s: number; side: 'near' | 'far' } | null {
    const b = truck.berth;
    const line = b ? this.line(truck.node, b.kerb) : null;
    if (!b || !line) return null;
    return berthGoal(line, b, this.cfg);
  }

  /** At a loading bay, stopped: ready to be served. */
  private docked(truck: Truck, bays: number): boolean {
    if (!truck.berth) return true;
    const goal = this.goalOf(truck);
    return !truck.berth.leaving && truck.berth.spot < bays && goal !== null && atGoal(truck.berth, goal);
  }

  /**
   * Everyone's spot in each line: a truck at a bay (being served, or stopped there waiting) keeps
   * it; the others take the free spots nearest the front, in the order they joined.
   */
  private allocate(baysOf: (locationId: number) => number) {
    this.used.clear();
    const groups = new Map<string, Truck[]>();
    for (const t of this.trucks) {
      if (!t.berth || t.berth.leaving) continue;
      const key = `${t.node}:${t.berth.kerb}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
    }
    for (const [key, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      list.sort((a, b) => a.berth!.seq - b.berth!.seq);
      const line = this.line(list[0].node, list[0].berth!.kerb);
      const bays = Math.max(0, ...list.map((t) => (t.at !== null ? baysOf(t.at) : 0)));
      const taken = new Set<number>();
      // A truck with a bay (being served, or waiting at it or on its way to it) keeps it.
      const keeps = (t: Truck) => line !== null && t.berth!.spot < bays && (t.state === 'servicing' || t.state === 'queued');
      const kept = new Set<Truck>();
      for (const t of list)
        if (keeps(t) && !taken.has(t.berth!.spot)) {
          taken.add(t.berth!.spot);
          kept.add(t);
        }
      // A free bay goes to whoever's turn it is (companies take turns, as at the bays themselves),
      // even if that truck has to pull past others to get there; the rest keep their order.
      const rest = list.filter((t) => !kept.has(t));
      const location = list.find((t) => t.at !== null)?.at ?? null;
      let last = location !== null ? (this.lastServed.get(location) ?? -1) : -1;
      for (let bay = 0; bay < bays; bay++) {
        if (taken.has(bay)) continue;
        const waiting = rest.filter((t) => t.state === 'queued');
        if (!waiting.length) break;
        const companies = [...new Set(waiting.map((t) => t.company))].sort((a, b) => a - b);
        const company = this.cfg.takeTurns ? (companies.find((c) => c > last) ?? companies[0]) : waiting[0].company;
        const t = waiting.find((x) => x.company === company)!;
        t.berth!.spot = bay;
        taken.add(bay);
        rest.splice(rest.indexOf(t), 1);
        last = company;
      }
      for (const t of rest) {
        let i = 0;
        while (taken.has(i)) i++;
        t.berth!.spot = i;
        taken.add(i);
      }
      this.used.set(key, taken);
    }
  }

  /** Pulled up at a building (in its line): the end of the drive. */
  private arriveBuilding(truck: Truck, building: number, kerb: number, s: number, side: 'near' | 'far', now: number) {
    truck.from = truck.node === building ? truck.from : truck.node;
    truck.node = building;
    truck.path = [];
    truck.progress = 0;
    const spot = this.freeSpot(building, kerb);
    const key = `${building}:${kerb}`;
    (this.used.get(key) ?? this.used.set(key, new Set()).get(key)!).add(spot);
    truck.berth = { kerb, s, side, turn: 0, spot, leaving: false, seq: this.seq++ };
    this.endDrive(truck, now);
  }

  private endDrive(truck: Truck, now: number) {
    if (truck.toHome) {
      truck.toHome = false;
      truck.homing = false;
      this.goIdle(truck, now, 'home');
    } else this.arriveAtStop(truck, now);
  }

  /** Where a truck sets off from: the junction it pulls out to, if it's in a building's line. */
  private startNode(truck: Truck): number {
    const line = truck.berth ? this.line(truck.node, truck.berth.kerb) : null;
    return line ? line.exit : truck.node;
  }

  /** Replace a truck's orders (already validated). Mid-street, they apply at the next intersection. */
  setOrders(truck: Truck, stops: Stop[], now: number) {
    truck.homing = false; // a truck on its way back gets straight to work
    if (truck.state === 'driving' && truck.progress > 0) {
      truck.pendingOrders = stops;
      return;
    }
    this.applyOrders(truck, stops, now);
  }

  private applyOrders(truck: Truck, stops: Stop[], now: number) {
    truck.pendingOrders = null;
    if (truck.signing) {
      // Processing at the factory: the new orders start once it's done.
      truck.orders = stops;
      truck.orderIndex = -1;
      return;
    }
    if (truck.state === 'servicing') {
      // Finish the pallet in hand first; the new orders start when it's done.
      truck.orders = stops;
      truck.orderIndex = -1;
      return;
    }
    this.leaveQueue(truck);
    truck.orders = stops;
    truck.orderIndex = 0;
    this.departForStop(truck, now, false);
  }

  /** Can this truck do anything at this stop, given what it's carrying? */
  private actionable(truck: Truck, stop: Stop): boolean {
    if (stop.action === 'load') return truck.cargo === null;
    if (stop.action === 'signOff') return this.cfg.viaDepot === 'hub' || truck.cargo !== null;
    const c = this.loc(stop.location);
    return truck.cargo !== null && c !== undefined && c.good === truck.cargo.good;
  }

  /**
   * Head for the current stop, skipping stops it can't use (a load stop while carrying, or an
   * unload stop for a different good). Goes idle if no stop is any use.
   */
  private departForStop(truck: Truck, now: number, advance: boolean) {
    const n = truck.orders.length;
    // Off its route, and no stop left that takes its pallet: it can't deliver it, so it leaves it
    // (unpaid) rather than being stuck with it, and is free again.
    if (truck.cargo && truck.route === null && !truck.orders.some((o) => this.actionable(truck, o) && o.action === 'unload')) {
      this.emit({ type: 'dropped', t: now, truck: truck.id, company: truck.company, good: truck.cargo.good });
      truck.cargo = null;
      truck.orders = [];
      return this.driveTo(truck, truck.home, now);
    }
    if (n === 0) return truck.homing ? this.driveTo(truck, truck.home, now) : this.goIdle(truck, now, 'no orders');
    let idx = advance ? (truck.orderIndex + 1) % n : ((truck.orderIndex % n) + n) % n;
    let tries = 0;
    while (!this.actionable(truck, truck.orders[idx]) && tries < n) {
      idx = (idx + 1) % n;
      tries++;
    }
    if (tries >= n) {
      return this.goIdle(truck, now, truck.cargo ? 'carrying a pallet none of its stops will take' : 'no stop to load at');
    }
    truck.orderIndex = idx;
    const stop = truck.orders[idx];
    const target = this.nodeOf(stop.location);
    truck.toHome = false;
    // Already in that building's line: no need to go anywhere.
    if (truck.berth && target === truck.node) {
      truck.berth.leaving = false;
      truck.path = [];
      truck.progress = 0;
      truck.state = 'driving';
      return this.arriveAtStop(truck, now);
    }
    const start = this.startNode(truck);
    const route = routeVia(this.graph, [start, ...(stop.via ?? []), target]);
    if (!route) return this.goIdle(truck, now, 'no route');
    truck.path = route.slice(1);
    truck.progress = 0;
    truck.state = 'driving';
    if (truck.berth) truck.berth.leaving = true; // pulls out first
    else if (truck.path.length === 0) this.arriveAtStop(truck, now);
  }

  /** Reached the current stop: queue at a building, or sign off at a depot. */
  private arriveAtStop(truck: Truck, now: number) {
    const stop = truck.orders[truck.orderIndex];
    if (stop.action !== 'signOff') return this.arrive(truck, stop.location);
    truck.signing = true;
    truck.state = 'processing';
    truck.busyUntil = now + this.cfg.signOffSec;
  }

  private finishSignOff(truck: Truck, now: number) {
    const stop = truck.orders[truck.orderIndex];
    truck.signing = false;
    if (truck.cargo) truck.cargo.processed = true;
    this.emit({ type: 'signedOff', t: now, truck: truck.id, company: truck.company, depot: stop?.location ?? -1, loaded: truck.cargo !== null });
    truck.state = 'driving'; // departForStop sets the real state
    if (truck.homing && !(truck.cargo && truck.orders.length)) {
      truck.orders = [];
      return this.driveTo(truck, truck.home, now);
    }
    if (truck.orderIndex < 0) {
      truck.orderIndex = 0;
      return this.departForStop(truck, now, false);
    }
    this.departForStop(truck, now, true);
  }

  private goIdle(truck: Truck, now: number, reason: string) {
    const was = truck.state;
    truck.state = 'idle';
    truck.path = [];
    truck.progress = 0;
    if (was !== 'idle') this.emit({ type: 'truckIdle', t: now, truck: truck.id, company: truck.company, reason });
  }

  private arrive(truck: Truck, location: number) {
    truck.state = 'queued';
    truck.at = location;
    const q = this.queues.get(location) ?? [];
    q.push(truck.id);
    this.queues.set(location, q);
  }

  private leaveQueue(truck: Truck) {
    if (truck.at === null) return;
    const q = this.queues.get(truck.at);
    if (q) {
      const i = q.indexOf(truck.id);
      if (i >= 0) q.splice(i, 1);
    }
    truck.at = null;
  }

  /** Advance every truck by dt seconds, then serve the queues. */
  update(now: number, dt: number, baysOf: (locationId: number) => number) {
    this.allocate(baysOf);
    for (const truck of this.trucks) {
      if (truck.berth) this.moveInLine(truck, this.cfg.speed * dt, now);
      else if (truck.state === 'driving') this.drive(truck, this.cfg.speed * dt, now);
      if (truck.state === 'servicing' && now >= truck.busyUntil - 1e-9) this.finishService(truck, now);
      else if (truck.state === 'processing' && now >= truck.busyUntil - 1e-9) this.finishSignOff(truck, now);
    }
    // Serve queues in a fixed order (by location id) for determinism.
    for (const location of [...this.queues.keys()].sort((a, b) => a - b)) this.serve(location, now, baysOf(location));
  }

  private drive(truck: Truck, distance: number, now: number) {
    if (this.approach(truck, distance, now)) return;
    let left = distance;
    while (left > 0 && truck.path.length) {
      const next = truck.path[0];
      const len = edgeLength(this.graph, truck.node, next);
      const remaining = len - truck.progress;
      if (left < remaining) {
        truck.progress += left;
        return;
      }
      left -= remaining;
      // Into a building (its driveway): it stops in the line on this street instead, in whichever
      // lane it came along (the far lane if it came from downstream).
      if (this.graph.terminal[next] && truck.path.length === 1) {
        const line = this.line(next, truck.node);
        if (line) return this.arriveBuilding(truck, next, truck.node, 0, truck.from === line.pts[1] ? 'near' : 'far', now);
      }
      truck.from = truck.node;
      truck.node = next;
      truck.path.shift();
      truck.progress = 0;
      if (truck.pendingOrders) {
        // New orders take over at this intersection.
        this.applyOrders(truck, truck.pendingOrders, now);
        if (truck.state !== 'driving') return;
      }
    }
    if (truck.path.length === 0 && truck.state === 'driving') this.endDrive(truck, now);
  }

  /**
   * Coming up the near lane of a building's line: stop at the next free spot as it gets there
   * (a queue spot before the driveway; bay 0 is past it, so it drives on to that). True if it stopped.
   */
  private approach(truck: Truck, distance: number, now: number): boolean {
    const n = truck.path.length;
    const dest = truck.path[n - 1];
    if (n < 2 || !this.graph.terminal[dest] || truck.pendingOrders) return false;
    const kerb = truck.path[n - 2];
    const line = this.line(dest, kerb);
    if (!line) return false;
    // Its way to the kerb, backwards, must be the line itself.
    const chain = [truck.node, ...truck.path.slice(0, n - 1)];
    if (chain.length > line.pts.length) return false;
    for (let i = 0; i < chain.length; i++) if (chain[chain.length - 1 - i] !== line.pts[i]) return false;
    const s = line.cum[chain.length - 1] - truck.progress;
    const goal = spotS(line, this.freeSpot(dest, kerb), this.cfg);
    if (goal <= 0 || s - distance > goal) return false;
    this.arriveBuilding(truck, dest, kerb, Math.min(s, goal), 'near', now);
    return true;
  }

  /** Along its line towards its spot (or, pulling out, to the junction, where it joins the road). */
  private moveInLine(truck: Truck, budget: number, now: number) {
    const b = truck.berth!;
    const goal = this.goalOf(truck);
    if (!goal) {
      truck.berth = null;
      return;
    }
    Object.assign(b, stepBerth(b, goal, budget, this.cfg.lane));
    if (b.leaving && atGoal(b, goal)) {
      // On the road: on the street from the kerb towards the junction, halfway there.
      const line = this.line(truck.node, b.kerb)!;
      truck.from = line.pts[1];
      truck.node = b.kerb;
      truck.progress = line.back / 2;
      if (line.exit !== b.kerb) truck.path = [line.exit, ...truck.path];
      truck.berth = null;
      if (truck.state === 'driving' && truck.path.length === 0) this.endDrive(truck, now);
    }
  }

  private serve(location: number, now: number, bays: number) {
    const q = this.queues.get(location)!;
    const l = this.loc(location);
    if (!l) return;
    let busy = q.filter((id) => this.trucks[id].state === 'servicing').length;
    const skip = new Set<number>(); // trucks this building can't serve at all right now
    while (busy < bays) {
      // The first waiting truck of each company, in arrival order.
      const firsts = new Map<number, number>();
      for (const id of q) {
        const t = this.trucks[id];
        if (t.state === 'queued' && !skip.has(id) && !firsts.has(t.company) && this.docked(t, bays)) firsts.set(t.company, id);
      }
      if (firsts.size === 0) return;
      // Next company after the one served last (wrapping round by company id).
      const last = this.lastServed.get(location) ?? -1;
      const order = [...firsts.keys()].sort((a, b) => a - b);
      const company = this.cfg.takeTurns
        ? order.find((c) => c > last) ?? order[0]
        : this.trucks[q.find((id) => this.trucks[id].state === 'queued' && !skip.has(id) && this.docked(this.trucks[id], bays))!].company;
      const id = firsts.get(company)!;
      const truck = this.trucks[id];
      const stop = truck.orders[truck.orderIndex];
      if (stop.action === 'load') {
        if (!takePallet(l)) return; // no stock: everyone waits for the next cycle
        truck.serving = { action: 'load', good: l.good };
      } else {
        const origin = truck.cargo ? this.loc(truck.cargo.origin) ?? null : null;
        if (!deliverPallet(l, origin)) {
          if (l.closed || l.demand <= 0) return; // satisfied: everyone waits for the next cycle
          skip.add(id); // this truck's pallet is no use here; serve the others
          continue;
        }
        truck.serving = { action: 'unload', price: l.price };
      }
      truck.state = 'servicing';
      truck.busyUntil = now + this.cfg.serviceSec;
      this.lastServed.set(location, company);
      busy++;
    }
  }

  private finishService(truck: Truck, now: number) {
    // The pallet changes hands now, at the end of the load or unload.
    const done = truck.serving;
    const location = truck.at;
    truck.serving = null;
    if (done && location !== null) {
      if (done.action === 'load') {
        truck.cargo = { good: done.good, origin: location, processed: this.cfg.viaDepot === 'none' };
        this.emit({ type: 'loaded', t: now, truck: truck.id, company: truck.company, location, good: done.good });
      } else if (truck.cargo) {
        const cargo = truck.cargo;
        truck.cargo = null;
        this.emit({ type: 'delivered', t: now, truck: truck.id, company: truck.company, location, good: cargo.good, origin: cargo.origin, price: done.price });
        // One trip per dispatch: free again, heading home until it's sent out on the next one.
        if (this.cfg.oneTrip) {
          truck.route = null;
          truck.orders = [];
          truck.homing = true;
        }
      }
    }
    this.leaveQueue(truck);
    truck.state = 'driving'; // departForStop sets the real state
    if (truck.homing) {
      // Unassigned: deliver what it's carrying, then home.
      if (truck.cargo && truck.orders.length) return this.departForStop(truck, now, false);
      truck.orders = [];
      return this.driveTo(truck, truck.home, now);
    }
    // orderIndex -1 means orders were replaced mid-service: start the new list from the top.
    if (truck.orderIndex < 0) {
      truck.orderIndex = 0;
      this.departForStop(truck, now, false);
    } else this.departForStop(truck, now, true);
  }

  /**
   * Take a truck off its route: it drives back to its depot and waits there as a free truck.
   * A truck carrying a pallet (or loading one) delivers it first (no dumping): it keeps only its
   * unload stop, and its factory stop before that if the pallet hasn't been processed yet, and
   * heads home once the pallet is gone.
   */
  sendHome(truck: Truck, now: number) {
    truck.route = null;
    truck.homing = true;
    truck.pendingOrders = null;
    const loading = truck.state === 'servicing' && truck.serving?.action === 'load';
    const carrying = truck.cargo !== null || loading;
    const unload = carrying ? truck.orders.find((s) => s.action === 'unload') : undefined;
    // Still raw: through the factory first (unless it's being processed there right now).
    const raw = loading ? this.cfg.viaDepot !== 'none' : truck.cargo !== null && !truck.cargo.processed && !truck.signing;
    const sign = raw ? truck.orders.find((s) => s.action === 'signOff') : undefined;
    truck.orders = unload ? (sign ? [sign, unload] : [unload]) : [];
    truck.orderIndex = 0;
    if (truck.state === 'servicing') return; // finishService sends it on
    if (truck.signing) return; // goes home (or delivers first) once processing is done
    if (unload) {
      truck.state = 'driving';
      truck.path = [];
      truck.progress = 0;
      this.departForStop(truck, now, false);
    } else this.driveTo(truck, truck.home, now);
  }

  /** Drive to a node with no stop at the end (used to return to the depot). */
  private driveTo(truck: Truck, node: number, now: number) {
    this.leaveQueue(truck);
    if (truck.berth && node === truck.node) {
      truck.berth.leaving = false;
      truck.homing = false;
      return this.goIdle(truck, now, 'home');
    }
    const route = routeVia(this.graph, [this.startNode(truck), node]);
    if (!route || route.length <= 1) {
      truck.homing = false;
      return this.goIdle(truck, now, 'home');
    }
    truck.toHome = true;
    truck.path = route.slice(1);
    truck.progress = 0;
    truck.state = 'driving';
    if (truck.berth) truck.berth.leaving = true; // pulls out first
  }

  /**
   * A producer or consumer closed: drop it from every truck's orders. Trucks queued there, or
   * driving there, re-plan (and go idle if nothing useful is left).
   */
  locationClosed(location: number, now: number) {
    this.queues.delete(location);
    this.lastServed.delete(location);
    for (const truck of this.trucks) {
      const had = truck.orders.length;
      truck.orders = truck.orders.filter((s) => s.location !== location);
      if (truck.pendingOrders) truck.pendingOrders = truck.pendingOrders.filter((s) => s.location !== location);
      const affected = truck.at === location || (truck.state === 'driving' && truck.orders.length !== had);
      if (truck.at === location) truck.at = null;
      if (truck.orders.length !== had || affected) {
        if (truck.state === 'servicing' && truck.at !== null) continue; // finishing a pallet elsewhere
        if (truck.signing) {
          truck.orderIndex = Math.min(truck.orderIndex, Math.max(0, truck.orders.length - 1));
          continue; // re-plans once it's fixed
        }
        truck.orderIndex = Math.min(truck.orderIndex, Math.max(0, truck.orders.length - 1));
        truck.state = 'driving';
        truck.path = [];
        truck.progress = 0;
        this.departForStop(truck, now, false);
      }
    }
  }

  /** Where a truck is right now, for drawing. */
  position(truck: Truck): { x: number; y: number } {
    const line = truck.berth ? this.line(truck.node, truck.berth.kerb) : null;
    if (truck.berth && line) {
      const p = linePoint(this.graph, line, truck.berth.s);
      return { x: p.x, y: p.y };
    }
    const a = this.graph.nodes[truck.node];
    if (truck.state !== 'driving' || truck.path.length === 0) return { x: a.x, y: a.y };
    const b = this.graph.nodes[truck.path[0]];
    const len = edgeLength(this.graph, truck.node, truck.path[0]);
    const f = len > 0 ? truck.progress / len : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
}
