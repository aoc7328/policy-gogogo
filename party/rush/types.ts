/**
 * rush/types.ts — shared context passed to every rush-mode handler.
 *
 * Centralized so per-mode files don't import server.ts (which would
 * create a cycle).
 */

import type { RoomState } from '../state';
import type { ServerEvent } from '../protocol';

export interface RushCtx {
  state: RoomState;
  /** Broadcast to all connections in the room. */
  broadcast: (event: ServerEvent) => void;
  /**
   * Schedule a cancellable timer; the timer id is recorded in
   * state.rushSession.timers so abort/restart can clear them all.
   * No-ops if rushSession is null at call time.
   */
  schedule: (delayMs: number, fn: () => void) => void;
}

// Timing constants (single source of truth across all rush modes).
// Intervals are in ms relative to either startedAt (t0) or armedAt
// (= startedAt + ARM_COUNTDOWN_MS).

export const ARM_COUNTDOWN_MS = 3000;       // 3-2-1 countdown after start_rush
export const RANDOM_REVEAL_MS = 5000;       // random mode reveal window

export const SPEED_FALLBACK_MS = 8000;       // ms after armedAt
export const COUNT_DURATION_MS = 5000;
export const COUNT_TICK_MS = 100;
export const LIGHTNING_DISQUAL_MS = 3000;    // disqualification window after armedAt
export const LIGHTNING_FALLBACK_MS = 8000;   // total window after armedAt
export const ALLHANDS_DURATION_MS = 8000;
export const ALLHANDS_TICK_MS = 100;
export const ALLHANDS_CLUSTER_WINDOW_MS = 500;
export const ALLHANDS_PERSON_COOLDOWN_MS = 1000;
