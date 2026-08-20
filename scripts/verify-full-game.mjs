#!/usr/bin/env node
/**
 * verify-full-game.mjs — 一整場遊戲從開賽走到結算的端到端驗證。
 *
 * 為什麼要有這支:既有的即時腳本各自只咬住一小段(名單、搶答公正性、
 * 重新分組),沒有任何一支把「助理明天在現場真的會按的那條路」從頭走到尾。
 * 2026-08-20 現場事故後補上 —— 進場修好了不代表遊玩沒問題。
 *
 * 覆蓋範圍(依 CONTEXT.md 的目標流程):
 *   R1 正常得分回合:game_start → start_rush → buzz → rush_winner →
 *      enter_category → category_confirm → question_pick → reveal_answer →
 *      score_adjust(completeRound) → score_update → next_question
 *   R2 不計分回合:同上到 reveal_answer,不加分 → rebuzz_same →
 *      答錯隊被排除、由另一隊搶到 → 判分完成
 *   R3 最後一題 → ended → export_result
 *   並檢查:題號只被 completeRound 推進、分數為 server 權威值、
 *          投影端與參賽者端都收得到每個關鍵事件。
 *
 * 用法: node scripts/verify-full-game.mjs [host]
 *   本機   node scripts/verify-full-game.mjs 127.0.0.1:1999
 *   正式站 node scripts/verify-full-game.mjs policy-gogogo-party.aoc7328.workers.dev
 */

const HOST = process.argv[2] || '127.0.0.1:1999';
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ROOM = 'fullgame-' + Math.floor(Math.random() * 1e6);
const TOTAL_Q = 3;
const SPQ = 5;
// 與 party/rush/types.ts 的 ARM_COUNTDOWN_MS 對齊(3000 倒數 + 800 GO)
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
      // 游標:記下當下的 frame 數,之後只看「這之後」的新事件,
      // 避免把上一輪的 rush_winner 誤讀成這一輪的結果。
      cursor: () => frames.length,
      since: (n, type) => frames.slice(n).find((f) => f.type === type),
      allSince: (n, type) => frames.slice(n).filter((f) => f.type === type),
    }));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);

/** 等某個事件出現(輪詢),逾時回 null —— 比固定 sleep 穩,慢網路也不會假失敗。 */
async function until(client, cursor, type, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = client.since(cursor, type);
    if (hit) return hit;
    await wait(120);
  }
  return null;
}

log(`\n═══ 完整賽局驗證 · host=${HOST} · room=${ROOM} ═══\n`);

// ── 進場:助理 + 投影 + 兩隊各一人 ─────────────────────────────
const ass = await conn({ role: 'assistant' });
await wait(400);
const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode,中止'); process.exit(1); }
log(`房間 ${ROOM} · controlCode ${cc}`);

const pre = await conn({ role: 'presenter' });
const p1 = await conn({ role: 'participant', deviceId: 'fg-p1' });
const p2 = await conn({ role: 'participant', deviceId: 'fg-p2' });
await wait(300);
p1.send({ type: 'player_join', payload: { name: '甲君' } });
await wait(250);
p2.send({ type: 'player_join', payload: { name: '乙君' } });
await wait(600);

// 名單要用「新連線的即時快照」看:presenter 只在連線當下收到一次
// __room_state__,玩家是之後才進來的,讀它會拿到過期資料(測試自己的坑)。
let rosterProbe = await conn({ role: 'presenter' });
await wait(500);
const lobbySnap = lastOf(rosterProbe.frames, '__room_state__')?.payload;
const lobbyNames = (lobbySnap?.participants || []).map((p) => p.name);
try { rosterProbe.ws.close(); } catch {}
log('\n【進場】');
check('兩位參賽者都在 server 名單上',
  lobbyNames.includes('甲君') && lobbyNames.includes('乙君'),
  JSON.stringify(lobbyNames));
check('助理端收到兩則 player_join 通知',
  ass.frames.filter((f) => f.type === 'player_join').length === 2,
  String(ass.frames.filter((f) => f.type === 'player_join').length));

// ── 開賽 ────────────────────────────────────────────────────
const cfg = {
  mode: 'ordinary', customTiers: ['easy'], customTypes: ['multiple_choice'],
  totalQ: TOTAL_Q, spq: SPQ,
  groups: [{ name: '第一組' }, { name: '第二組' }],
  rushMode: 'speed', wordGameCap: 0, groupingMode: 'random',
  timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 180 },
};
let c = pre.cursor();
ass.send({ type: 'game_start', controlCode: cc, payload: cfg });
const started = await until(pre, c, 'game_start');
log('\n【開賽】');
check('投影端收到 game_start', !!started);

/** 跑一次搶答,回傳勝方 payload。exclude = 期待「不會」是這一隊。 */
async function runRush(label, rerush = false) {
  const cP = pre.cursor();
  ass.send(rerush ? { type: 'rebuzz_same', controlCode: cc }
                  : { type: 'start_rush', controlCode: cc });
  const sr = await until(pre, cP, 'start_rush');
  if (!sr) { fails.push(`${label}: 沒收到 start_rush`); return null; }
  // 必須等倒數結束才按:server 的 armedAt = 開始 + ARM_COUNTDOWN_MS(3800),
  // 提早按會被「靜默作廢」(speed.ts: ts < armedAt 直接 return),全場沒人
  // 有效按到就判無有效勝者。注意 rush_reveal 只有「隨機」模式才送,
  // 不能拿它當「可以按了」的信號(舊版誤用它,靠 8 秒逾時才碰巧按對)。
  await wait(ARM_COUNTDOWN_MS + 500);
  return { cP, sr };
}

/** 讓指定玩家搶下,回傳 rush_winner payload。 */
async function buzzAndWin(who, ctx, label) {
  who.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const win = await until(pre, ctx.cP, 'rush_winner', 9000);
  if (!win) { fails.push(`${label}: 沒收到 rush_winner`); return null; }
  return win.payload;
}

/** 選九宮格 → 抽題 → 公佈答案。 */
async function pickAndReveal(fid, label) {
  const cP = pre.cursor();
  ass.send({ type: 'enter_category', controlCode: cc });
  if (!await until(pre, cP, 'enter_category')) { fails.push(`${label}: 沒進入選題`); return null; }
  const cQ = pre.cursor();
  ass.send({ type: 'category_confirm', controlCode: cc, payload: { fid } });
  const q = await until(pre, cQ, 'question_pick', 9000);
  const err = ass.since(cQ, '__error__');
  if (!q) { fails.push(`${label}: 抽題失敗${err ? ' · server: ' + err.payload?.message : ''}`); return null; }
  const cR = pre.cursor();
  ass.send({ type: 'reveal_answer', controlCode: cc });
  if (!await until(pre, cR, 'reveal_answer')) { fails.push(`${label}: 公佈答案沒生效`); return null; }
  return q.payload;
}

// ══ R1:正常得分回合 ═══════════════════════════════════════
log('\n【第 1 回合 · 正常得分】');
let ctx = await runRush('R1');
const w1 = ctx && await buzzAndWin(p1, ctx, 'R1');
check('甲君搶到,server 判定勝方', !!w1, w1 ? `${w1.groupName} / ${w1.personName}` : '');

const q1 = w1 && await pickAndReveal('F1', 'R1');
check('抽到題目並公佈答案', !!q1, q1 ? `${q1.difficulty}/${q1.framework}` : '');

let cS = pre.cursor();
const winIdx = w1?.groupIdx ?? 0;
ass.send({ type: 'score_adjust', controlCode: cc, payload: { teamIdx: winIdx, delta: SPQ, completeRound: true } });
const su = await until(pre, cS, 'score_update');
check('加分後 server 廣播 score_update',
  !!su && su.payload.scores?.[winIdx]?.score === SPQ,
  su ? JSON.stringify(su.payload.scores?.map((s) => s.score)) : '');

let cN = pre.cursor();
ass.send({ type: 'next_question', controlCode: cc });
await until(pre, cN, 'next_question');
await wait(500);

// 用一條全新連線取權威快照(等同中途進場的人看到的世界)
let snapC = await conn({ role: 'presenter' });
await wait(500);
let snap = lastOf(snapC.frames, '__room_state__')?.payload;
check('題號前進到第 1 題(只有正式判分會消耗題數)', snap?.currQ === 1, `currQ=${snap?.currQ}`);
try { snapC.ws.close(); } catch {}

// ══ R2:不計分 → 同一題重新搶答(答錯隊要被排除) ═══════════
log('\n【第 2 回合 · 不計分後換隊重搶】');
ctx = await runRush('R2');
const w2 = ctx && await buzzAndWin(p1, ctx, 'R2');
check('甲君再次搶到', !!w2, w2 ? `${w2.groupName} / ${w2.personName}` : '');
const q2 = w2 && await pickAndReveal('F2', 'R2');
check('第 2 題抽題並公佈', !!q2);

// 助理按「不計分」(純前端記錄,不送 score_adjust) → 按「同一題重新搶答」
log('  → 助理按「不計分」,再按「同一題重新搶答」');
const ctx2 = await runRush('R2-rebuzz', true);
// 這次讓「原本那一隊的人」也按,驗證他真的被排除
if (ctx2) {
  p1.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  await wait(300);
  p2.send({ type: 'buzz_press', payload: { ts: Date.now() } });
}
const w2b = ctx2 && await until(pre, ctx2.cP, 'rush_winner', 9000);
const w2bP = w2b?.payload;
check('重搶由「另一隊」勝出(答錯隊確實被排除)',
  !!w2bP && w2bP.groupIdx !== w2?.groupIdx,
  w2bP ? `勝方=${w2bP.groupName}(前一隊=${w2?.groupName})` : '沒有勝方');

const q2b = w2bP && await pickAndReveal('F3', 'R2b');
check('重搶後可正常抽新題並公佈', !!q2b);

cS = pre.cursor();
const winIdx2 = w2bP?.groupIdx ?? 1;
ass.send({ type: 'score_adjust', controlCode: cc, payload: { teamIdx: winIdx2, delta: SPQ, completeRound: true } });
const su2 = await until(pre, cS, 'score_update');
check('第 2 回合判分成功', !!su2, su2 ? JSON.stringify(su2.payload.scores?.map((s) => s.score)) : '');

cN = pre.cursor();
ass.send({ type: 'next_question', controlCode: cc });
await until(pre, cN, 'next_question');
await wait(500);
snapC = await conn({ role: 'presenter' });
await wait(500);
snap = lastOf(snapC.frames, '__room_state__')?.payload;
check('題號前進到第 2 題(不計分那次沒有多算)', snap?.currQ === 2, `currQ=${snap?.currQ}`);
try { snapC.ws.close(); } catch {}

// ══ R3:最後一題 → ended → 結算 ═══════════════════════════
log('\n【第 3 回合 · 最後一題與結算】');
ctx = await runRush('R3');
const w3 = ctx && await buzzAndWin(p2, ctx, 'R3');
check('第 3 回合搶答正常', !!w3, w3 ? `${w3.groupName} / ${w3.personName}` : '');
const q3 = w3 && await pickAndReveal('F4', 'R3');
check('第 3 題抽題並公佈', !!q3);

cS = pre.cursor();
const winIdx3 = w3?.groupIdx ?? 0;
ass.send({ type: 'score_adjust', controlCode: cc, payload: { teamIdx: winIdx3, delta: SPQ, completeRound: true } });
await until(pre, cS, 'score_update');

cN = pre.cursor();
ass.send({ type: 'next_question', controlCode: cc });
await until(pre, cN, 'next_question');
await wait(600);
snapC = await conn({ role: 'presenter' });
await wait(500);
snap = lastOf(snapC.frames, '__room_state__')?.payload;
check('最後一題結束後房間進入 ended', snap?.phase === 'ended', `phase=${snap?.phase}`);
try { snapC.ws.close(); } catch {}

const cE = pre.cursor();
const cEp = p1.cursor();
ass.send({ type: 'export_result', controlCode: cc });
const exp = await until(pre, cE, 'export_result', 9000);
check('結束本場:投影端收到 export_result', !!exp);
check('結束本場:參賽者端也收到結算', !!await until(p1, cEp, 'export_result', 6000));
const timerZero = pre.allSince(cE, 'timer_update').some((f) => f.payload?.remainingSec === 0);
check('結算時倒數被歸零(不會殘留警報音)', timerZero);

// ── 事件覆蓋率總表 ────────────────────────────────────────
log('\n【三端事件覆蓋】');
const need = ['game_start', 'start_rush', 'rush_winner', 'question_pick', 'reveal_answer', 'score_update', 'next_question', 'export_result'];
const preTypes = new Set(pre.frames.map((f) => f.type));
const pTypes = new Set(p1.frames.map((f) => f.type));
check('投影端收齊所有關鍵事件', need.every((t) => preTypes.has(t)),
  need.filter((t) => !preTypes.has(t)).join(',') || '');
check('參賽者端收齊主要事件',
  ['game_start', 'start_rush', 'rush_winner', 'question_pick', 'export_result'].every((t) => pTypes.has(t)),
  ['game_start', 'start_rush', 'rush_winner', 'question_pick', 'export_result'].filter((t) => !pTypes.has(t)).join(',') || '');

[ass, pre, p1, p2].forEach((c) => { try { c.ws.close(); } catch {} });

if (fails.length) {
  console.error(`\n❌ ${fails.length} 項未通過:`);
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✅ 完整賽局通過:開賽 → 搶答 → 選題抽題 → 公佈 → 判分 → 不計分換隊 → 下一題 → 結算,全程正常。');
// 明確結束:還沒完成關閉握手的 WebSocket 會讓 Node 事件迴圈不退出,
// 成功路徑若只是「跑完」會永遠掛著(踩過)。
process.exit(0);
