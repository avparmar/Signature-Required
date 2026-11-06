/**
 * Trucks: repeating orders, driving along streets, queueing at buildings and using loading bays.
 *
 * - A truck carries one pallet.
 * - Orders are a repeating list of stops: load at a producer, unload at a consumer.
 * - Trucks pass each other freely on streets; at a building they queue and hold a bay only while
 *   loading/unloading. Trucks waiting for stock or demand keep their place without blocking a bay.
 * - Companies take turns: when trucks from several companies are waiting, the building serves
 *   the next company after the one it served last, so swarming a building with trucks doesn't
 *   let one company hog it. Within a company, trucks go in arrival order.
 * - No dumping: a pallet only leaves a truck when a consumer of that good accepts it.
 * - Routes run through the company's factory (`viaDepot`): every load is processed there on its
 *   way to the consumer, which also counts as the truck's servicing.
 */
import { deliverPallet, takePallet, type LocationState } from './economy.js';
import { edgeLength, routeVia, type RoadGraph } from './graph.js';

export interface TruckConfig {
  /** Driving speed, blocks per second. */
  speed: number;
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
  /** Trucks pull out of a building (or factory) one at a time, at least this many seconds apart,
   *  so trucks sent out together don't drive stacked on top of each other. */
  departGapSec: number;
}

export const DEFAULT_TRUCKS: TruckConfig = {
  speed: 0.35,
  serviceSec: 3,
  takeTurns: true,
  viaDepot: 'loaded',
  signOffSec: 3,
  departGapSec: 1.5,
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
  /** Node the truck is at, or last passed. */
  node: number;
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
      path: [],
      progress: 0,
      cargo: null,
      orders: [],
      orderIndex: 0,
      at: null,
      busyUntil: 0,
      pendingOrders: null,
      route: null,
      home: node,
      homing: false,
      toHome: false,
      signing: false,
    };
    this.trucks.push(t);
    return t;
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
    const route = routeVia(this.graph, [truck.node, ...(stop.via ?? []), target]);
    if (!route) return this.goIdle(truck, now, 'no route');
    truck.toHome = false;
    truck.path = route.slice(1);
    truck.progress = 0;
    truck.state = 'driving';
    if (truck.path.length === 0) this.arriveAtStop(truck, now);
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
    for (const truck of this.trucks) {
      if (truck.state === 'driving') this.drive(truck, this.cfg.speed * dt, now);
      else if (truck.state === 'servicing' && now >= truck.busyUntil - 1e-9) this.finishService(truck, now);
      else if (truck.state === 'processing' && now >= truck.busyUntil - 1e-9) this.finishSignOff(truck, now);
    }
    // Serve queues in a fixed order (by location id) for determinism.
    for (const location of [...this.queues.keys()].sort((a, b) => a - b)) this.serve(location, now, baysOf(location));
  }

  /** When a truck last pulled out of each building node (for departGapSec). */
  private leftAt = new Map<number, number>();

  private drive(truck: Truck, distance: number, now: number) {
    // Pulling out of a building: wait for the truck ahead to get going first.
    if (truck.progress === 0 && truck.path.length && this.graph.terminal[truck.node]) {
      const last = this.leftAt.get(truck.node);
      if (last !== undefined && now - last < this.cfg.departGapSec - 1e-9) return;
      this.leftAt.set(truck.node, now);
    }
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
      truck.node = next;
      truck.path.shift();
      truck.progress = 0;
      if (truck.pendingOrders) {
        // New orders take over at this intersection.
        this.applyOrders(truck, truck.pendingOrders, now);
        if (truck.state !== 'driving') return;
      }
    }
    if (truck.path.length === 0 && truck.state === 'driving') {
      if (truck.toHome) {
        truck.toHome = false;
        truck.homing = false;
        this.goIdle(truck, now, 'home');
      } else this.arriveAtStop(truck, now);
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
        if (t.state === 'queued' && !skip.has(id) && !firsts.has(t.company)) firsts.set(t.company, id);
      }
      if (firsts.size === 0) return;
      // Next company after the one served last (wrapping round by company id).
      const last = this.lastServed.get(location) ?? -1;
      const order = [...firsts.keys()].sort((a, b) => a - b);
      const company = this.cfg.takeTurns
        ? order.find((c) => c > last) ?? order[0]
        : this.trucks[q.find((id) => this.trucks[id].state === 'queued' && !skip.has(id))!].company;
      const id = firsts.get(company)!;
      const truck = this.trucks[id];
      const stop = truck.orders[truck.orderIndex];
      if (stop.action === 'load') {
        if (!takePallet(l)) return; // no stock: everyone waits for the next cycle
        truck.cargo = { good: l.good, origin: l.id, processed: this.cfg.viaDepot === 'none' };
        this.emit({ type: 'loaded', t: now, truck: id, company: truck.company, location, good: l.good });
      } else {
        const origin = truck.cargo ? this.loc(truck.cargo.origin) ?? null : null;
        if (!deliverPallet(l, origin)) {
          if (l.closed || l.demand <= 0) return; // satisfied: everyone waits for the next cycle
          skip.add(id); // this truck's pallet is no use here; serve the others
          continue;
        }
        const cargo = truck.cargo!;
        truck.cargo = null;
        this.emit({ type: 'delivered', t: now, truck: id, company: truck.company, location, good: cargo.good, origin: cargo.origin, price: l.price });
      }
      truck.state = 'servicing';
      truck.busyUntil = now + this.cfg.serviceSec;
      this.lastServed.set(location, company);
      busy++;
    }
  }

  private finishService(truck: Truck, now: number) {
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
   * A truck carrying a pallet delivers it first (no dumping): it keeps only its unload stop, and
   * heads home once the pallet is gone.
   */
  sendHome(truck: Truck, now: number) {
    truck.route = null;
    truck.homing = true;
    truck.pendingOrders = null;
    const unload = truck.cargo ? truck.orders.find((s) => s.action === 'unload') : undefined;
    truck.orders = unload ? [unload] : [];
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
    const route = routeVia(this.graph, [truck.node, node]);
    if (!route || route.length <= 1) {
      truck.homing = false;
      return this.goIdle(truck, now, 'home');
    }
    truck.toHome = true;
    truck.path = route.slice(1);
    truck.progress = 0;
    truck.state = 'driving';
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
    const a = this.graph.nodes[truck.node];
    if (truck.state !== 'driving' || truck.path.length === 0) return { x: a.x, y: a.y };
    const b = this.graph.nodes[truck.path[0]];
    const len = edgeLength(this.graph, truck.node, truck.path[0]);
    const f = len > 0 ? truck.progress / len : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
}
