/**
 * functions/api/game.ts — POST /api/game
 *
 * 助理端在一場遊戲進行中/結束時,把「單場賽後報告」整包上傳到這裡。
 *
 * 設計要點:
 * - **一場 = 一列**。game_key 由助理端產生(room + 開賽時間戳),同一場
 *   重複上傳就是 UPSERT —— 所以助理可以每題結束就存一次(中途瀏覽器掛掉
 *   也留得下已完成的部分),最後 結束本場 再存一次完整版。
 * - **保留策略**:完整 payload 只留最近 5 場;更舊的把 payload 清成 NULL,
 *   但整列與 summary 永久保留(Vincent 要的長期趨勢分析靠這個)。
 * - 不設密碼(Vincent 明確指示):報告靠房號查詢即可。
 */
import type { Env } from '../_shared';
import { json, taipeiDay, cap } from '../_shared';

/** payload 上限(D1 單欄位不宜過大;一場 20 題約 30~60KB,取 1MB 很寬鬆)。 */
const MAX_PAYLOAD = 1_000_000;
/** 完整報告保留場次數 */
const KEEP_FULL = 5;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad_body' }, 400);

  const gameKey = cap(body.game_key, 80);
  const room = cap(body.room, 40);
  if (!gameKey) return json({ ok: false, error: 'no_game_key' }, 400);
  if (!room) return json({ ok: false, error: 'no_room' }, 400);

  const startedRaw = Number(body.started_at);
  const startedAt = Number.isFinite(startedRaw) ? Math.floor(startedRaw) : Date.now();
  const endedRaw = Number(body.ended_at);
  const endedAt = Number.isFinite(endedRaw) ? Math.floor(endedRaw) : null;
  const num = (v: unknown, dflt: number | null = null) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : dflt;
  };

  let payload: string | null = null;
  if (body.payload != null) {
    try {
      payload = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload);
    } catch {
      return json({ ok: false, error: 'bad_payload' }, 400);
    }
    if (payload.length > MAX_PAYLOAD) return json({ ok: false, error: 'payload_too_large' }, 413);
  }
  let summary: string | null = null;
  if (body.summary != null) {
    try {
      summary = typeof body.summary === 'string' ? body.summary : JSON.stringify(body.summary);
    } catch {
      summary = null;
    }
    if (summary && summary.length > 20_000) summary = summary.slice(0, 20_000);
  }

  const day = taipeiDay(startedAt);
  const now = Date.now();

  try {
    // seq =「這個房號這一天的第幾場」。同 game_key 重傳時沿用既有 seq,
    // 不重新計算(否則同一場的編號會隨著別場寫入而跳動)。
    const existing = await env.DB.prepare(
      `SELECT id, seq FROM games WHERE game_key = ?`,
    ).bind(gameKey).first<{ id: number; seq: number }>();

    let seq = existing?.seq ?? 1;
    if (!existing) {
      const cnt = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM games WHERE room = ? AND day = ?`,
      ).bind(room, day).first<{ n: number }>();
      seq = (cnt?.n ?? 0) + 1;
    }

    await env.DB.prepare(
      `INSERT INTO games
         (game_key, room, day, seq, started_at, ended_at, mode, mode_label,
          total_q, spq, players, groups_n, finished, summary, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_key) DO UPDATE SET
         ended_at   = excluded.ended_at,
         mode       = excluded.mode,
         mode_label = excluded.mode_label,
         total_q    = excluded.total_q,
         spq        = excluded.spq,
         players    = excluded.players,
         groups_n   = excluded.groups_n,
         finished   = excluded.finished,
         summary    = COALESCE(excluded.summary, games.summary),
         payload    = COALESCE(excluded.payload, games.payload),
         updated_at = excluded.updated_at`,
    )
      .bind(
        gameKey, room, day, seq, startedAt, endedAt,
        cap(body.mode, 20), cap(body.mode_label, 20),
        num(body.total_q), num(body.spq), num(body.players), num(body.groups_n),
        body.finished ? 1 : 0,
        summary, payload, now,
      )
      .run();

    // 保留策略:只有最近 KEEP_FULL 場留完整 payload,更舊的清成 NULL。
    // 整列與 summary 不刪 —— 長期趨勢要靠它。
    await env.DB.prepare(
      `UPDATE games SET payload = NULL
        WHERE payload IS NOT NULL
          AND id NOT IN (
            SELECT id FROM games WHERE payload IS NOT NULL
             ORDER BY started_at DESC LIMIT ?
          )`,
    ).bind(KEEP_FULL).run();
  } catch (err) {
    return json({ ok: false, error: 'db_error', detail: String(err).slice(0, 200) }, 500);
  }

  return json({ ok: true, game_key: gameKey });
};
