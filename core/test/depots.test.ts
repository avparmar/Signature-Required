import { describe, expect, it } from 'vitest';
import { depotPrice, distancesFrom, DEFAULT_DEPOTS, newGame, type Game } from '../src/index.js';

function setup() {
  // Pins $30 trucks, which these price checks were written against.
  const g = newGame({ seed: 7, auctions: { openingRound: false }, depots: { truckPrice: 30 } });
  g.companies[0].shares = [0, null, null, null, null]; // player 0 is president of company 0
  const home = g.town.locations.find((l) => l.startCompany === 0)!;
  return { g, home };
}

const rejections = (g: Game, p: number) => g.drainEvents(p).filter((e) => e.type === 'rejected');

describe('depot pricing', () => {
  it('costs the base price nearby and more per block further out', () => {
    expect(depotPrice(DEFAULT_DEPOTS, 2)).toBe(80);
    expect(depotPrice(DEFAULT_DEPOTS, 4)).toBe(80);
    expect(depotPrice(DEFAULT_DEPOTS, 9)).toBe(130);
    expect(depotPrice(DEFAULT_DEPOTS, 4.5)).toBe(85);
  });

  it('measures distance from the nearest depot the company owns', () => {
    const { g, home } = setup();
    const d = distancesFrom(g.town.graph, home.node);
    const free = g.town.locations.filter((l) => l.kind === 'depot' && l.startCompany === null);
    const far = free.sort((a, b) => d[b.node] - d[a.node])[0];
    const near = free.sort((a, b) => d[a.node] - d[b.node])[0];
    expect(g.depotPriceFor(0, near.id)).toBeLessThan(g.depotPriceFor(0, far.id));
    expect(g.depotPriceFor(0, far.id)).toBe(depotPrice(g.cfg.depots, d[far.node]));
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
