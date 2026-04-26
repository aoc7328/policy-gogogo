/**
 * rush/allhands.ts — 全組到位.
 *
 * Sequence:
 *   t0       start_rush emitted
 *   armedAt  = t0 + 3000
 *   [armedAt, armedAt + 8000)  — measurement window. Each valid press
 *     contributes to a per-team sliding-window cluster: the count of
 *     unique members who pressed within the trailing 500ms.
 *   100ms tick: allhands_progress emitted with currentCluster (now)
 *     and bestCluster (max-so-far) for each team.
 *   armedAt + 8000: lockWinner picks the team with the largest
 *     bestCluster.count; tiebreak by earliest endTs.
 *
 * Phase 0 Q3: timestamps used for clustering are server-receive
 *   timestamps (record.ts == Date.now() at onMessage), not client `ts`.
 *
 * Phase 0 Q5: 1-second per-person cooldown is server-authoritative —
 *   presses inside cooldown are silently dropped.
 */

import type { BuzzRecord } from '../state';
import type { RushCtx } from './types';
import {
  ALLHANDS_DURATION_MS,
  ALLHANDS_TICK_MS,
  ALLHANDS_CLUSTER_WINDOW_MS,
  ALLHANDS_PERSON_COOLDOWN_MS,
} from './types';

export function arm(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session) return;
  session.data.allhands = {
    teamClicks: new Map(),
    bestCluster: new Map(),
    lastPressedAt: new Map(),
  };
  const armedDelay = session.armedAt - Date.now();
  ctx.schedule(Math.max(0, armedDelay), () => startTickLoop(ctx));
  ctx.schedule(Math.max(0, armedDelay + ALLHANDS_DURATION_MS), () => lockWinner(ctx));
}

export function handleBuzz(ctx: RushCtx, record: BuzzRecord): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'allhands' || session.winnerLocked) return;
  if (record.ts < session.armedAt) return;
  if (record.ts >= session.armedAt + ALLHANDS_DURATION_MS) return;

  const data = session.data.allhands!;

  // Per-person 1s cooldown — silent drop.
  let perPerson = data.lastPressedAt.get(record.teamIdx);
  if (!perPerson) {
    perPerson = new Map();
    data.lastPressedAt.set(record.teamIdx, perPerson);
  }
  const lastTs = perPerson.get(record.name) ?? 0;
  if (record.ts - lastTs < ALLHANDS_PERSON_COOLDOWN_MS) return;
  perPerson.set(record.name, record.ts);

  // Record the click.
  let clicks = data.teamClicks.get(record.teamIdx);
  if (!clicks) {
    clicks = [];
    data.teamClicks.set(record.teamIdx, clicks);
  }
  clicks.push(record);

  // Recompute current cluster for this team and maybe update best.
  const cluster = currentCluster(clicks, record.ts);
  const best = data.bestCluster.get(record.teamIdx);
  if (!best || cluster.count > best.count) {
    data.bestCluster.set(record.teamIdx, cluster);
  } else if (cluster.count === best.count && cluster.endTs < best.endTs) {
    // Tiebreak: earliest end timestamp wins.
    data.bestCluster.set(record.teamIdx, cluster);
  }
}

/**
 * Compute the cluster ending at `endTs`: count of distinct names that
 * pressed within [endTs - WINDOW, endTs].
 */
function currentCluster(
  clicks: BuzzRecord[],
  endTs: number
): { count: number; endTs: number; members: string[] } {
  const start = endTs - ALLHANDS_CLUSTER_WINDOW_MS;
  const seen = new Set<string>();
  for (const c of clicks) {
    if (c.ts >= start && c.ts <= endTs) seen.add(c.name);
  }
  return { count: seen.size, endTs, members: [...seen] };
}

function startTickLoop(ctx: RushCtx): void {
  const tickOnce = () => {
    const session = ctx.state.rushSession;
    if (!session || session.mode !== 'allhands' || session.winnerLocked) return;
    emitProgress(ctx);
    const remaining = session.armedAt + ALLHANDS_DURATION_MS - Date.now();
    if (remaining > 0) ctx.schedule(ALLHANDS_TICK_MS, tickOnce);
  };
  emitProgress(ctx);
  ctx.schedule(ALLHANDS_TICK_MS, tickOnce);
}

function emitProgress(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'allhands') return;
  const data = session.data.allhands!;
  const now = Date.now();
  const teamProgress = ctx.state.groups.map((g) => {
    const clicks = data.teamClicks.get(g.idx) ?? [];
    const current = currentCluster(clicks, now);
    const best = data.bestCluster.get(g.idx);
    return {
      idx: g.idx,
      name: g.name,
      currentCluster: current.count,
      bestCluster: best?.count ?? 0,
      total: g.members.length,
    };
  });
  const remainingMs = Math.max(0, session.armedAt + ALLHANDS_DURATION_MS - now);
  ctx.broadcast({
    type: 'allhands_progress',
    payload: { teamProgress, remainingMs },
  });
}

function lockWinner(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'allhands' || session.winnerLocked) return;
  session.winnerLocked = true;
  const data = session.data.allhands!;

  let winnerIdx = -1;
  let bestCount = -1;
  let bestEndTs = Number.POSITIVE_INFINITY;
  for (const g of ctx.state.groups) {
    const b = data.bestCluster.get(g.idx);
    if (!b) continue;
    if (b.count > bestCount || (b.count === bestCount && b.endTs < bestEndTs)) {
      winnerIdx = g.idx;
      bestCount = b.count;
      bestEndTs = b.endTs;
    }
  }

  // Edge case: nobody pressed.
  if (winnerIdx < 0) {
    const fallback = ctx.state.groups[0];
    if (!fallback) return;
    ctx.broadcast({
      type: 'rush_winner',
      payload: {
        groupIdx: fallback.idx,
        groupName: fallback.name,
        rushMode: 'allhands',
        clusterCount: 0,
        totalCount: fallback.members.length,
        endAtSec: ALLHANDS_DURATION_MS / 1000,
      },
    });
    ctx.state.phase = 'won';
    return;
  }

  const team = ctx.state.groups[winnerIdx]!;
  ctx.broadcast({
    type: 'rush_winner',
    payload: {
      groupIdx: team.idx,
      groupName: team.name,
      rushMode: 'allhands',
      clusterCount: bestCount,
      totalCount: team.members.length,
      endAtSec: Number(((bestEndTs - session.armedAt) / 1000).toFixed(2)),
    },
  });
  ctx.state.phase = 'won';
}
