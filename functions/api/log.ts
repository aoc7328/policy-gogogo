/**
 * functions/api/log.ts — POST /api/log
 *
 * 參賽者端(gamer)發生的事件都 POST 到這裡,寫進 D1 events 表長期保存。
 * 走一般 HTTP(fetch keepalive / sendBeacon),跟遊戲的 WebSocket 分開 ——
 * 這樣「連線失敗 / 斷線 / 錯誤」這種 WS 本身可能已經掛掉的時刻也記得到。
 *
 * 只認 POST;GET 之類會被 Pages 自動回 405。
 */
import type { Env } from '../_shared';
import { json, taipeiDay, cap, ALL_TYPES } from '../_shared';

const TYPE_SET = new Set<string>(ALL_TYPES);

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: 'bad_body' }, 400);
  }

  const type = cap(body.type, 20);
  const room = cap(body.room, 40);
  const playerId = cap(body.player_id, 80);

  if (!type || !TYPE_SET.has(type)) return json({ ok: false, error: 'bad_type' }, 400);
  if (!room) return json({ ok: false, error: 'no_room' }, 400);
  if (!playerId) return json({ ok: false, error: 'no_player' }, 400);

  const ts = Date.now();
  const clientTsRaw = Number(body.client_ts);
  const clientTs = Number.isFinite(clientTsRaw) ? Math.floor(clientTsRaw) : ts;
  const day = taipeiDay(ts);

  // detail:接受物件或字串,一律存成 JSON 字串,長度上限保護 D1。
  let detail: string | null = null;
  if (body.detail != null) {
    try {
      detail =
        typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      detail = null;
    }
    if (detail && detail.length > 4000) detail = detail.slice(0, 4000);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO events
         (ts, client_ts, room, day, player_id, name, team, type, phase, os, ua, screen, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        ts,
        clientTs,
        room,
        day,
        playerId,
        cap(body.name, 40),
        cap(body.team, 40),
        type,
        cap(body.phase, 30),
        cap(body.os, 16),
        cap(body.ua, 300),
        cap(body.screen, 32),
        detail,
      )
      .run();
  } catch {
    return json({ ok: false, error: 'db_error' }, 500);
  }

  return json({ ok: true });
};
