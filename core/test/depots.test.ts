import { describe, expect, it } from 'vitest';
import { depotPrice, distancesFrom, DEFAULT_DEPOTS, newGame, subsidisedPrice, type DepotConfig, type Game } from '../src/index.js';

function setup(depots: Partial<DepotConfig> = {}) {
  // Pins $30 trucks, 3-truck depots and subsidy pricing, which these checks were written against.
  const g = newGame({ seed: 7, autoRoutes: false, startingTrucks: 0, auctions: { openingRound: false }, depots: { truckPrice: 30, capacity: 3, upkeepPerMin: 0, townPriceStep: 0, pricing: 'subsidy', ...depots } });
  g.companies[0].shares = [0, null, null, null, null]; // player 0 is president of company 0
  const home = g.town.locations.find((l) => l.startCompany === 0)!;
  return { g, home };
}

const rejections = (g: Game, p: number) => g.drainEvents(p).filter((e) => e.type === 'rejected');

describe('depot pricing by distance (older rule)', () => {
  const cfg = { ...DEFAULT_DEPOTS, pricing: 'distance' as const, depotBase: 80 };
  it('costs the base price nearby and more per block further out', () => {
    expect(depotPrice(cfg, 2)).toBe(80);
    expect(depotPrice(cfg, 4)).toBe(80);
    expect(depotPrice(cfg, 9)).toBe(130);
    expect(depotPrice(cfg, 4.5)).toBe(85);
  });

  it('measures distance from the nearest depot the company owns', () => {
    const { g, home } = setup({ pricing: 'distance', depotBase: 80 });
    const d = distancesFrom(g.town.graph, home.node);
    const free = g.town.locations.filter((l) => l.kind === 'depot' && l.startCompany === null);
    const far = free.sort((a, b) => d[b.node] - d[a.node])[0];
    const near = free.sort((a, b) => d[a.node] - d[b.node])[0];
    expect(g.depotPriceFor(0, near.id)).toBeLessThan(g.depotPriceFor(0, far.id));
    expect(g.depotPriceFor(0, far.id)).toBe(depotPrice(g.cfg.depots, d[far.node]));
  });
});

describe('depot pricing by band', () => {
  it('a site costs the same for every company, dearer the nearer the centre of town', () => {
    const { g } = setup({ pricing: 'band' });
    const sites = g.town.locations.filter((l) => l.kind === 'depot' && l.startCompany === null);
    for (const site of sites) {
      const price = g.cfg.depots.bandSitePrice[g.bandOf(site.id)];
      for (let c = 0; c < g.cfg.companies; c++) expect(g.depotPriceFor(c, site.id)).toBe(price);
    }
    const [centre, middle, outer] = g.cfg.depots.bandSitePrice;
    expect(centre).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(outer);
    expect(new Set(sites.map((s) => g.bandOf(s.id))).size).toBeGreaterThan(1);
  });
});

describe('depot pricing by local subsidy', () => {
  it('discounts the full price by your progress towards the service target, up to the maximum subsidy', () => {
    expect(subsidisedPrice(DEFAULT_DEPOTS, 0)).toBe(150);
    expect(subsidisedPrice(DEFAULT_DEPOTS, 0.5)).toBe(105);
    expect(subsidisedPrice(DEFAULT_DEPOTS, 1)).toBe(60);
  });

  it('charges full price to everyone until somebody serves the district', () => {
    const { g } = setup();
    const site = g.town.locations.find((l) => l.kind === 'depot' && l.startCompany === null)!;
    for (let c = 0; c < g.cfg.companies; c++) expect(g.depotPriceFor(c, site.id)).toBe(g.cfg.depots.depotBase);
  });

  function serveNearSite(depots: Partial<DepotConfig>) {
    const { g, home } = setup({ capacity: 8, ...depots });
    const d = distancesFrom(g.town.graph, home.node);
    // Serve the producer and consumer nearest home.
    const near = (kind: string, good?: number) =>
      g.town.locations.filter((l) => l.kind === kind && (good === undefined || l.good === good)).sort((a, b) => d[a.node] - d[b.node])[0];
    const producer = near('producer');
    const consumer = near('consumer', producer.good!);
    // The free site whose district covers the producer.
    const site = g.town.locations
      .filter((l) => l.kind === 'depot' && l.startCompany === null)
      .sort((a, b) => distancesFrom(g.town.graph, a.node)[producer.node] - distancesFrom(g.town.graph, b.node)[producer.node])[0];
    expect(distancesFrom(g.town.graph, site.node)[producer.node]).toBeLessThanOrEqual(g.cfg.depots.districtBlocks);
    g.companies[0].treasury = 1000;
    for (let i = 0; i < 3; i++) {
      g.act(0, { type: 'buyTruck', company: 0, depot: home.id });
      g.step();
      g.act(0, { type: 'assignRoute', depot: home.id, producer: producer.id, consumer: consumer.id });
    }
    for (let i = 0; i < 1200; i++) g.step(); // two minutes
    return { g, home, site, producer, consumer };
  }

  it('gives no discount until a company has the minimum service in the district', () => {
    const { g, site } = serveNearSite({ subsidyMinPallets: 10_000 });
    expect(g.depotPriceFor(0, site.id)).toBe(g.cfg.depots.depotBase);
  });

  it('gives the full discount once a company reaches the service target on its own', () => {
    const { g, site } = serveNearSite({ subsidyTarget: 6 });
    expect(g.depotPriceFor(0, site.id)).toBe(subsidisedPrice(g.cfg.depots, 1));
  });

  it('gets cheaper for the company serving the district, and the discount fades when service stops', () => {
    const { g, home, site, producer, consumer } = serveNearSite({});
    const served = g.depotPriceFor(0, site.id);
    expect(served).toBeLessThan(g.cfg.depots.depotBase);
    expect(served).toBeGreaterThanOrEqual(subsidisedPrice(g.cfg.depots, 1));
    expect(g.depotPriceFor(1, site.id)).toBe(g.cfg.depots.depotBase); // nobody else served it
    // Stop serving: once the window passes, the discount is gone.
    for (let i = 0; i < 3; i++) g.act(0, { type: 'unassignRoute', depot: home.id, producer: producer.id, consumer: consumer.id });
    g.step();
    expect(g.routes()).toHaveLength(0);
    for (let i = 0; i < (g.cfg.depots.subsidyWindowSec + 60) * 10; i++) g.step();
    expect(g.depotPriceFor(0, site.id)).toBe(g.cfg.depots.depotBase);
  });
});

describe('buying', () => {
  it('every company starts owning just its starting depot', () => {
    const { g } = setup();
    for (let c = 0; c < g.cfg.companies; c++) expect(g.depotsOf(c)).toHaveLength(1);
    expect(Object.keys(g.observe(0).depots)).toHaveLength(g.cfg.companies);
  });

  it('buys trucks from the treasury, up to the depot capacity', () => {
    const { g, home } = setup();
    g.companies[0].treasury = 200;
    for (let i = 0; i < 4; i++) g.act(0, { type: 'buyTruck', company: 0, depot: home.id });
    g.step();
    expect(g.trucksAt(home.id)).toBe(3);
    expect(g.companies[0].treasury).toBe(200 - 3 * 30);
    const rej = rejections(g, 0);
    expect(rej).toHaveLength(1);
    expect(JSON.stringify(rej[0])).toContain('full');
    expect(g.trucks.trucks[0]).toMatchObject({ company: 0, depot: home.id, node: home.node });
  });

  it('pools trucks across the company: each factory adds to the limit, and any free truck can run any route', () => {
    const { g, home } = setup({ capacity: 2, pricing: 'distance', depotBase: 80 });
    const site = g.town.locations.find((l) => l.kind === 'depot' && l.startCompany === null)!;
    g.companies[0].treasury = 1000;
    g.act(0, { type: 'buyDepot', company: 0, site: site.id });
    for (let i = 0; i < 5; i++) g.act(0, { type: 'buyTruck', company: 0, depot: home.id });
    g.step();
    expect(g.trucksOf(0)).toBe(4); // two factories x 2
    expect(g.trucksAt(home.id)).toBe(4); // all bought at home
    // A route from the new factory takes a free truck from home, which now belongs there.
    const p = g.town.locations.find((l) => l.kind === 'producer')!;
    const c = g.town.locations.find((l) => l.kind === 'consumer' && l.good === p.good)!;
    g.act(0, { type: 'assignRoute', depot: site.id, producer: p.id, consumer: c.id });
    g.step();
    expect(g.routes()).toHaveLength(1);
    const t = g.trucks.trucks.find((x) => x.route !== null)!;
    expect(t.depot).toBe(site.id);
    expect(t.home).toBe(site.node);
  });

  it("can't buy without the money, the presidency, or the depot", () => {
    const { g, home } = setup();
    g.companies[0].treasury = 10;
    g.act(0, { type: 'buyTruck', company: 0, depot: home.id }); // too poor
    g.act(1, { type: 'buyTruck', company: 0, depot: home.id }); // not president
    const other = g.town.locations.find((l) => l.startCompany === 1)!;
    g.companies[0].treasury = 10;
    g.act(0, { type: 'buyTruck', company: 0, depot: other.id }); // someone else's depot
    g.step();
    expect(rejections(g, 0)).toHaveLength(2);
    expect(rejections(g, 1)).toHaveLength(1);
    expect(g.trucks.trucks).toHaveLength(0);
  });

  it('buys free depot sites, which then hold more trucks', () => {
    const { g, home } = setup();
    const d = distancesFrom(g.town.graph, home.node);
    const site = g.town.locations.filter((l) => l.kind === 'depot' && l.startCompany === null).sort((a, b) => d[a.node] - d[b.node])[0];
    const price = g.depotPriceFor(0, site.id);
    g.companies[0].treasury = price + 30;
    g.act(0, { type: 'buyDepot', company: 0, site: site.id });
    g.act(0, { type: 'buyTruck', company: 0, depot: site.id });
    g.step();
    expect(g.depotsOf(0)).toEqual([home.id, site.id].sort((a, b) => a - b));
    expect(g.trucksAt(site.id)).toBe(1);
    expect(g.companies[0].treasury).toBe(0);
    expect(g.drainEvents(2).map((e) => e.type)).toEqual(expect.arrayContaining(['boughtDepot', 'boughtTruck']));
  });

  it("can't buy a taken site or something that isn't a depot site", () => {
    const { g } = setup();
    g.companies[0].treasury = 1000;
    const taken = g.town.locations.find((l) => l.startCompany === 2)!;
    const producer = g.town.locations.find((l) => l.kind === 'producer')!;
    g.act(0, { type: 'buyDepot', company: 0, site: taken.id });
    g.act(0, { type: 'buyDepot', company: 0, site: producer.id });
    g.step();
    expect(rejections(g, 0)).toHaveLength(2);
    expect(g.companies[0].treasury).toBe(1000);
  });

  it('bought trucks work: give them orders and they deliver', () => {
    const { g, home } = setup();
    g.companies[0].treasury = 30;
    g.act(0, { type: 'buyTruck', company: 0, depot: home.id });
    g.step();
    const d = distancesFrom(g.town.graph, home.node);
    const p = g.town.locations.filter((l) => l.kind === 'producer').sort((a, b) => d[a.node] - d[b.node])[0];
    const c = g.town.locations.filter((l) => l.kind === 'consumer' && l.good === p.good).sort((a, b) => d[a.node] - d[b.node])[0];
    g.act(0, { type: 'assignRoute', depot: home.id, producer: p.id, consumer: c.id });
    for (let i = 0; i < 3000; i++) g.step();
    expect(g.drainEvents(0).some((e) => e.type === 'delivered')).toBe(true);
  });
});

describe('new factory sites', () => {
  it('appear every few minutes on empty lots, away from other factories', () => {
    const g = newGame({ seed: 4, autoRoutes: false, auctions: { openingRound: false }, town: { blocksX: 16, blocksY: 16, producersPerGood: [4, 5], shopsPerProducer: 0, consumersPerGood: [7, 11], shopReach: 0 }, cycles: { startLevel: 3, maxLevel: 5, growAbove: 0.75, shrinkBelow: 0.5, shopShare: 1 }, openings: { everySec: 0 }, depots: { newSiteEverySec: 180 } });
    const before = g.town.locations.filter((l) => l.kind === 'depot').length;
    g.runToEnd();
    const opened = g.drainEvents(0).filter((e) => e.type === 'siteOpened') as { site: number }[];
    // Every 3 minutes, not in the last two: at 3, 6, 9 and 12 minutes.
    expect(opened).toHaveLength(Math.floor((g.cfg.durationSec - 120) / g.cfg.depots.newSiteEverySec));
    expect(g.town.locations.filter((l) => l.kind === 'depot').length).toBe(before + opened.length);
    for (const { site } of opened) {
      const s = g.town.locations[site];
      const others = g.town.locations.filter((l) => l.kind === 'depot' && l.id !== site);
      expect(Math.min(...others.map((o) => Math.hypot(o.x - s.x, o.y - s.y)))).toBeGreaterThanOrEqual(g.town.cfg.depotGap - 1e-9);
    }
  });
});
