/**
 * A solo match running in this tab: the authoritative Game, the bots in the other seats, and
 * real-time stepping with pause and speed.
 */
import { Game, makeGameConfig, Rng, type Action, type GameConfigOverrides, type GameEvent, type Observation } from '@sr/core';
import { Bot, PERSONALITIES, type BotPersonality } from '@sr/sim';

export interface SessionOptions {
  overrides?: GameConfigOverrides;
  /** The human's seat; the others are bots. */
  seat?: number;
  /** Personalities for bot seats (by seat index); defaults to a speculator then investors. */
  bots?: (BotPersonality | undefined)[];
  /** Watch only: a bot plays the human's seat too, and the human's actions are ignored. */
  watch?: boolean;
}

export class Session {
  readonly game: Game;
  readonly seat: number;
  readonly bots: (Bot | null)[];
  /** Watching the bots: every seat is a bot (the screen shows the human seat's view). */
  readonly watch: boolean;
  paused = false;
  speed = 1;
  /** Real seconds not yet turned into ticks. */
  private acc = 0;
  /** Longest real gap one frame may cover (so a backgrounded tab doesn't fast-forward wildly). */
  maxStepSec = 0.5;
  private pending: GameEvent[][];
  /** Events for the human since the last call to takeEvents. */
  private mine: GameEvent[] = [];
  private orderRng: Rng;

  constructor(opts: SessionOptions = {}) {
    const cfg = makeGameConfig({ seed: Math.floor(Math.random() * 2 ** 31), ...opts.overrides });
    this.game = new Game(cfg);
    this.seat = opts.seat ?? 0;
    this.watch = !!opts.watch;
    let botCount = 0;
    this.bots = Array.from({ length: cfg.players }, (_, p) => {
      if (p === this.seat && !this.watch) return null;
      if (p === this.seat) return new Bot(p, this.game.town, cfg, PERSONALITIES.balanced);
      // The same line-up as the bot games: a speculator, a controller, then balanced bots.
      const k = botCount++;
      const personality = opts.bots?.[p] ?? (k === 0 ? PERSONALITIES.speculator : k === 1 ? PERSONALITIES.controller : PERSONALITIES.balanced);
      return new Bot(p, this.game.town, cfg, personality);
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

  /** Events for the human since the last call. */
  takeEvents(): GameEvent[] {
    const out = this.mine;
    this.mine = [];
    return out;
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
    if (g.done) this.mine.push(...g.drainEvents(this.seat));
  }
}
