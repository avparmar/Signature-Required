import type { Action, Game, GameConfig, GameEvent, Observation } from '@sr/core';

/**
 * What the UI needs from a match, whether it runs in this tab (solo, watching, or hosting) or on
 * someone else's tab (joined over the network).
 */
export interface Match {
  /**
   * The game, for its town and config. In a joined game this is a local copy that never runs:
   * its town is kept in step with the host's (businesses opening and closing) and nothing else.
   */
  readonly game: Game;
  readonly cfg: GameConfig;
  /** This player's seat. */
  readonly seat: number;
  /** Watching the bots (this seat is a bot too). */
  readonly watch: boolean;
  /** Played with other people over the network. */
  readonly multiplayer: boolean;
  /** Can this player pause or change speed? (Not guests; speed is fixed at 1× online.) */
  readonly canControlTime: boolean;
  /** Display name per seat (empty for bots). */
  readonly names: string[];
  paused: boolean;
  speed: number;
  readonly done: boolean;
  /** Advance by real elapsed seconds. */
  update(realDt: number): void;
  /** Events for this player since the last call. */
  takeEvents(): GameEvent[];
  /** Latest view of the game for this player. */
  obs(): Observation;
  /** Game time to draw at: the latest view's time plus however far time has run on since (smooth motion). */
  readonly renderT: number;
  act(action: Action): void;
  /** Called when the UI is done with the match (closes network connections). */
  dispose(): void;
}
