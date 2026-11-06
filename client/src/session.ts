/**
 * A match running in this tab: the authoritative Game, the bots in the bot seats, and real-time
 * stepping with pause and speed. Solo, there's one human (this tab's seat); when this tab hosts
 * a multiplayer game, other seats can be remote humans too (their actions arrive over the
 * network, and their events are kept for sending).
 */
import { Game, makeGameConfig, Rng, type Action, type GameConfigOverrides, type GameEvent, type Observation } from '@sr/core';
import { Bot, PERSONALITIES, type BotPersonality } from '@sr/sim';
import type { Match } from './match.js';

export interface SessionOptions {
  overrides?: GameConfigOverrides;
  /** The human's seat; the others are bots. */
  seat?: number;
  /** Other seats played by people (remote players in a hosted game). */
  remote?: number[];
  /** Personalities for bot seats (by seat index); defaults to a speculator then investors. */
  bots?: (BotPersonality | undefined)[];
  /** Watch only: a bot plays the human's seat too, and the human's actions are ignored. */
  watch?: boolean;
  /** Display names by seat (empty for bots). */
  names?: string[];
}

export class Session implements Match {
  readonly game: Game;
  readonly seat: number;
  readonly bots: (Bot | null)[];
  /** Watching the bots: every seat is a bot (the screen shows the human seat's view). */
  readonly watch: boolean;
  readonly multiplayer: boolean;
  readonly canControlTime = true;
  readonly names: string[];
  /** Seats played by remote people (see actAs / takePending). */
  readonly remote: Set<number>;
  paused = false;
  speed = 1;
  /** Real seconds not yet turned into ticks. */
  private acc = 0;
  /** Longest real gap one frame may cover (so a backgrounded tab doesn't fast-forward wildly). */
  maxStepSec = 0.5;
  /** Events waiting for each bot (to think about) or remote human (to be sent). */
  private pending: GameEvent[][];
  /** Events for the human since the last call to takeEvents. */
  private mine: GameEvent[] = [];
  private orderRng: Rng;
  private personalityFor: (p: number) => BotPersonality;

  constructor(opts: SessionOptions = {}) {
    const cfg = makeGameConfig({ seed: Math.floor(Math.random() * 2 ** 31), ...opts.overrides });
    this.game = new Game(cfg);
    this.seat = opts.seat ?? 0;
    this.watch = !!opts.watch;
    this.remote = new Set(opts.remote ?? []);
    this.multiplayer = this.remote.size > 0;
    this.names = Array.from({ length: cfg.players }, (_, p) => opts.names?.[p] ?? '');
    // The same line-up as the bot games: a speculator, a controller, then balanced bots.
    const lineup = [PERSONALITIES.speculator, PERSONALITIES.controller];
    let botCount = 0;
    const pick = new Map<number, BotPersonality>();
    this.personalityFor = (p) => {
      if (!pick.has(p)) pick.set(p, opts.bots?.[p] ?? lineup[botCount++] ?? PERSONALITIES.balanced);
      return pick.get(p)!;
    };
    this.bots = Array.from({ length: cfg.players }, (_, p) => {
      if (this.remote.has(p)) return null;
      if (p === this.seat && !this.watch) return null;
      if (p === this.seat) return new Bot(p, this.game.town, cfg, PERSONALITIES.balanced);
      return new Bot(p, this.game.town, cfg, this.personalityFor(p));
    });
    this.pending = Array.from({ length: cfg.players }, () => []);
    this.orderRng = new Rng(cfg.seed * 31 + 7);
  }

  get cfg() {
    return this.game.cfg;
  }

  /** The human's view of the game. */
  obs(): Observation {
    return this.game.observe(this.seat);
  }

  /** The human acts; it takes effect on the next tick. */
  act(action: Action) {
    if (this.watch) return; // watching: the seat is the bot's
    this.game.act(this.seat, action);
  }

  /** A remote player acts (hosted games). */
  actAs(seat: number, action: Action) {
    if (this.remote.has(seat)) this.game.act(seat, action);
  }

  /** A remote player left: a bot takes their seat from here on. */
  replaceWithBot(seat: number) {
    if (!this.remote.delete(seat)) return;
    this.bots[seat] = new Bot(seat, this.game.town, this.cfg, this.personalityFor(seat));
    this.names[seat] = '';
  }

  /** Events for a remote player since the last call (to send them). */
  takePending(seat: number): GameEvent[] {
    const out = this.pending[seat];
    this.pending[seat] = [];
    return out;
  }

  /** Events for the human since the last call. */
  takeEvents(): GameEvent[] {
    const out = this.mine;
    this.mine = [];
    return out;
  }

  get done() {
    return this.game.done;
  }

  /** Smooth time for drawing: game time plus the unfinished part of the current tick. */
  get renderT(): number {
    if (this.game.phase !== 'running') return this.game.t;
    return this.game.t + Math.min(this.acc, this.cfg.tickSec);
  }

  /** Advance by real elapsed seconds. */
  update(realDt: number) {
    if (this.paused || this.game.done) return;
    const tick = this.cfg.tickSec;
    this.acc += Math.min(realDt, this.maxStepSec) * this.speed;
    let guard = 0;
    while (this.acc >= tick && !this.game.done && guard++ < 400) {
      this.stepOnce();
      this.acc -= tick;
    }
  }

  dispose() {}

  private stepOnce() {
    const g = this.game;
    const thinkSteps = Math.max(1, Math.round(1 / this.cfg.tickSec));
    const look = g.auction !== null || g.steps % thinkSteps === 0;
    // Shuffle who acts first so no bot always wins tied bids (as in the headless runner).
    for (const p of this.orderRng.shuffle([...this.bots.keys()])) {
      const evs = g.drainEvents(p);
      if (p === this.seat) {
        this.mine.push(...evs);
        if (!this.watch) continue;
      }
      this.pending[p].push(...evs);
      const bot = this.bots[p];
      if (!bot || !look) continue;
      const events = this.pending[p];
      this.pending[p] = [];
      for (const a of bot.decide(g.observe(p), events)) g.act(p, a);
    }
    g.step();
    if (g.done) {
      this.mine.push(...g.drainEvents(this.seat));
      for (const p of this.remote) this.pending[p].push(...g.drainEvents(p));
    }
  }
}
