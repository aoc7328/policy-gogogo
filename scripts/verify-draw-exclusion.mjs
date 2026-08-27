#!/usr/bin/env node
/** Regression: 抽題防重複 + 賽後報告韌性(2026-08-27)的靜態契約。 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const protocol = read('party/protocol.ts');
const state = read('party/state.ts');
const server = read('party/server.ts');
const gameApi = read('functions/api/game.ts');
const assistant = read('public/assistant.html');
const presenter = read('public/presenter.html');
const report = read('public/report.html');

const failures = [];
const check = (label, ok) => { if (ok) console.log(`✓ ${label}`); else failures.push(label); };

// ── 抽題防重複 ────────────────────────────────────────────────
check('GameConfig 帶 excludeIds / excludePrior',
  protocol.includes('excludeIds?: string[]') && protocol.includes('excludePrior?: boolean'));
check('game_start 廣播帶 server 補欄位 startedAt / excludedIds',
  protocol.includes('GameConfig & { startedAt?: number; excludedIds?: string[] }') &&
  server.includes('excludedIds: [...this.state.usedIds]'));
check('開賽把排除聯集種進 usedIds(白名單驗證 + 上限)',
  state.includes('sanitizeExcludeIds') &&
  state.includes('for (const id of state.roomAskedIds) state.usedIds.add(id)') &&
  state.includes('EXCLUDE_IDS_MAX'));
check('本房實抽累積:抽題與重抽都寫入 roomAskedIds',
  (server.match(/roomAskedIds\.add\(result\.question\.id\)/g) || []).length === 2);
check('roomAskedIds 跨「重新開始」保留並持久化',
  state.includes('roomAskedIds: state.roomAskedIds') &&
  state.includes('roomAskedIds: [...state.roomAskedIds]') &&
  state.includes('new Set(saved.roomAskedIds ?? [])'));
check('快照曝露 roomAskedCount / gameStartedAt',
  state.includes('roomAskedCount: state.roomAskedIds.size') &&
  state.includes('gameStartedAt: state.gameStartedAt'));
check('clear_prior_asked 指令存在且清空後重推快照',
  protocol.includes("'clear_prior_asked'") && server.includes('onClearPriorAsked') &&
  server.includes('this.state.roomAskedIds.clear()'));
check('助理端設定頁有排除區塊與場次勾選',
  assistant.includes('id="excl-toggle"') && assistant.includes('id="excl-sessions"') &&
  assistant.includes('/api/report/sessions') && assistant.includes('exclSelectedIds'));
check('助理端開賽送出 excludeIds + excludePrior',
  assistant.includes('excludeIds: exclIds') && assistant.includes('excludePrior: exclOn'));
check('助理端/投影端以廣播的 excludedIds 種鏡射(九宮格剩餘數正確)',
  assistant.includes('new Set(Array.isArray(cfg.excludedIds) ? cfg.excludedIds : [])') &&
  presenter.includes('new Set(Array.isArray(payload.excludedIds) ? payload.excludedIds : [])'));

// ── 賽後報告韌性 ──────────────────────────────────────────────
check('REC 每次存檔都寫 localStorage 檢查點',
  assistant.includes('localStorage.setItem(REC_LS_KEY()'));
check('重整後憑 gameStartedAt 接回本場 REC',
  assistant.includes('function recTryRestore') &&
  assistant.includes('Math.abs(stored.startedAt - ts) > 15000'));
check('REC key 改用 server 權威時間戳(game_start 廣播 rekey)',
  assistant.includes('REC._pendingKey') && assistant.includes('REC.key = `${PGG_ROOM_CODE}-${ts}`'));
check('結算補建:REC 中斷時由 export payload 補降級報告',
  assistant.includes('function recFallbackFromExport') &&
  assistant.includes('degraded: true'));
check('API 防護:降級報告不得覆蓋既有完整報告',
  gameApi.includes("body.degraded === true") && gameApi.includes('hasContent'));
check('收檔時清 localStorage 檢查點 + 擋自己場次的補建',
  assistant.includes('localStorage.removeItem(REC_LS_KEY())') &&
  assistant.includes('REC.lastClosedKey'));

// ── 報告呈現 ─────────────────────────────────────────────────
check('賽後報告逐題顯示題庫編號(改題/刪題可直接報編號)',
  report.includes('題庫編號') && report.includes('esc(q.id)'));
check('降級報告在頁面上有明確告示',
  report.includes('rep.degraded') && report.includes('結算時自動補建'));

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((f) => console.error(`- ${f}`));
  process.exit(1);
}
console.log('\n18 passed, 0 failed');
