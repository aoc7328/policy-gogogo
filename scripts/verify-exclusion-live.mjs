#!/usr/bin/env node
/**
 * verify-exclusion-live.mjs — 抽題防重複的端到端回歸(2026-08-27)。
 *
 *   1. 第一場把 F1(自由模式 · 簡單 · 選擇題)整池抽乾 → roomAskedCount 累積。
 *   2. 重新開始後,excludeIds 指定排除「全部只留一題」→ 抽出的必須就是那一題。
 *   3. excludePrior:true → F1 整池被本房累積排除 → 抽題必須回 no_question。
 *   4. clear_prior_asked → 累積歸零 → 再開一場 F1 又抽得到。
 *   5. game_start 廣播帶 startedAt 與 excludedIds。
 *
 * Pre-req: dev server on localhost:1999(或 argv[2]/PGG_HOST 覆寫)。
 */

const HOST = process.argv[2] ?? process.env.PGG_HOST ?? 'localhost:1999';
const WS = /localhost|127\.0\.0\.1/.test(HOST) ? 'ws' : 'wss';
const ROOM = `verify-excl-${Date.now()}`;
const ARM_COUNTDOWN_MS = 3800;

const fails = [];
const log = (...a) => console.log(...a);
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ✓ ${label}`); }
  else { fails.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

function conn(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams(query)}`);
    const frames = [];
    ws.addEventListener('message', (e) => { try { frames.push(JSON.parse(e.data)); } catch {} });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      ws, frames,
      send: (m) => ws.send(JSON.stringify(m)),
      cursor: () => frames.length,
      since: (n, type) => frames.slice(n).find((f) => f.type === type),
    }));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);
async function until(client, cursor, type, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = client.since(cursor, type);
    if (hit) return hit;
    await wait(120);
  }
  return null;
}
async function snapshotProbe() {
  const probe = await conn({ role: 'presenter' });
  await wait(500);
  const snap = lastOf(probe.frames, '__room_state__')?.payload;
  try { probe.ws.close(); } catch {}
  return snap;
}

log(`\n═══ 抽題防重複端到端 · host=${HOST} · room=${ROOM} ═══`);

const ass = await conn({ role: 'assistant' });
await wait(400);
const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode,中止'); process.exit(1); }
const pre = await conn({ role: 'presenter' });
const p1 = await conn({ role: 'participant', deviceId: 'ex-p1' });
await wait(250);
p1.send({ type: 'player_join', payload: { name: '甲君' } });
await wait(500);

const CFG = {
  mode: 'custom', customTiers: ['easy'], customTypes: ['multiple_choice'],
  totalQ: 10, spq: 5,
  groups: [{ name: '第一組' }, { name: '第二組' }],
  rushMode: 'speed', wordGameCap: 0, groupingMode: 'random',
};

async function startGame(extra, label) {
  const c = pre.cursor();
  ass.send({ type: 'game_start', controlCode: cc, payload: { ...CFG, ...extra } });
  const evt = await until(pre, c, 'game_start');
  if (!evt) { fails.push(`${label}: game_start 沒生效`); return null; }
  return evt.payload;
}
async function restart() {
  const c = pre.cursor();
  ass.send({ type: 'game_restart', controlCode: cc });
  await until(pre, c, 'game_restart');
  await wait(200);
}
async function rushWin(label) {
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc });
  if (!await until(pre, c, 'start_rush')) { fails.push(`${label}: start_rush 沒生效`); return false; }
  await wait(ARM_COUNTDOWN_MS + 500);
  p1.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  if (!await until(pre, c, 'rush_winner', 9000)) { fails.push(`${label}: 沒有 rush_winner`); return false; }
  const c2 = pre.cursor();
  ass.send({ type: 'enter_category', controlCode: cc });
  if (!await until(pre, c2, 'enter_category')) { fails.push(`${label}: enter_category 沒生效`); return false; }
  return true;
}
/** 抽 F1;回 {id} 或 {error}。 */
async function confirmF1(label) {
  const cQ = pre.cursor();
  const cE = ass.cursor();
  ass.send({ type: 'category_confirm', controlCode: cc, payload: { fid: 'F1' } });
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const q = pre.since(cQ, 'question_pick');
    if (q) return { id: q.payload.id };
    const err = ass.since(cE, '__error__');
    if (err && err.payload?.code === 'no_question') return { error: 'no_question' };
    await wait(120);
  }
  fails.push(`${label}: 抽題沒回應`);
  return { error: 'timeout' };
}

// ── 1. 第一場:把 F1 的簡單選擇題整池抽乾(redraw 連環抽) ──────
log('\n【1 · 第一場抽乾 F1,累積本房實抽】');
await startGame({}, 'G1');
const drawn = [];
{
  const ok = await rushWin('G1');
  if (ok) {
    const first = await confirmF1('G1');
    check('第一題抽出', !!first.id, JSON.stringify(first));
    if (first.id) drawn.push(first.id);
    // redraw 直到抽完(每次 redraw 換一題、舊題算已用)
    for (let i = 0; i < 40 && drawn.length; i++) {
      const cQ = pre.cursor();
      const cE = ass.cursor();
      ass.send({ type: 'redraw_question', controlCode: cc });
      let done = false;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const q = pre.since(cQ, 'question_pick');
        if (q) { drawn.push(q.payload.id); done = true; break; }
        const err = ass.since(cE, '__error__');
        if (err && err.payload?.code === 'no_question') { done = 'empty'; break; }
        await wait(100);
      }
      if (done === 'empty') break;
      if (!done) { fails.push('G1: redraw 沒回應'); break; }
    }
    check(`F1 簡單選擇題整池抽乾(共 ${drawn.length} 題,無重複)`,
      drawn.length >= 2 && new Set(drawn).size === drawn.length, drawn.join(','));
  }
  const snap = await snapshotProbe();
  check('本房實抽累積 = 抽過的題數', snap?.roomAskedCount === drawn.length,
    `roomAskedCount=${snap?.roomAskedCount} drawn=${drawn.length}`);
  check('快照帶 gameStartedAt', typeof snap?.gameStartedAt === 'number');
}

// ── 2. excludeIds:排除到只剩一題 → 抽出的必須是那一題 ─────────
log('\n【2 · excludeIds 指定排除 → 只剩的那一題被抽出】');
await restart();
{
  const keep = drawn[drawn.length - 1];
  const excludeIds = drawn.filter((id) => id !== keep);
  const payload = await startGame({ excludeIds, excludePrior: false }, 'G2');
  check('game_start 廣播帶 startedAt', typeof payload?.startedAt === 'number');
  check('game_start 廣播帶 excludedIds(= 勾選清單)',
    Array.isArray(payload?.excludedIds) && payload.excludedIds.length === excludeIds.length,
    `excludedIds=${payload?.excludedIds?.length}`);
  const ok = await rushWin('G2');
  if (ok) {
    const q = await confirmF1('G2');
    check('抽出的正是唯一沒被排除的那一題', q.id === keep, `expect=${keep} got=${q.id || q.error}`);
  }
}

// ── 3. excludePrior:本房累積整池排除 → F1 無題可抽 ────────────
log('\n【3 · excludePrior:上一場抽過的全部排除 → F1 抽不出題】');
await restart();
{
  const payload = await startGame({ excludePrior: true }, 'G3');
  check('廣播的 excludedIds 涵蓋本房累積', Array.isArray(payload?.excludedIds) && payload.excludedIds.length >= drawn.length,
    `${payload?.excludedIds?.length} >= ${drawn.length}`);
  const ok = await rushWin('G3');
  if (ok) {
    const q = await confirmF1('G3');
    check('F1 回報「無題可抽」(排除生效)', q.error === 'no_question', JSON.stringify(q));
  }
}

// ── 4. 清空累計 → 排除解除 ───────────────────────────────────
log('\n【4 · clear_prior_asked → 累積歸零、F1 復活】');
{
  ass.send({ type: 'clear_prior_asked', controlCode: cc });
  await wait(600);
  const snap = await snapshotProbe();
  check('累積歸零', snap?.roomAskedCount === 0, `roomAskedCount=${snap?.roomAskedCount}`);
  await restart();
  const payload = await startGame({ excludePrior: true }, 'G4');
  check('清空後 excludedIds 為空', Array.isArray(payload?.excludedIds) && payload.excludedIds.length === 0,
    `${payload?.excludedIds?.length}`);
  const ok = await rushWin('G4');
  if (ok) {
    const q = await confirmF1('G4');
    check('F1 又抽得到題', !!q.id && drawn.includes(q.id), q.id || q.error);
  }
}

for (const cnn of [ass, pre, p1]) { try { cnn.ws.close(); } catch {} }
if (fails.length) {
  console.error(`\n❌ ${fails.length} 項失敗:`);
  fails.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\n✅ 抽題防重複端到端驗證全數通過');
process.exit(0);
