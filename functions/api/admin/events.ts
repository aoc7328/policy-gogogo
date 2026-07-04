/**
 * functions/api/admin/events.ts — GET /api/admin/events
 *
 * 逐筆事件明細,給資管端往下深挖用。每筆都帶 player_id(= deviceId,
 * 與 Clarity identify 同一組),方便複製後去 Clarity 後台比對錄影。
 *
 * query:
 *   ?room=<房號>            指定場次
 *   ?from=<ms>&to=<ms>      指定時間區間
 *   ?type=<型別|all>        預設只列「非 join」(問題 + 重連);
 *                           指定型別只列該型別;type=all 連 join 一起列
 *   ?limit=<n>&offset=<n>   分頁(limit 預設 200,上限 1000)
 */
import type { Env } from '../../_shared';
import { json, isAuthed, numParam, ALL_TYPES } from '../../_shared';

const TYPE_SET = new Set<string>(ALL_TYPES);

interface EventRow {
  id: number;
  ts: number;
  client_ts: number | null;
  room: string;
  day: string;
  player_id: string;
  name: string | null;
  team: string | null;
  type: string;
  phase: string | null;
  os: string | null;
  ua: string | null;
  screen: string | null;
  detail: string | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!isAuthed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const clauses: string[] = [];
  const binds: (string | number)[] = [];

  const room = url.searchParams.get('room');
  if (room) {
    clauses.push('room = ?');
    binds.push(room);
  }

  const from = numParam(url.searchParams.get('from'));
  const to = numParam(url.searchParams.get('to'));
  if (from != null && to != null) {
    clauses.push('ts BETWEEN ? AND ?');
    binds.push(Math.floor(from), Math.floor(to));
  }

  const type = url.searchParams.get('type');
  if (type && type !== 'all') {
    if (TYPE_SET.has(type)) {
      clauses.push('type = ?');
      binds.push(type);
    } else {
      return json({ ok: false, error: 'bad_type' }, 400);
    }
  } else if (!type) {
    // 預設:排除 join(join 是分母/上線紀錄,不是問題)
    clauses.push("type != 'join'");
  }
  // type=all → 不加型別條件

  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `
    SELECT id, ts, client_ts, room, day, player_id, name, team, type, phase, os, ua, screen, detail
    FROM events
    ${where}
    ORDER BY ts DESC
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS n FROM events ${where}`;

  try {
    const rows = await env.DB.prepare(sql).bind(...binds, limit, offset).all<EventRow>();
    const total = await env.DB.prepare(countSql).bind(...binds).first<{ n: number }>();
    return json({
      ok: true,
      events: rows.results ?? [],
      total: total?.n ?? 0,
      limit,
      offset,
    });
  } catch {
    return json({ ok: false, error: 'db_error' }, 500);
  }
};

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  // 注意:Number(null)/Number('') === 0(不是 NaN),不能直接拿來判斷有無 →
  // 先判空回預設,否則沒帶 limit 會被算成 0 → clamp 成 1(只回 1 筆)。
  if (raw == null || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
