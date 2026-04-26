/**
 * rush/speed.ts — 電光石火: first valid press wins.
 *
 * Sequence:
 *   t0       start_rush emitted
 *   armedAt  = t0 + 3000  (countdown ends)
 *   any press ≥ armedAt locks the winner
 *   if no press by armedAt + 8000, fallback picks a random team that has
 *     at least one connected member.
 */

import type { BuzzRecord } from '../state';
import type { RushCtx } from './types';
import { SPEED_FALLBACK_MS } from './types';

export function arm(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session) return;
  session.data.speed = { clicks: [] };
  // Schedule fallback relative to armedAt, but compute delay from now.
  const delay = session.armedAt - Date.now() + SPEED_FALLBACK_MS;
  ctx.schedule(Math.max(0, delay), () => fallback(ctx));
}

export function handleBuzz(ctx: RushCtx, record: BuzzRecord): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'speed' || session.winnerLocked) return;
  // Pre-arm presses are silently ignored.
  if (record.ts < session.armedAt) return;
  const data = session.data.speed!;
  data.clicks.push(record);
  // First valid press wins.
  lockWinner(ctx, record);
}

function lockWinner(ctx: RushCtx, winning: BuzzRecord): void {
  const session = ctx.state.rushSession;
  if (!session || session.winnerLocked) return;
  session.winnerLocked = true;

  const team = ctx.state.groups[winning.teamIdx];
  if (!team) return;

  ctx.broadcast({
    type: 'rush_winner',
    payload: {
      groupIdx: winning.teamIdx,
      groupName: team.name,
      rushMode: 'speed',
      personName: winning.name,
      elapsedMs: winning.ts - session.armedAt,
    },
  });
  ctx.state.phase = 'won';
}

function fallback(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session || session.winnerLocked) return;
  // Pick a random team that has at least one current participant.
  const eligible = ctx.state.groups.filter((g) => g.members.length > 0);
  const pool = eligible.length > 0 ? eligible : ctx.state.groups;
  if (pool.length === 0) return;
  const team = pool[Math.floor(Math.random() * pool.length)]!;
  const personName = team.members[0] ?? '(無人)';
  session.winnerLocked = true;

  ctx.broadcast({
    type: 'rush_winner',
    payload: {
      groupIdx: team.idx,
      groupName: team.name,
      rushMode: 'speed',
      personName,
      elapsedMs: SPEED_FALLBACK_MS,
    },
  });
  ctx.state.phase = 'won';
}
