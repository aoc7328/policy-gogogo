/**
 * rush/lightning.ts — 閃電一按.
 *
 * Sequence:
 *   t0       start_rush emitted
 *   armedAt  = t0 + 3000
 *   [armedAt, armedAt + 3000)  — disqualification window: any press
 *     adds the player to disqualified set; lightning_disqualify
 *     broadcast immediately (Phase 0 Q2: server-authoritative).
 *   [armedAt + 3000, armedAt + 8000)  — valid window: first non-
 *     disqualified press wins immediately.
 *   armedAt + 8000  — fallback if no valid press.
 */

import type { BuzzRecord } from '../state';
import type { RushCtx } from './types';
import { LIGHTNING_DISQUAL_MS, LIGHTNING_FALLBACK_MS } from './types';
import { noWinner } from './index';

export function arm(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session) return;
  session.data.lightning = {
    disqualified: new Map(),
    validClicks: [],
  };
  const armedDelay = session.armedAt - Date.now();
  ctx.schedule(Math.max(0, armedDelay + LIGHTNING_FALLBACK_MS), () => fallback(ctx));
}

export function handleBuzz(ctx: RushCtx, record: BuzzRecord): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'lightning' || session.winnerLocked) return;
  // Pre-arm: ignore.
  if (record.ts < session.armedAt) return;
  const elapsed = record.ts - session.armedAt;
  const data = session.data.lightning!;

  // Already disqualified players cannot affect anything.
  const disqSet = data.disqualified.get(record.teamIdx);
  if (disqSet?.has(record.name)) return;

  if (elapsed < LIGHTNING_DISQUAL_MS) {
    // Disqualification window — record + broadcast.
    if (!data.disqualified.has(record.teamIdx)) {
      data.disqualified.set(record.teamIdx, new Set());
    }
    data.disqualified.get(record.teamIdx)!.add(record.name);
    const team = ctx.state.groups[record.teamIdx];
    ctx.broadcast({
      type: 'lightning_disqualify',
      payload: {
        name: record.name,
        team: team?.name ?? record.team,
        teamIdx: record.teamIdx,
        elapsedMs: elapsed,
      },
    });
    return;
  }

  // Valid window — first valid press wins.
  data.validClicks.push(record);
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
      rushMode: 'lightning',
      personName: winning.name,
      pressedAtSec: Number(((winning.ts - session.armedAt) / 1000).toFixed(2)),
    },
  });
  ctx.state.phase = 'won';
}

function fallback(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'lightning' || session.winnerLocked) return;
  noWinner(ctx.state, ctx.broadcast, 'all_disqualified');
}
