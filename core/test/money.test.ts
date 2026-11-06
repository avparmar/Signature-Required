import { describe, expect, it } from 'vitest';
import { DEFAULT_MONEY, distancesFrom, investCost, newGame, payPerShare, Rng, assignPrices, type Game, type GameEvent } from '../src/index.js';

function setup(o: Parameters<typeof newGame>[0] = {}) {
  const g = newGame({ seed: 7, ...o, auctions: { openingRound: false, ...o.auctions } });
  const home = g.town.locations.find((l) => l.startCompany === 0)!;
  const d = distancesFrom(g.town.graph, home.node);
  const producer = g.town.locations.filter((l) => l.kind === 'producer').sort((a, b) => d[a.node] - d[b.node])[0];
  const consumer = g.town.locations
    .filter((l) => l.kind === 'consumer' && l.good === producer.good)
    .sort((a, b) => d[a.node] - d[b.node])[0];
  return { g, home, producer, consumer };
}

function runFor(g: Game, sec: number) {
  const n = Math.round(sec / g.cfg.tickSec);
  for (let i = 0; i < n && !g.done; i++) g.step();
}

const of = (evs: GameEvent[], type: string) => evs.filter((e) => e.type === type);

describe('prices', () => {
  it('gives a quarter of consumers the premium price, the rest the normal one', () => {
    const prices = assignPrices([...Array(20).keys()], DEFAULT_MONEY, new Rng(1));
    const vals = [...prices.values()];
    const { palletPrice, premiumPrice } = DEFAULT_MONEY;
    expect(vals.filter((p) => p === premiumPrice)).toHaveLength(5);
    expect(vals.filter((p) => p === palletPrice)).toHaveLength(15);
  });

  it('every consumer in a game has a price; producers have none', () => {
    const { g } = setup();
    const { palletPrice, premiumPrice } = g.cfg.money;
    for (const l of g.locations) expect(l.price).toBe(l.kind === 'consumer' ? (l.price === premiumPrice ? premiumPrice : palletPrice) : 0);
    expect(g.locations.some((l) => l.price === premiumPrice)).toBe(true);
  });
});

describe('payPerShare', () => {
  it('splits into one part per share and skips bank-held shares', () => {
    const paid = payPerShare([0, 0, 1, null, null], 10);
    expect(paid.get(0)).toBeCloseTo(4);
    expect(paid.get(1)).toBeCloseTo(2);
    expect([...paid.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(6); // $4 for the bank's shares is never paid
  });
});

describe('deliveries and dividends', () => {
  it('splits each delivery price between the treasury and the pot, half each', () => {
    const { g, home, producer, consumer } = setup();
    g.companies[0].shares = [0, null, null, null, null];
    g.addTruck(0);
    g.act(0, { type: 'assignRoute', depot: home.id, producer: producer.id, consumer: consumer.id });
    runFor(g, 170);
    const deliveries = of(g.drainEvents(0), 'delivered');
    expect(deliveries.length).toBeGreaterThan(0);
    const price = g.location(consumer.id)!.price;
    expect(g.companies[0].treasury).toBeCloseTo(deliveries.length * price * g.cfg.money.deliveryToTreasury);
    expect(g.cfg.money.deliveryToTreasury + g.cfg.money.deliveryToPot).toBe(1); // a split, nothing printed
    expect(g.companies[0].pot).toBeCloseTo(deliveries.length * price * g.cfg.money.deliveryToPot);
    expect(g.cfg.money.deliveryToPot).toBe(0.5);
    expect(g.observe(0).companies[0].dividendPerShare).toBeCloseTo((deliveries.length * price * 0.5) / 5);
  });

  it('pays out every 3 minutes, per share, and resets the pot', () => {
    const { g } = setup();
    g.companies[0].shares = [0, 0, 1, null, null];
    g.companies[0].pot = 50;
    expect(g.observe(0).nextPayoutAt).toBe(180);
    runFor(g, 179.9);
    expect(g.players[0].cash).toBe(g.cfg.startingCash);
    runFor(g, 0.1);
    expect(g.players[0].cash).toBeCloseTo(g.cfg.startingCash + 20);
    expect(g.players[1].cash).toBeCloseTo(g.cfg.startingCash + 10);
    expect(g.companies[0].pot).toBe(0);
    expect(g.observe(0).nextPayoutAt).toBe(360);
    const payouts = of(g.drainEvents(2), 'payout').filter((e) => e.type === 'payout' && e.company === 0);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ perShare: 10, final: false, paid: { 0: 20, 1: 10 } });
  });

  it('pays five times in a 15-minute game, the last at the end with assets included', () => {
    const { g } = setup({ money: { finalAssetShare: 0.5 } });
    g.companies[0].shares = [0, 0, 0, 0, 0];
    g.companies[0].assets = 200;
    g.companies[0].treasury = 40;
    g.runToEnd();
    const payouts = of(g.drainEvents(0), 'payout').filter((e) => e.type === 'payout' && e.company === 0);
    expect(payouts.map((e) => e.t)).toEqual([180, 360, 540, 720, 900]);
    const last = payouts[4];
    expect(last).toMatchObject({ final: true, bonusPerShare: (0.5 * 240) / 5 });
    expect(g.players[0].cash).toBeCloseTo(g.cfg.startingCash + 0.5 * 240);
  });

  it('a company nobody owns pays nobody', () => {
    const { g } = setup();
    g.companies[4].pot = 100;
    runFor(g, 180);
    expect(g.players.every((p) => p.cash === g.cfg.startingCash)).toBe(true);
  });

  it('purchases count as assets for the final payout', () => {
    const { g, home } = setup({ depots: { truckPrice: 30 } });
    g.companies[0].shares = [0, null, null, null, null];
    g.companies[0].treasury = 60;
    g.act(0, { type: 'buyTruck', company: 0, depot: home.id });
    g.act(0, { type: 'buyTruck', company: 0, depot: home.id });
    g.step();
    expect(g.companies[0].assets).toBe(60);
    expect(g.companies[0].treasury).toBe(0);
  });
});

describe('location investment', () => {
  it('costs $60 from the start level, then 1.5x per level, and less for a shrunken location', () => {
    expect(investCost(DEFAULT_MONEY, 3, 3)).toBe(60);
    expect(investCost(DEFAULT_MONEY, 4, 3)).toBe(90);
    expect(investCost(DEFAULT_MONEY, 1, 3)).toBe(27);
    expect(investCost(DEFAULT_MONEY, 1)).toBe(60);
  });

  it('any player can raise a location from their own cash', () => {
    const { g, producer } = setup();
    g.act(3, { type: 'invest', location: producer.id });
    g.step();
    expect(g.location(producer.id)!.level).toBe(g.cfg.cycles.startLevel + 1);
    expect(g.players[3].cash).toBe(g.cfg.startingCash - 60);
    expect(of(g.drainEvents(0), 'invested')).toHaveLength(1);
  });

  it("can't invest without the cash, or in a depot site", () => {
    const { g, producer, home } = setup();
    g.act(0, { type: 'invest', location: producer.id }); // $60, leaves $40
    g.act(0, { type: 'invest', location: producer.id }); // $90: too much
    g.act(1, { type: 'invest', location: home.id });
    g.step();
    expect(g.location(producer.id)!.level).toBe(g.cfg.cycles.startLevel + 1);
    expect(of(g.drainEvents(0), 'rejected')).toHaveLength(1);
    expect(of(g.drainEvents(1), 'rejected')).toHaveLength(1);
  });
});

describe('final bonus based on earnings', () => {
  it('pays a multiple of the last period\'s earnings, ignoring assets', () => {
    const g = newGame({ seed: 7, auctions: { openingRound: false }, money: { finalBonus: 'earnings', finalEarningsMultiple: 2 } });
    g.companies[0].shares = [0, 0, 0, 0, 0];
    g.companies[0].assets = 500;
    g.companies[0].treasury = 500;
    for (let i = 0; i < 8999; i++) g.step();
    g.companies[0].pot = 30; // earned in the last stretch
    const before = g.players[0].cash;
    g.step();
    expect(g.done).toBe(true);
    expect(g.players[0].cash - before).toBeCloseTo(30 + 2 * 30);
  });
});
