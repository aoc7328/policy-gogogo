/**
 * functions/_shared.ts — 資管端 Pages Functions 共用工具。
 *
 * 檔名以底線開頭 → Cloudflare Pages 路由器會略過(不當成 endpoint),
 * 但仍可被同目錄下的 route 檔 import。
 *
 * 這裡的東西都跟遊戲即時邏輯(PartyKit)無關,純粹是 /api/* 這條
 * 事件記錄 + 報表查詢管線在用的。
 */

/** Pages Functions 的環境綁定(對應 wrangler.toml)。 */
export interface Env {
  /** D1 事件資料庫(policy-gogogo-events)。 */
  DB: D1Database;
  /** 資管端報表密碼;空字串或未設 = 不啟用密碼閘門。 */
  ADMIN_KEY?: string;
}

/** 統一 JSON 回應(一律 no-store,報表資料不該被快取)。 */
export function json(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
    },
  });
}

/** epoch ms → Asia/Taipei 當地日期(YYYY-MM-DD)。en-CA locale 剛好輸出這格式。 */
export function taipeiDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** 字串截斷 + 去空白;非字串或空字串回 null(方便直接塞進 nullable 欄位)。 */
export function cap(v: unknown, n: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, n) : null;
}

/**
 * 把「可有可無的數字 query 參數」安全解析成 number | null。
 * ⚠ 不要用 `Number(raw)` 當有無判斷:Number(null) 與 Number('') 都是 0(不是
 * NaN),會讓「沒帶 from/to」被誤判成「from=0,to=0」→ WHERE ts BETWEEN 0 AND 0
 * → 什麼都撈不到(問題明細空白 bug 的元凶)。這裡先判空,再判是否有限數。
 */
export function numParam(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 資管端密碼驗證。密碼來自 env.ADMIN_KEY(wrangler.toml [vars])。
 * - 未設密碼 → 一律放行(user 說密碼保護可做可不做)。
 * - 有設 → 需帶對的 key,可用 header `x-admin-key` 或 query `?key=`。
 */
export function isAuthed(request: Request, env: Env): boolean {
  const required = (env.ADMIN_KEY || '').trim();
  if (!required) return true;
  const url = new URL(request.url);
  const provided =
    request.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  return provided === required;
}

/** 「有問題」的事件型別(用於 problem_players / 問題數統計)。 */
export const PROBLEM_TYPES = ['error', 'join_fail', 'disconnect', 'freeze'] as const;

/** 所有合法事件型別(log 端白名單 + events 端過濾用)。 */
export const ALL_TYPES = [
  'join',
  'error',
  'join_fail',
  'disconnect',
  'reconnect',
  'freeze',
] as const;
