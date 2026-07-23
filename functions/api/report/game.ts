/**
 * functions/api/report/game.ts — GET /api/report/game?key=<game_key>
 *
 * 取單場的完整賽後報告。回傳:
 *   - meta:場次基本資料(房號、第幾場、模式、題數、起訖…)
 *   - report:助理端上傳的完整內容(分組名單、逐輪搶答、逐題明細、計分)
 *   - conn:該場時間窗內的連線品質(從既有的 events 表算,不重複儲存)
 *
 * payload 已被保留策略清掉(超過最近 5 場)時,report = null,
 * 但 summary 仍在 —— 前端據此顯示「完整內容已輪替刪除,僅存摘要」。
 */
import type { Env } from '../../_shared';
import { json, cap } from '../../_shared';

interface GameRow {
  game_key: string;
  room: string;
  day: string;
  seq: number;
  started_at: number;
  ended_at: number | null;
  mode: string | null;
  mode_label: string | null;
  total_q: number | null;
  spq: number | null;
  players: number | null;
  groups_n: number | null;
  finished: number;
  summary: string | null;
  payload: string | null;
}

interface ConnRow {
  name: string | null;
  team: string | null;
  os: string | null;
  disconnects: number;
  reconnects: number;
  freezes: number;
  errors: number;
  join_fails: number;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const key = cap(url.searchParams.get('key'), 80);
  if (!key) return json({ ok: false, error: 'no_key' }, 400);

  try {
    const g = await env.DB.prepare(
      `SELECT game_key, room, day, seq, started_at, ended_at, mode, mode_label,
              total_q, spq, players, groups_n, finished, summary, payload
         FROM games WHERE game_key = ?`,
    ).bind(key).first<GameRow>();

    if (!g) return json({ ok: false, error: 'not_found' }, 404);

    const parse = (s: string | null) => {
      if (!s) return null;
      try { return JSON.parse(s); } catch { return null; }
    };

    // 連線品質:該場時間窗內、同房號的事件彙總。未結束的場次用「現在」當上界。
    const from = g.started_at;
    const to = g.ended_at ?? Date.now();
    const conn = await env.DB.prepare(
      `SELECT name, team, os,
              SUM(CASE WHEN type='disconnect' THEN 1 ELSE 0 END) AS disconnects,
              SUM(CASE WHEN type='reconnect'  THEN 1 ELSE 0 END) AS reconnects,
              SUM(CASE WHEN type='freeze'     THEN 1 ELSE 0 END) AS freezes,
              SUM(CASE WHEN type='error'      THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN type='join_fail'  THEN 1 ELSE 0 END) AS join_fails
         FROM events
        WHERE room = ? AND ts BETWEEN ? AND ?
        GROUP BY player_id
       HAVING disconnects + freezes + errors + join_fails > 0
        ORDER BY disconnects DESC, freezes DESC
        LIMIT 40`,
    ).bind(g.room, from, to).all<ConnRow>();

    const rows = conn.results || [];
    const connSummary = rows.reduce(
      (a, r) => ({
        disconnects: a.disconnects + (r.disconnects || 0),
        freezes: a.freezes + (r.freezes || 0),
        errors: a.errors + (r.errors || 0),
        join_fails: a.join_fails + (r.join_fails || 0),
        affected: a.affected + 1,
      }),
      { disconnects: 0, freezes: 0, errors: 0, join_fails: 0, affected: 0 },
    );

    return json({
      ok: true,
      meta: {
        game_key: g.game_key, room: g.room, day: g.day, seq: g.seq,
        started_at: g.started_at, ended_at: g.ended_at,
        mode: g.mode, mode_label: g.mode_label,
        total_q: g.total_q, spq: g.spq,
        players: g.players, groups_n: g.groups_n,
        finished: !!g.finished,
      },
      summary: parse(g.summary),
      report: parse(g.payload),
      conn: { summary: connSummary, players: rows },
    });
  } catch (err) {
    return json({ ok: false, error: 'db_error', detail: String(err).slice(0, 200) }, 500);
  }
};
