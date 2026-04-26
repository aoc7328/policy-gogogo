/**
 * rush/index.ts — orchestrator: starts a rush session, dispatches
 * buzz_press to the right mode, handles random-mode reveal.
 */

import type { BuzzRecord, RoomState } from '../state';
import type { ServerEvent, ActualRushMode, RushMode } from '../protocol';
import type { RushCtx } from './types';
import { ARM_COUNTDOWN_MS, RANDOM_REVEAL_MS } from './types';

import * as Speed from './speed';
import * as Count from './count';
import * as Lightning from './lightning';
import * as Allhands from './allhands';

const RUSH_MODES: ActualRushMode[] = ['speed', 'count', 'lightning', 'allhands'];

/**
 * Build a RushCtx that schedules timers into the active rushSession,
 * so abort() can clear them all.
 */
export function makeCtx(
  state: RoomState,
  broadcast: (event: ServerEvent) => void
): RushCtx {
  return {
    state,
    broadcast,
    schedule: (delayMs, fn) => {
      if (!state.rushSession) return;
      const id = setTimeout(() => {
        try {
          fn();
        } catch (err) {
          console.error('rush timer error:', err);
        }
      }, delayMs);
      state.rushSession.timers.push(id);
    },
  };
}

/**
 * Cancel all pending timers and clear rushSession.
 */
export function abort(state: RoomState): void {
  if (!state.rushSession) return;
  for (const t of state.rushSession.timers) clearTimeout(t);
  state.rushSession = null;
}

/**
 * Entry point for `start_rush` command. Resolves random → actual mode,
 * emits start_rush (and rush_reveal first if random), arms the chosen
 * mode handler.
 */
export function startRush(
  state: RoomState,
  broadcast: (event: ServerEvent) => void,
  options: { rerush?: boolean }
): void {
  // Abort any existing session first.
  abort(state);

  const requested: RushMode = state.rushMode;
  let actual: ActualRushMode;
  let useRandomReveal = false;

  if (requested === 'random') {
    actual = RUSH_MODES[Math.floor(Math.random() * RUSH_MODES.length)]!;
    useRandomReveal = true;
  } else {
    actual = requested;
  }
  state.rushModeActual = actual;
  state.phase = 'rushing';

  if (useRandomReveal) {
    // 5s reveal first, then start_rush + arm.
    broadcast({
      type: 'rush_reveal',
      payload: {
        rushMode: actual,
        revealMs: RANDOM_REVEAL_MS,
        rerush: options.rerush ?? false,
      },
    });
    // Start a placeholder session so timers attach correctly.
    const startedAt = Date.now() + RANDOM_REVEAL_MS;
    state.rushSession = {
      mode: actual,
      armedAt: startedAt + ARM_COUNTDOWN_MS,
      startedAt,
      rerush: options.rerush ?? false,
      winnerLocked: false,
      data: {},
      timers: [],
    };
    const ctx = makeCtx(state, broadcast);
    ctx.schedule(RANDOM_REVEAL_MS, () => {
      // Emit the actual start_rush at the end of reveal, then arm.
      broadcast({
        type: 'start_rush',
        payload: { rushMode: actual, rerush: options.rerush },
      });
      armMode(state, broadcast, actual);
    });
    return;
  }

  // Non-random: emit start_rush immediately, set up session, arm.
  broadcast({
    type: 'start_rush',
    payload: { rushMode: actual, rerush: options.rerush },
  });
  const startedAt = Date.now();
  state.rushSession = {
    mode: actual,
    armedAt: startedAt + ARM_COUNTDOWN_MS,
    startedAt,
    rerush: options.rerush ?? false,
    winnerLocked: false,
    data: {},
    timers: [],
  };
  armMode(state, broadcast, actual);
}

function armMode(
  state: RoomState,
  broadcast: (event: ServerEvent) => void,
  mode: ActualRushMode
): void {
  const ctx = makeCtx(state, broadcast);
  switch (mode) {
    case 'speed':
      Speed.arm(ctx);
      break;
    case 'count':
      Count.arm(ctx);
      break;
    case 'lightning':
      Lightning.arm(ctx);
      break;
    case 'allhands':
      Allhands.arm(ctx);
      break;
  }
}

/**
 * Route a buzz_press to the active rush mode's handler.
 * No-op if no rush session is active.
 */
export function handleBuzz(
  state: RoomState,
  broadcast: (event: ServerEvent) => void,
  record: BuzzRecord
): void {
  const session = state.rushSession;
  if (!session || session.winnerLocked) return;
  const ctx = makeCtx(state, broadcast);
  switch (session.mode) {
    case 'speed':
      Speed.handleBuzz(ctx, record);
      break;
    case 'count':
      Count.handleBuzz(ctx, record);
      break;
    case 'lightning':
      Lightning.handleBuzz(ctx, record);
      break;
    case 'allhands':
      Allhands.handleBuzz(ctx, record);
      break;
  }
}
