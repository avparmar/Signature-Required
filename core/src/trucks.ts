/**
 * Trucks: repeating orders, driving along streets, queueing at buildings and using loading bays.
 *
 * - A truck carries one pallet.
 * - Orders are a repeating list of stops: load at a producer, unload at a consumer.
 * - Trucks pass each other freely on streets; at a building they queue in arrival order and
 *   hold a bay only while loading/unloading. Trucks waiting for stock or demand keep their place
 *   in the queue without blocking a bay.
 * - No dumping: a pallet only leaves a truck when a consumer of that good accepts it.
 */
import { deliverPallet, takePallet, type LocationState } from './economy.js';
import { edgeLength, routeVia, type RoadGraph } from './graph.js';

export interface TruckConfig {
  /** Driving speed, blocks per second. */
  speed: number;
  /** Seconds to load or unload one pallet at a bay. */
  serviceSec: number;
}

export const DEFAULT_TRUCKS: TruckConfig = {
  speed: 0.35,
  serviceSec: 3,
};

export interface Stop {
  /** Town location id: a producer for 'load', a consumer for 'unload'. */
  location: number;
  action: 'load' | 'unload';
  /** Optional road nodes to drive through, in order, on the way to this stop. */
  via?: number[];
}

export interface Cargo {
  good: number;
  /** Producer it was picked up at (credited when it's delivered). */
  origin: number;
}

export type TruckState =
  | 'idle' // no orders, or nothing it can do with them
  | 'driving'
  | 'queued' // at a building, waiting for a bay, stock or demand
  | 'servicing'; // loading or unloading at a bay

export interface Truck {
  id: number;
  company: number;
  /** Depot (town location id) this truck belongs to; counts against its capacity. */
  depot: number;
  state: TruckState;
  /** Node the truck is at, or last passed. */
  node: number;
  /** Remaining route (next node first) while driving. */
  route: number[];
  /** Distance travelled along the current street (from `node` towards route[0]). */
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
}

export type TruckEvent =
  | { type: 'loaded'; t: number; truck: number; company: number; location: number; good: number }
  | { type: 'delivered'; t: number; truck: number; company: number; location: number; good: number; origin: number; price: number }
  | { type: 'truckIdle'; t: number; truck: number; company: number; reason: string };

/** Why a set of orders is invalid, or null if it's fine. */
export function validateOrders(stops: Stop[], kindOf: (loc: number) => string | undefined, nodeCount: number): string | null {
  for (const s of stops) {
    const kind = kindOf(s.location);
    if (kind === undefined) return `no location ${s.location}`;
    if (s.action === 'load' && kind !== 'producer') return `can only load at a producer (location ${s.location} is a ${kind})`;
    if (s.action === 'unload' && kind !== 'consumer') return `can only unload at a consumer (location ${s.location} is a ${kind})`;
    for (const n of s.via ?? []) if (!Number.isInteger(n) || n < 0 || n >= nodeCount) return `no road node ${n}`;
  }
  return null;
}

export class TruckSystem {
  readonly trucks: Truck[] = [];
  /** Trucks queued or servicing at each location, in arrival order. */
  readonly queues = new Map<number, number[]>();

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
      route: [],
      progress: 0,
      cargo: null,
      orders: [],
      orderIndex: 0,
      at: null,
      busyUntil: 0,
      pendingOrders: null,
    };
    this.trucks.push(t);
    return t;
  }

  /** Replace a truck's orders (already validated). Mid-street, they apply at the next intersection. */
  setOrders(truck: Truck, stops: Stop[], now: number) {
    if (truck.state === 'driving' && truck.progress > 0) {
      truck.pendingOrders = stops;
      return;
    }
    this.applyOrders(truck, stops, now);
  }

  private applyOrders(truck: Truck, stops: Stop[], now: number) {
    truck.pendingOrders = null;
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
    const c = this.loc(stop.location);
    return truck.cargo !== null && c !== undefined && c.good === truck.cargo.good;
  }

  /**
   * Head for the current stop, skipping stops it can't use (a load stop while carrying, or an
   * unload stop for a different good). Goes idle if no stop is any use.
   */
  private departForStop(truck: Truck, now: number, advance: boolean) {
    const n = truck.orders.length;
    if (n === 0) return this.goIdle(truck, now, 'no orders');
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
    truck.route = route.slice(1);
    truck.progress = 0;
    truck.state = 'driving';
    if (truck.route.length === 0) this.arrive(truck, stop.location);
  }

  private goIdle(truck: Truck, now: number, reason: string) {
    const was = truck.state;
    truck.state = 'idle';
    truck.route = [];
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
    }
    // Serve queues in a fixed order (by location id) for determinism.
    for (const location of [...this.queues.keys()].sort((a, b) => a - b)) this.serve(location, now, baysOf(location));
  }

  private drive(truck: Truck, distance: number, now: number) {
    let left = distance;
    while (left > 0 && truck.route.length) {
      const next = truck.route[0];
      const len = edgeLength(this.graph, truck.node, next);
      const remaining = len - truck.progress;
      if (left < remaining) {
        truck.progress += left;
        return;
      }
      left -= remaining;
      truck.node = next;
      truck.route.shift();
      truck.progress = 0;
      if (truck.pendingOrders) {
        // New orders take over at this intersection.
        this.applyOrders(truck, truck.pendingOrders, now);
        if (truck.state !== 'driving') return;
      }
    }
    if (truck.route.length === 0 && truck.state === 'driving') this.arrive(truck, truck.orders[truck.orderIndex].location);
  }

  private serve(location: number, now: number, bays: number) {
    const q = this.queues.get(location)!;
    const l = this.loc(location);
    if (!l) return;
    let busy = q.filter((id) => this.trucks[id].state === 'servicing').length;
    for (const id of q) {
      if (busy >= bays) break;
      const truck = this.trucks[id];
      if (truck.state !== 'queued') continue;
      const stop = truck.orders[truck.orderIndex];
      if (stop.action === 'load') {
        if (!takePallet(l)) continue; // no stock: wait in line for the next cycle
        truck.cargo = { good: l.good, origin: l.id };
        this.emit({ type: 'loaded', t: now, truck: id, company: truck.company, location, good: l.good });
      } else {
        const origin = truck.cargo ? this.loc(truck.cargo.origin) ?? null : null;
        if (!deliverPallet(l, origin)) continue; // satisfied: wait for the next cycle
        const cargo = truck.cargo!;
        truck.cargo = null;
        this.emit({ type: 'delivered', t: now, truck: id, company: truck.company, location, good: cargo.good, origin: cargo.origin, price: l.price });
      }
      truck.state = 'servicing';
      truck.busyUntil = now + this.cfg.serviceSec;
      busy++;
    }
  }

  private finishService(truck: Truck, now: number) {
    this.leaveQueue(truck);
    truck.state = 'driving'; // departForStop sets the real state
    // orderIndex -1 means orders were replaced mid-service: start the new list from the top.
    if (truck.orderIndex < 0) {
      truck.orderIndex = 0;
      this.departForStop(truck, now, false);
    } else this.departForStop(truck, now, true);
  }

  /** Where a truck is right now, for drawing. */
  position(truck: Truck): { x: number; y: number } {
    const a = this.graph.nodes[truck.node];
    if (truck.state !== 'driving' || truck.route.length === 0) return { x: a.x, y: a.y };
    const b = this.graph.nodes[truck.route[0]];
    const len = edgeLength(this.graph, truck.node, truck.route[0]);
    const f = len > 0 ? truck.progress / len : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
}
