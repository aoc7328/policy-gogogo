/**
 * functions/api/admin/sessions.ts — GET /api/admin/sessions
 *
 * 列出所有場次(room + day)與各自的彙總數字。資管端用來:
 *   1. 場次下拉選單
 *   2. 跨場次趨勢圖(比較每場問題數/比例的變化)
 *
 * 回傳依「最新場次在前」排序。
 */
import type { Env } from '../../_shared';
import { json, isAuthed } from '../../_shared';

interface SessionRow {
  room: string;
  day: string;
  first_ts: number;
  last_ts: number;
  participants: number;
  distinct_players: number;
  problem_players: number;
  problem_events: number;
  errors: number;
  disconnects: number;
  join_fails: number;
  freezes: number;
  reconnects: number;
  total_events: number;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!isAuthed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

  const sql = `
    SELECT
      room,
      day,
      MIN(ts) AS first_ts,
      MAX(ts) AS last_ts,
      COUNT(DISTINCT CASE WHEN type = 'join' THEN player_id END)                                   AS participants,
      COUNT(DISTINCT player_id)                                                                     AS distinct_players,
      COUNT(DISTINCT CASE WHEN type IN ('error','join_fail','disconnect','freeze') THEN player_id END) AS problem_players,
      SUM(CASE WHEN type IN ('error','join_fail','disconnect','freeze') THEN 1 ELSE 0 END)          AS problem_events,
      SUM(CASE WHEN type = 'error'      THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN type = 'disconnect' THEN 1 ELSE 0 END) AS disconnects,
      SUM(CASE WHEN type = 'join_fail'  THEN 1 ELSE 0 END) AS join_fails,
      SUM(CASE WHEN type = 'freeze'     THEN 1 ELSE 0 END) AS freezes,
      SUM(CASE WHEN type = 'reconnect'  THEN 1 ELSE 0 END) AS reconnects,
      COUNT(*) AS total_events
    FROM events
    GROUP BY room, day
    ORDER BY first_ts DESC
  `;

  try {
    const { results } = await env.DB.prepare(sql).all<SessionRow>();
    return json({ ok: true, sessions: results ?? [] });
  } catch {
    return json({ ok: false, error: 'db_error' }, 500);
  }
};
