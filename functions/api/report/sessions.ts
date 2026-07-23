/**
 * functions/api/report/sessions.ts — GET /api/report/sessions?room=7346
 *
 * 依房號列出該房號的所有場次(最新在前),給 /report 入口頁的場次清單用。
 * 一場 = 一列;同房號打兩場就會回兩筆。
 *
 * 不需要密碼(Vincent 指示:靠房號查詢即可)。
 */
import type { Env } from '../../_shared';
import { json, cap } from '../../_shared';

interface Row {
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
  has_full: number;
  summary: string | null;
}

const COLS =
  `game_key, room, day, seq, started_at, ended_at, mode, mode_label,
   total_q, spq, players, groups_n, finished,
   CASE WHEN payload IS NULL THEN 0 ELSE 1 END AS has_full,
   summary`;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const room = cap(url.searchParams.get('room'), 40);
  // 不帶 room = 跨房號列出最新幾場,給 /report 首頁直接開就看得到用。
  // (Vincent:只有他自己在看,不想每次都先打房號。)
  const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;

  try {
    const rs = room
      ? await env.DB.prepare(
          `SELECT ${COLS} FROM games WHERE room = ? ORDER BY started_at DESC LIMIT 50`,
        ).bind(room).all<Row>()
      : await env.DB.prepare(
          `SELECT ${COLS} FROM games ORDER BY started_at DESC LIMIT ?`,
        ).bind(limit).all<Row>();

    const sessions = (rs.results || []).map((r) => ({
      ...r,
      finished: !!r.finished,
      has_full: !!r.has_full,
      // summary 是小 JSON,直接展開給前端用(壞掉就給 null,不讓整包查詢失敗)
      summary: (() => {
        if (!r.summary) return null;
        try { return JSON.parse(r.summary); } catch { return null; }
      })(),
    }));

    // room 為 null 代表「跨房號的最新幾場」,前端據此決定要不要在卡片上標房號
    return json({ ok: true, room: room || null, sessions });
  } catch (err) {
    return json({ ok: false, error: 'db_error', detail: String(err).slice(0, 200) }, 500);
  }
};
