import { describe, expect, it } from 'vitest';
import { Game, makeGameConfig, newGame, replay } from '../src/index.js';

describe('Game loop', () => {
  it('runs a full 15-minute game headless and ends on time', () => {
    const g = newGame({ seed: 3 });
    expect(g.totalTicks).toBe(9000);
    g.runToEnd();
    expect(g.done).toBe(true);
    expect(g.t).toBeCloseTo(900);
    const types = g.drainEvents(0).map((e) => e.type).filter((x) => x === 'start' || x === 'end');
    expect(types).toEqual(['start', 'end']);
  });

  it('defaults to players + 1 companies, with one starting depot each', () => {
    const g = newGame({ players: 3 });
    expect(g.companies).toHaveLength(4);
    expect(g.town.locations.filter((l) => l.startCompany !== null)).toHaveLength(4);
  });

  it('starts every company fully owned by the bank, with no president yet', () => {
    const g = newGame({ players: 4 });
    for (const c of g.companies) {
      expect(c.shares).toEqual([null, null, null, null, null]);
      expect(c.treasury).toBe(0);
      expect(g.presidents(c.id)).toEqual([]);
    }
    expect(g.players.every((p) => p.cash === g.cfg.startingCash)).toBe(true);
  });

  it('treats tied largest shareholders as co-presidents', () => {
    const g = newGame({ players: 3 });
    g.companies[0].shares = [0, 0, 1, 1, 2];
    expect(g.presidents(0)).toEqual([0, 1]);
    g.companies[0].shares = [0, 1, 1, 2, null];
    expect(g.presidents(0)).toEqual([1]);
  });

  it('applies actions at the start of the next tick, in the order they arrived', () => {
    const g = newGame();
    g.step();
    g.act(2, { type: 'noop' });
    g.act(0, { type: 'noop' });
    expect(g.actionLog).toHaveLength(0);
    g.step();
    expect(g.actionLog).toEqual([
      { tick: 1, player: 2, action: { type: 'noop' } },
      { tick: 1, player: 0, action: { type: 'noop' } },
    ]);
  });

  it('rejects unknown actions and actions after the end, telling only that player', () => {
    const g = newGame({ durationSec: 1 });
    g.act(1, { type: 'fly' } as never);
    g.step();
    expect(g.drainEvents(1).some((e) => e.type === 'rejected')).toBe(true);
    expect(g.drainEvents(0).some((e) => e.type === 'rejected')).toBe(false);
    g.runToEnd();
    g.act(0, { type: 'noop' });
    g.step();
    expect(g.actionLog.filter((a) => a.player === 0)).toHaveLength(0);
  });

  it('is deterministic: same seed and actions give the same state', () => {
    const run = () => {
      const g = newGame({ seed: 11 });
      for (let i = 0; i < 2000; i++) {
        if (i % 97 === 0) g.act(i % 4, { type: 'noop' });
        g.step();
      }
      return g;
    };
    expect(run().stateHash()).toEqual(run().stateHash());
  });

  it('replays from the action log to the same final state', () => {
    const cfg = makeGameConfig({ seed: 8, durationSec: 60 });
    const g = new Game(cfg);
    while (!g.done) {
      if (g.tick % 50 === 3) g.act(g.tick % 4, { type: 'noop' });
      g.step();
    }
    const r = replay(cfg, g.actionLog);
    expect(r.stateHash()).toEqual(g.stateHash());
    expect(r.actionLog).toEqual(g.actionLog);
  });

  it('observations are copies: changing one does not change the game', () => {
    const g = newGame();
    const o = g.observe(0);
    o.players[0].cash = 999;
    o.companies[0].shares[0] = 3;
    expect(g.players[0].cash).toBe(g.cfg.startingCash);
    expect(g.companies[0].shares[0]).toBe(null);
    expect(o.timeLeft).toBe(900);
  });
});
