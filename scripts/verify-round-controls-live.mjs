#!/usr/bin/env node
/**
 * verify-round-controls-live.mjs — 2026-08-27 現場事故的端到端回歸。
 *
 * 覆蓋四個實測回報的問題:
 *   1. count / allhands 平手或無人按 → 必須廣播 rush_no_winner(修正前
 *      noWinner 被 winnerLocked 擋住,房間永遠卡在 rushing)。
 *   2. 無勝者後助理用 start_rush(rerush) 恢復 → 必須被接受。
 *   3. 不計分 → rebuzz_same → 原題棄置,新勝隊進九宮格抽「新題」,
 *      題號(roundQ)不前進;答錯隊被 buzz_lockout 排除。
 *   4. 「重新這一次」= start_rush(rerush) 在 answering 也被接受(棄題重搶,
 *      失格名單保留);「重新這一輪」= round_reset 清失格名單回 idle,
 *      先前失格的隊伍恢復可搶。棄置的題在 askedQuestions 標 replaced。
 *
 * Pre-req: dev server on localhost:1999(或 PGG_HOST=host 覆寫;https 網域
 * 自動用 wss)。
 */

const HOST = process.argv[2] ?? process.env.PGG_HOST ?? 'localhost:1999';
const WS = /localhost|127\.0\.0\.1/.test(HOST) ? 'ws' : 'wss';
const ROOM = `verify-roundctl-${Date.now()}`;
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

log(`\n═══ 回合控制端到端驗證 · host=${HOST} · room=${ROOM} ═══`);

const ass = await conn({ role: 'assistant' });
await wait(400);
const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode,中止'); process.exit(1); }

const pre = await conn({ role: 'presenter' });
const p1 = await conn({ role: 'participant', deviceId: 'rc-p1' });
const p2 = await conn({ role: 'participant', deviceId: 'rc-p2' });
await wait(300);
p1.send({ type: 'player_join', payload: { name: '甲君' } });
await wait(250);
p2.send({ type: 'player_join', payload: { name: '乙君' } });
await wait(600);

ass.send({ type: 'game_start', controlCode: cc, payload: {
  mode: 'ordinary', customTiers: [], customTypes: [],
  totalQ: 5, spq: 5,
  groups: [{ name: '第一組' }, { name: '第二組' }],
  rushMode: 'count', wordGameCap: 0, groupingMode: 'random',
} });
if (!await until(pre, 0, 'game_start')) { console.error('❌ game_start 沒生效,中止'); process.exit(1); }

const setMode = async (mode, label) => {
  const c = pre.cursor();
  ass.send({ type: 'rush_mode_changed', controlCode: cc, payload: { mode, label } });
  await until(pre, c, 'rush_mode_changed');
};

// ══ 1. 狂點奪魁 · 兩隊人均相同 → 平手必須廣播 rush_no_winner ═══════
log('\n【1 · count 平手 → rush_no_winner(tie)】');
{
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc });
  await until(pre, c, 'start_rush');
  await wait(ARM_COUNTDOWN_MS + 500);
  // 兩隊各 1 人、各按 2 下 → 人均 2.0 = 2.0 → 平手
  p1.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  p2.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  await wait(200);
  p1.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  p2.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const nw = await until(pre, c, 'rush_no_winner', 12000);
  check('平手時三端收到 rush_no_winner(修正前:永遠卡在 rushing)', !!nw,
    nw ? '' : '事件沒來 — noWinner 死鎖回歸');
  check('原因標為 tie', nw?.payload?.reason === 'tie', `reason=${nw?.payload?.reason}`);
  const snap = await snapshotProbe();
  check('server phase 回到 idle(可以重新搶答)', snap?.phase === 'idle', `phase=${snap?.phase}`);
}

// ══ 2. 無勝者後恢復 + 無人按逾時 ═══════════════════════════════
log('\n【2 · 恢復重搶 → 無人按 → rush_no_winner(timeout)】');
{
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc, payload: { rerush: true } });
  check('無勝者後的重新搶答被接受', !!await until(pre, c, 'start_rush'));
  const nw = await until(pre, c, 'rush_no_winner', 12000);
  check('完全無人按 → rush_no_winner(timeout)', nw?.payload?.reason === 'timeout',
    `reason=${nw?.payload?.reason}`);
}

// ══ 3. 全組到位 · 兩隊同步人數相同 → 平手 ═══════════════════════
log('\n【3 · allhands 平手 → rush_no_winner(tie)】');
{
  await setMode('allhands', '全組到位');
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc });
  await until(pre, c, 'start_rush');
  await wait(ARM_COUNTDOWN_MS + 500);
  p1.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  await wait(300);
  p2.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const nw = await until(pre, c, 'rush_no_winner', 12000);
  check('全組到位平手 → rush_no_winner(今日現場的卡死情境)', !!nw,
    nw ? '' : '事件沒來 — 全組到位又會當場凍結');
  check('原因標為 tie', nw?.payload?.reason === 'tie', `reason=${nw?.payload?.reason}`);
}

// ══ 4. 不計分 → 重新搶答(換新題) ═══════════════════════════════
log('\n【4 · rebuzz_same:原題棄置、答錯隊排除、新題同回合】');
await setMode('speed', '電光石火');
async function speedWin(presser, label) {
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc });
  if (!await until(pre, c, 'start_rush')) { fails.push(`${label}: 沒收到 start_rush`); return null; }
  await wait(ARM_COUNTDOWN_MS + 500);
  presser.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const w = await until(pre, c, 'rush_winner', 9000);
  if (!w) { fails.push(`${label}: 沒收到 rush_winner`); return null; }
  return w.payload;
}
async function pickQuestion(fid, label) {
  const c = pre.cursor();
  ass.send({ type: 'enter_category', controlCode: cc });
  if (!await until(pre, c, 'enter_category')) { fails.push(`${label}: enter_category 沒生效`); return null; }
  const cQ = pre.cursor();
  ass.send({ type: 'category_confirm', controlCode: cc, payload: { fid } });
  const q = await until(pre, cQ, 'question_pick', 9000);
  if (!q) {
    const err = ass.since(cQ, '__error__');
    fails.push(`${label}: 抽題失敗${err ? ' · ' + err.payload?.message : ''}`);
    return null;
  }
  return q.payload;
}

const w1 = await speedWin(p1, 'R-first');
check('甲君搶到第一輪', !!w1, w1 ? w1.groupName : '');
const q1 = w1 && await pickQuestion('F1', 'R-first');
check('抽到第一題', !!q1, q1 ? `${q1.id} · roundQ=${q1.roundQ}` : '');
{
  const c = pre.cursor();
  ass.send({ type: 'reveal_answer', controlCode: cc });
  await until(pre, c, 'reveal_answer');
}
// 助理按「不計分」(前端記錄,不動分數)→ 重新搶答(換新題)
let failedTeamName = w1?.groupName;
let q2 = null;
{
  const c = pre.cursor();
  ass.send({ type: 'rebuzz_same', controlCode: cc });
  const lock = await until(pre, c, 'buzz_lockout');
  check('答錯隊列入 buzz_lockout', !!lock && (lock.payload?.teams || []).includes(failedTeamName),
    JSON.stringify(lock?.payload?.teams));
  if (!await until(pre, c, 'start_rush')) fails.push('rebuzz: 沒收到 start_rush');
  await wait(ARM_COUNTDOWN_MS + 500);
  // 答錯隊先按(必須被忽略),另一隊後按(應獲勝)
  p1.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  await wait(300);
  p2.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const w = await until(pre, c, 'rush_winner', 9000);
  check('重搶由另一隊勝出(答錯隊確實被排除)',
    !!w && w.payload?.groupIdx !== w1?.groupIdx,
    w ? `勝方=${w.payload?.groupName}` : '沒有勝方');
  q2 = w && await pickQuestion('F2', 'R-rebuzz');
  check('重搶後抽到「新題」(不是回到原題)', !!q2 && q2.id !== q1?.id,
    q2 ? `${q1?.id} → ${q2.id}` : '');
  check('題號不前進(仍是同一回合)', !!q2 && q2.roundQ === q1?.roundQ,
    `roundQ ${q1?.roundQ} → ${q2?.roundQ}`);
}

// ══ 5. 重新這一次:answering 中 start_rush(rerush) 棄題重搶 ═══════
log('\n【5 · 重新這一次:answering 棄題重搶、失格保留】');
let q3 = null;
{
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc, payload: { rerush: true } });
  const sr = await until(pre, c, 'start_rush');
  check('answering 階段的 start_rush(rerush) 被接受(修正前 wrong_phase)', !!sr,
    sr ? '' : (ass.since(c, '__error__')?.payload?.message || '沒回應'));
  const lock = await until(pre, c, 'buzz_lockout');
  check('失格名單保留(重新這一次不解除排除)',
    !!lock && (lock.payload?.teams || []).includes(failedTeamName),
    JSON.stringify(lock?.payload?.teams));
  await wait(ARM_COUNTDOWN_MS + 500);
  p2.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const w = await until(pre, c, 'rush_winner', 9000);
  check('重搶有勝方', !!w, '');
  q3 = w && await pickQuestion('F3', 'R-reset-attempt');
  check('棄題後抽到新題、回合不變', !!q3 && q3.id !== q2?.id && q3.roundQ === q2?.roundQ,
    q3 ? `${q2?.id} → ${q3.id} · roundQ=${q3.roundQ}` : '');
}

// ══ 6. 重新這一輪:round_reset 清失格回 idle ═══════════════════════
log('\n【6 · 重新這一輪:整輪作廢、全員恢復資格】');
{
  const c = pre.cursor();
  ass.send({ type: 'round_reset', controlCode: cc });
  const rr = await until(pre, c, 'round_reset');
  check('三端收到 round_reset', !!rr);
  const lock = await until(pre, c, 'buzz_lockout');
  check('失格名單清空', !!lock && (lock.payload?.teams || []).length === 0,
    JSON.stringify(lock?.payload?.teams));
  const snap = await snapshotProbe();
  check('server 回到 idle、題目已清、題號不變',
    snap?.phase === 'idle' && snap?.currentQuestion === null && snap?.currQ === 0,
    `phase=${snap?.phase} currQ=${snap?.currQ} q=${JSON.stringify(snap?.currentQuestion)}`);
  // 原本失格的甲君隊要能再次獲勝
  const w = await speedWin(p1, 'R-after-reset');
  check('重置後原失格隊恢復可搶並獲勝', !!w && w.groupName === failedTeamName,
    w ? w.groupName : '');
}

// ══ 7. 回顧標記:棄置的題目標 replaced ═══════════════════════════
log('\n【7 · export:棄置題標 replaced,已判定題不標】');
{
  const c = pre.cursor();
  ass.send({ type: 'export_result', controlCode: cc });
  const ex = await until(pre, c, 'export_result');
  const asked = ex?.payload?.askedQuestions || [];
  const byId = Object.fromEntries(asked.map((a) => [a.id, a]));
  check('export 帶出三筆抽題紀錄', asked.length === 3, `${asked.length} 筆`);
  check('已公佈答案的第一題不標 replaced(報告有不計分紀錄)',
    q1 && byId[q1.id] && byId[q1.id].replaced !== true, q1 ? JSON.stringify(byId[q1.id]) : '');
  check('重新這一次棄置的題標 replaced', q2 && byId[q2.id]?.replaced === true,
    q2 ? JSON.stringify(byId[q2.id]) : '');
  check('重新這一輪棄置的題標 replaced', q3 && byId[q3.id]?.replaced === true,
    q3 ? JSON.stringify(byId[q3.id]) : '');
}

for (const cnn of [ass, pre, p1, p2]) { try { cnn.ws.close(); } catch {} }
if (fails.length) {
  console.error(`\n❌ ${fails.length} 項失敗:`);
  fails.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\n✅ 回合控制端到端驗證全數通過');
process.exit(0);
