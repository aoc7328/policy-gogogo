#!/usr/bin/env node
/**
 * verify-live-ops.mjs — 現場一定會用到、但流程測試沒涵蓋的操作。
 *
 *   A. 控制碼登入路由:投影碼 → 投影端;助理碼 → 助理端;亂打 → 錯誤
 *   B. 重新開始(game_restart):保留組別/成員/組長,清空分數與題號
 *   C. 中途重連:遊戲進行中新連線拿到的快照要含「當前題目 + 題號 + 分數」
 *      (2026-07-23 三十人實戰的災情:接完電話回來變空白畫面)
 *   D. 同裝置換分頁:舊分頁收到 __kicked__,名單不會多一個人
 *   E. 特權指令保護:控制碼錯的人送指令會被擋下
 *
 * 用法: node scripts/verify-live-ops.mjs [host]
 */

const HOST = process.argv[2] || '127.0.0.1:1999';
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ARM_COUNTDOWN_MS = 3800;
const ROOM = 'liveops-' + Math.floor(Math.random() * 1e6);

const fails = [];
const check = (label, ok, detail) => {
  if (ok) console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  else { fails.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);

function conn(room, query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${room}?${new URLSearchParams(query)}`);
    const frames = [];
    ws.addEventListener('message', (e) => { try { frames.push(JSON.parse(e.data)); } catch {} });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      ws, frames, send: (m) => ws.send(JSON.stringify(m)),
      cursor: () => frames.length,
      since: (n, t) => frames.slice(n).find((f) => f.type === t),
    }));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
async function until(c, cur, type, ms = 10000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { const h = c.since(cur, type); if (h) return h; await wait(120); }
  return null;
}
async function snapshot(room) {
  const p = await conn(room, { role: 'presenter' });
  await wait(600);
  const s = lastOf(p.frames, '__room_state__')?.payload;
  try { p.ws.close(); } catch {}
  return s;
}

console.log(`\n═══ 現場操作驗證 · host=${HOST} · room=${ROOM} ═══`);

const ass = await conn(ROOM, { role: 'assistant' });
await wait(400);
const welcome = lastOf(ass.frames, '__welcome__')?.payload;
const cc = welcome?.controlCode;         // 投影端控制碼
const ac = welcome?.assistantCode;       // 助理端控制碼
if (!cc || !ac) { console.error('❌ 拿不到控制碼'); process.exit(1); }
console.log(`投影碼 ${cc} · 助理碼 ${ac}`);

// ── A. 控制碼登入路由 ────────────────────────────────────
console.log('\n【A. 控制碼登入路由】');
{
  const g = await conn(ROOM, { role: 'participant', deviceId: 'staff-probe' });
  await wait(300);

  let c = g.cursor();
  g.send({ type: 'staff_login', payload: { code: cc } });
  const r1 = await until(g, c, '__staff_route__', 6000);
  check('輸入投影端控制碼 → 導向投影端', r1?.payload?.dest === 'presenter', `dest=${r1?.payload?.dest}`);
  check('投影端路由有附控制碼(特權簽章用)', !!r1?.payload?.controlCode);

  c = g.cursor();
  g.send({ type: 'staff_login', payload: { code: ac } });
  const r2 = await until(g, c, '__staff_route__', 6000);
  check('輸入助理端控制碼 → 導向助理端', r2?.payload?.dest === 'assistant', `dest=${r2?.payload?.dest}`);

  c = g.cursor();
  g.send({ type: 'staff_login', payload: { code: 'ZZZZ' } });
  const err = await until(g, c, '__error__', 6000);
  check('亂打控制碼 → 明確錯誤訊息', err?.payload?.code === 'bad_code', err?.payload?.message || '沒有錯誤回應');

  c = g.cursor();
  g.send({ type: 'staff_login', payload: { code: cc.toLowerCase() } });
  const r3 = await until(g, c, '__staff_route__', 6000);
  check('控制碼小寫也認得(現場常見輸入)', r3?.payload?.dest === 'presenter', `dest=${r3?.payload?.dest}`);
  try { g.ws.close(); } catch {}
}

// ── 佈置一場進行中的遊戲 ────────────────────────────────
const pre = await conn(ROOM, { role: 'presenter' });
const players = [];
for (let i = 0; i < 4; i++) {
  const p = await conn(ROOM, { role: 'participant', deviceId: `lo-${i}` });
  p.name = `學員${i + 1}`;
  players.push(p);
  await wait(150);
  p.send({ type: 'player_join', payload: { name: p.name } });
  await wait(200);
}
await wait(500);
ass.send({
  type: 'game_start', controlCode: cc,
  payload: {
    mode: 'ordinary', customTiers: ['easy'], customTypes: ['multiple_choice'],
    totalQ: 5, spq: 5, groups: [{ name: '第一組' }, { name: '第二組' }],
    rushMode: 'speed', wordGameCap: 0, groupingMode: 'random',
    timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 180 },
  },
});
await until(pre, 0, 'game_start');
await wait(500);

// 跑到「有題目、有分數」的狀態
let c = pre.cursor();
ass.send({ type: 'start_rush', controlCode: cc });
await until(pre, c, 'start_rush');
await wait(ARM_COUNTDOWN_MS + 300);
players[0].send({ type: 'buzz_press', payload: { ts: Date.now() } });
const win = await until(pre, c, 'rush_winner');
c = pre.cursor();
ass.send({ type: 'enter_category', controlCode: cc });
await until(pre, c, 'enter_category');
c = pre.cursor();
ass.send({ type: 'category_confirm', controlCode: cc, payload: { fid: 'F5' } });
const q = await until(pre, c, 'question_pick');
c = pre.cursor();
ass.send({ type: 'score_adjust', controlCode: cc, payload: { teamIdx: win?.payload?.groupIdx ?? 0, delta: 5, completeRound: true } });
await until(pre, c, 'score_update');
await wait(400);

// ── C. 中途重連 ──────────────────────────────────────────
console.log('\n【C. 中途重連(斷線後回來)】');
{
  const s = await snapshot(ROOM);
  check('新連線拿得到「當前題目」', !!s?.currentQuestion,
    s?.currentQuestion ? `${s.currentQuestion.difficulty}/${s.currentQuestion.framework}` : '快照沒有 currentQuestion');
  check('新連線拿得到分數', (s?.groups || []).some((g) => g.score > 0),
    JSON.stringify((s?.groups || []).map((g) => g.score)));
  check('新連線拿得到名單(四個人都在)',
    (s?.participants || []).length === 4, `${(s?.participants || []).length} 人`);
  check('新連線拿得到目前階段', !!s?.phase, `phase=${s.phase}`);
}

// ── D. 同裝置換分頁 ──────────────────────────────────────
console.log('\n【D. 同一支手機開新分頁】');
{
  const before = (await snapshot(ROOM))?.participants?.length ?? -1;
  const cOld = players[1].cursor();
  const dup = await conn(ROOM, { role: 'participant', deviceId: 'lo-1', name: players[1].name, team: '第一組' });
  await wait(800);
  const kicked = await until(players[1], cOld, '__kicked__', 5000);
  check('舊分頁收到「被新分頁接管」通知', !!kicked, kicked?.payload?.reason || '沒收到 __kicked__');
  const after = (await snapshot(ROOM))?.participants?.length ?? -2;
  check('名單人數沒有變多(不會出現分身)', before === after, `${before} → ${after}`);
  try { dup.ws.close(); } catch {}
}

// ── E. 特權指令保護 ──────────────────────────────────────
console.log('\n【E. 控制碼保護】');
{
  const cE = players[2].cursor();
  players[2].send({ type: 'score_adjust', controlCode: 'WXYZ', payload: { teamIdx: 0, delta: 999 } });
  const err = await until(players[2], cE, '__error__', 5000);
  check('拿錯控制碼加分會被擋下', err?.payload?.code === 'unauth', err?.payload?.code || '沒有被擋');
  const s = await snapshot(ROOM);
  check('分數沒有被亂改', !(s?.groups || []).some((g) => g.score >= 999),
    JSON.stringify((s?.groups || []).map((g) => g.score)));
}

// ── B. 重新開始 ──────────────────────────────────────────
console.log('\n【B. 重新開始(下一場)】');
{
  const before = await snapshot(ROOM);
  const namesBefore = (before?.groups || []).map((g) => (g.members || []).slice().sort().join(','));
  const leadersBefore = (before?.groups || []).map((g) => g.leader ?? null);

  const cR = pre.cursor();
  ass.send({ type: 'game_restart', controlCode: cc });
  await until(pre, cR, 'game_restart');
  await wait(800);

  const after = await snapshot(ROOM);
  const namesAfter = (after?.groups || []).map((g) => (g.members || []).slice().sort().join(','));
  check('組別與成員完整保留', JSON.stringify(namesBefore) === JSON.stringify(namesAfter),
    `前 ${JSON.stringify(namesBefore)} / 後 ${JSON.stringify(namesAfter)}`);
  check('組長保留(不重抽)',
    JSON.stringify(leadersBefore) === JSON.stringify((after?.groups || []).map((g) => g.leader ?? null)),
    JSON.stringify((after?.groups || []).map((g) => g.leader ?? null)));
  check('分數歸零', (after?.groups || []).every((g) => !g.score), JSON.stringify((after?.groups || []).map((g) => g.score)));
  check('題號歸零', after?.currQ === 0, `currQ=${after?.currQ}`);
  check('回到集合階段', after?.phase === 'lobby', `phase=${after?.phase}`);
  check('上一題被清掉', !after?.currentQuestion, after?.currentQuestion ? '還留著舊題' : '');
  // 房層身分不能被洗掉(曾發生總助理失去身分的權限漏洞)
  const cS = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc });
  const stillOk = await until(pre, cS, '__error__', 2500);
  check('重開後助理的控制碼仍然有效', !stillOk, stillOk?.payload?.message || '');
}

[ass, pre, ...players].forEach((x) => { try { x.ws.close(); } catch {} });

if (fails.length) {
  console.error(`\n❌ ${fails.length} 項未通過:`);
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✅ 現場操作全部正常:控制碼登入、中途重連、換分頁、控制碼保護、重新開始。');
process.exit(0);
