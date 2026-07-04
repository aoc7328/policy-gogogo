/**
 * functions/api/admin/summary.ts — GET /api/admin/summary
 *
 * 單一場次或時間區間的彙總,給資管端主畫面用。
 *   ?room=<房號>              → 指定一場活動
 *   ?from=<ms>&to=<ms>        → 指定時間區間(epoch ms)
 *   (都沒帶 → 全部資料)
 *
 * 回傳:總參與人數、問題人數/比例、各問題型別次數、以及「問題事件的
 * 時間分佈」(分桶,用來看問題是集中在開賽前幾分鐘還是全程零星)。
 */
import type { Env } from '../../_shared';
import { json, isAuthed } from '../../_shared';

interface CountRow {
  first_ts: number | null;
  last_ts: number | null;
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

interface TimelineRow {
  ts: number;
  type: string;
}

/** 依 query 決定 WHERE 子句 + 綁定參數。 */
function buildFilter(url: URL): { where: string; binds: (string | number)[]; meta: Record<string, unknown> } {
  const room = url.searchParams.get('room');
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));

  if (room) {
    return { where: 'WHERE room = ?', binds: [room], meta: { mode: 'room', room } };
  }
  if (Number.isFinite(from) && Number.isFinite(to)) {
    return {
      where: 'WHERE ts BETWEEN ? AND ?',
      binds: [Math.floor(from), Math.floor(to)],
      meta: { mode: 'range', from: Math.floor(from), to: Math.floor(to) },
    };
  }
  return { where: '', binds: [], meta: { mode: 'all' } };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!isAuthed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const { where, binds, meta } = buildFilter(url);

  const countSql = `
    SELECT
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
    FROM events ${where}
  `;

  const timelineSql = `
    SELECT ts, type FROM events
    ${where ? where + ' AND' : 'WHERE'} type IN ('error','join_fail','disconnect','freeze')
    ORDER BY ts ASC
  `;

  try {
    const count = await env.DB.prepare(countSql).bind(...binds).first<CountRow>();
    const timeline = await env.DB.prepare(timelineSql).bind(...binds).all<TimelineRow>();

    const summary = normalizeCount(count);
    const buckets = bucketize(timeline.results ?? [], summary.first_ts, summary.last_ts);

    return json({ ok: true, meta, summary, buckets });
  } catch {
    return json({ ok: false, error: 'db_error' }, 500);
  }
};

interface Summary {
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

function normalizeCount(row: CountRow | null): Summary {
  return {
    first_ts: row?.first_ts ?? 0,
    last_ts: row?.last_ts ?? 0,
    participants: row?.participants ?? 0,
    distinct_players: row?.distinct_players ?? 0,
    problem_players: row?.problem_players ?? 0,
    problem_events: row?.problem_events ?? 0,
    errors: row?.errors ?? 0,
    disconnects: row?.disconnects ?? 0,
    join_fails: row?.join_fails ?? 0,
    freezes: row?.freezes ?? 0,
    reconnects: row?.reconnects ?? 0,
    total_events: row?.total_events ?? 0,
  };
}

interface Bucket {
  start: number;
  error: number;
  disconnect: number;
  join_fail: number;
  freeze: number;
  total: number;
}

/** 把問題事件切成時間桶。桶寬自適應:目標約 24 桶,最小 1 分鐘,最多 200 桶。 */
function bucketize(rows: TimelineRow[], firstTs: number, lastTs: number): {
  bucketMs: number;
  list: Bucket[];
} {
  const MIN = 60_000;
  if (!rows.length || !firstTs) return { bucketMs: MIN, list: [] };
  const span = Math.max(0, lastTs - firstTs);
  let bucketMs = Math.max(MIN, Math.ceil(span / 24 / MIN) * MIN);
  let n = Math.floor(span / bucketMs) + 1;
  if (n > 200) {
    bucketMs = Math.ceil(span / 200 / MIN) * MIN;
    n = Math.floor(span / bucketMs) + 1;
  }

  const list: Bucket[] = [];
  for (let i = 0; i < n; i++) {
    list.push({ start: firstTs + i * bucketMs, error: 0, disconnect: 0, join_fail: 0, freeze: 0, total: 0 });
  }
  for (const r of rows) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((r.ts - firstTs) / bucketMs)));
    const b = list[idx];
    if (!b) continue;
    if (r.type === 'error') b.error++;
    else if (r.type === 'disconnect') b.disconnect++;
    else if (r.type === 'join_fail') b.join_fail++;
    else if (r.type === 'freeze') b.freeze++;
    b.total++;
  }
  return { bucketMs, list };
}
