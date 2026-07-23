/**
 * rush/count.ts — 狂點奪魁: 5-second tap race.
 *
 * Sequence:
 *   t0       start_rush emitted
 *   armedAt  = t0 + 3000
 *   [armedAt, armedAt + 5000)  — counting window
 *   every 100ms during window: rush_tick broadcast with team counts
 *   at armedAt + 5000: lockWinner picks the team with highest count;
 *     ties resolved by Phase 0 Q1 — earliest team to reach the max wins.
 */

import type { BuzzRecord } from '../state';
import type { RushCtx } from './types';
import { COUNT_DURATION_MS, COUNT_TICK_MS } from './types';

export function arm(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session) return;
  session.data.count = {
    teamCounts: new Map(),
    teamReachedAt: new Map(),
    perPerson: new Map(),
    clicks: [],
  };
  // Schedule the tick loop and the final lock.
  const armedDelay = session.armedAt - Date.now();
  ctx.schedule(Math.max(0, armedDelay), () => startTickLoop(ctx));
  ctx.schedule(Math.max(0, armedDelay + COUNT_DURATION_MS), () => lockWinner(ctx));
}

export function handleBuzz(ctx: RushCtx, record: BuzzRecord): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'count' || session.winnerLocked) return;
  // Outside the counting window?
  if (record.ts < session.armedAt) return;
  if (record.ts >= session.armedAt + COUNT_DURATION_MS) return;

  const data = session.data.count!;
  data.clicks.push(record);

  const next = (data.teamCounts.get(record.teamIdx) ?? 0) + 1;
  data.teamCounts.set(record.teamIdx, next);

  // Q1 tiebreak ledger: when did this team first reach `next`?
  let reach = data.teamReachedAt.get(record.teamIdx);
  if (!reach) {
    reach = new Map();
    data.teamReachedAt.set(record.teamIdx, reach);
  }
  if (!reach.has(next)) reach.set(next, record.ts);

  // Per-person MVP tracking.
  let pp = data.perPerson.get(record.teamIdx);
  if (!pp) {
    pp = new Map();
    data.perPerson.set(record.teamIdx, pp);
  }
  pp.set(record.name, (pp.get(record.name) ?? 0) + 1);
}

function startTickLoop(ctx: RushCtx): void {
  const tickOnce = () => {
    const session = ctx.state.rushSession;
    if (!session || session.mode !== 'count' || session.winnerLocked) return;
    emitTick(ctx);
    // Continue while window is open.
    const remaining = session.armedAt + COUNT_DURATION_MS - Date.now();
    if (remaining > 0) ctx.schedule(COUNT_TICK_MS, tickOnce);
  };
  emitTick(ctx);
  ctx.schedule(COUNT_TICK_MS, tickOnce);
}

function emitTick(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'count') return;
  const data = session.data.count!;
  // 帶上人數與人均 —— 勝負是照人均判的,即時長條圖也要照人均排
  const teamCounts = ctx.state.groups.map((g) => {
    const count = data.teamCounts.get(g.idx) ?? 0;
    const size = teamSizeOf(ctx, g.idx);
    return { idx: g.idx, name: g.name, count, size, avg: count / size };
  });
  const remainingMs = Math.max(0, session.armedAt + COUNT_DURATION_MS - Date.now());
  ctx.broadcast({
    type: 'rush_tick',
    payload: { mode: 'count', teamCounts, remainingMs },
  });
}

/** 該組人數(用於人均判定)。空組視為 1,避免除以 0。 */
function teamSizeOf(ctx: RushCtx, idx: number): number {
  const g = ctx.state.groups[idx];
  return Math.max(1, g?.members.length ?? 1);
}

function lockWinner(ctx: RushCtx): void {
  const session = ctx.state.rushSession;
  if (!session || session.mode !== 'count' || session.winnerLocked) return;
  session.winnerLocked = true;
  const data = session.data.count!;

  // Find max count.
  let maxCount = -1;
  for (const c of data.teamCounts.values()) {
    if (c > maxCount) maxCount = c;
  }
  // Edge case: nobody pressed at all.
  if (maxCount <= 0) {
    const fallback =
      ctx.state.groups.find((g) => !ctx.state.excludedTeams.includes(g.idx)) ??
      ctx.state.groups[0];
    if (!fallback) return;
    ctx.broadcast({
      type: 'rush_winner',
      payload: {
        groupIdx: fallback.idx,
        groupName: fallback.name,
        rushMode: 'count',
        personName: '(無人按)',
        teamTotalClicks: 0,
        mvpClicks: 0,
      },
    });
    ctx.state.phase = 'won';
    return;
  }

  // 勝負改用「人均點擊」(30 人實戰回饋:各組人數不一樣,比總數對小組不公平)。
  //   A 組 5 人點 200 下 → 40.0;B 組 6 人點 240 下 → 40.0 → 同分
  // 同分時沿用原本的 Q1 規則:先達到自己最高次數的那組贏。
  const avgOf = (idx: number, count: number) => count / teamSizeOf(ctx, idx);
  let bestAvg = -1;
  for (const [idx, count] of data.teamCounts.entries()) {
    const avg = avgOf(idx, count);
    if (avg > bestAvg) bestAvg = avg;
  }
  const EPS = 1e-9;   // 浮點數比較容差(200/5 與 240/6 必須算平手)
  const tiedIdxs: number[] = [];
  for (const [idx, count] of data.teamCounts.entries()) {
    if (Math.abs(avgOf(idx, count) - bestAvg) < EPS) tiedIdxs.push(idx);
  }
  let winnerIdx = tiedIdxs[0]!;
  let earliestTs =
    data.teamReachedAt.get(winnerIdx)?.get(data.teamCounts.get(winnerIdx) ?? 0) ??
    Number.POSITIVE_INFINITY;
  for (let i = 1; i < tiedIdxs.length; i++) {
    const idx = tiedIdxs[i]!;
    const ts =
      data.teamReachedAt.get(idx)?.get(data.teamCounts.get(idx) ?? 0) ??
      Number.POSITIVE_INFINITY;
    if (ts < earliestTs) {
      earliestTs = ts;
      winnerIdx = idx;
    }
  }

  const team = ctx.state.groups[winnerIdx];
  if (!team) return;
  const winnerTotal = data.teamCounts.get(winnerIdx) ?? 0;
  const winnerSize = teamSizeOf(ctx, winnerIdx);

  // MVP = team member with most clicks.
  const pp = data.perPerson.get(winnerIdx) ?? new Map<string, number>();
  let mvpName = '(無)';
  let mvpClicks = 0;
  let runnerUp: { name: string; count: number } | undefined;
  for (const [name, count] of pp.entries()) {
    if (count > mvpClicks) {
      if (mvpName !== '(無)') runnerUp = { name: mvpName, count: mvpClicks };
      mvpName = name;
      mvpClicks = count;
    } else if (!runnerUp || count > runnerUp.count) {
      runnerUp = { name, count };
    }
  }

  ctx.broadcast({
    type: 'rush_winner',
    payload: {
      groupIdx: team.idx,
      groupName: team.name,
      rushMode: 'count',
      personName: mvpName,
      teamTotalClicks: winnerTotal,
      teamSize: winnerSize,
      avgClicks: winnerTotal / winnerSize,
      mvpClicks,
      runnerUp,
    },
  });
  ctx.state.phase = 'won';
}
