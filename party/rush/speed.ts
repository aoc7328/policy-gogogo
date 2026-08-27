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
import { noWinner } from './index';

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

  // 無效紀錄不消耗勝負鎖:先鎖再驗 team 的話,一筆壞資料會吃掉整輪
  // (之後 fallback 的 noWinner 也被 winnerLocked 擋住 → 永遠沒有結果事件)。
  const team = ctx.state.groups[winning.teamIdx];
  if (!team) return;
  session.winnerLocked = true;

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
  noWinner(ctx.state, ctx.broadcast, 'timeout');
}
