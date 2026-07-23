#!/usr/bin/env node
/**
 * verify-startgame-roster.mjs — 回歸測試:開新一場不可以把全場從分組名單洗掉。
 *
 * Pre-req: 後端 dev server 要跑著(預設 127.0.0.1:1998;PartyKit 時代是 1999)。
 *   npx wrangler dev -c worker/wrangler.jsonc --port 1998
 *   node scripts/verify-startgame-roster.mjs 127.0.0.1:1998
 *
 * 這支腳本存在的理由(2026-07-23 實測事故):
 * startGame() 原本用「組名」當 key 還原 members。助理端一旦重整過頁面,
 * 送出的 config.groups 會退回預設「第一組/第二組」,跟玩家自己取的組名
 * (勇腳團/不老松)對不上 → members 變成空陣列 → 全場 8 個人從名單消失、
 * 誰都搶答不了,投影幕顯示「第一組 · (無人) 搶答耗時 8.000 秒」。
 * 現在改成「組數沒變就按 idx 對位」。這支腳本把整條路徑重跑一次。
 */

// 重現路徑:
//   1. 兩位參賽者進場 → 分到「第一組 / 第二組」
//   2. 玩家把兩組改名成「勇腳團 / 不老松」(team_rename)
//   3. 助理端「重整過頁面」→ 送出的 game_start 帶回預設的「第一組 / 第二組」
//   4. 修正前:members 全空、participant.team 指向不存在的組 → 誰都搶答不了
//      修正後:members 必須完整保留,且 participant.team 要跟著改名搬過去
//
// 用法: node verify-p1-1.mjs [host]   (預設 127.0.0.1:1998)
const HOST = process.argv[2] || '127.0.0.1:1998';
// 本機用 ws://,正式站(workers.dev)一定要 wss://
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ROOM = 'p11-' + Math.floor(Math.random() * 1e6);
const fails = [];
const log = (...a) => console.log(...a);

function conn(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams(query)}`);
    const frames = [];
    ws.addEventListener('message', (e) => { try { frames.push(JSON.parse(e.data)); } catch {} });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({ ws, frames, send: (m) => ws.send(JSON.stringify(m)) }));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);

const ass = await conn({ role: 'assistant' });
await wait(300);
const welcome = lastOf(ass.frames, '__welcome__');
const cc = welcome?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode'); process.exit(1); }
log('房間', ROOM, '· controlCode', cc);

// 1. 兩位參賽者進場
const p1 = await conn({ role: 'participant', deviceId: 'dev-p1' });
const p2 = await conn({ role: 'participant', deviceId: 'dev-p2' });
await wait(200);
p1.send({ type: 'player_join', payload: { name: '王秀琴' } });
await wait(200);
p2.send({ type: 'player_join', payload: { name: '陳大明' } });
await wait(400);

// 2. 玩家改組名
ass.send({ type: 'team_rename', payload: { oldName: '第一組', newName: '勇腳團', by: '王秀琴' }, controlCode: cc });
await wait(250);
ass.send({ type: 'team_rename', payload: { oldName: '第二組', newName: '不老松', by: '陳大明' }, controlCode: cc });
await wait(400);

// 用一條全新連線取快照,才看得到 server 當下真正的狀態
const pre = await conn({ role: 'presenter' });
await wait(350);
const beforeGroups = lastOf(pre.frames, '__room_state__')?.payload?.groups || [];
log('改名後 server groups =', JSON.stringify(beforeGroups.map((g) => ({ n: g.name, m: g.members }))));
if (!beforeGroups.some((g) => g.name === '勇腳團') || !beforeGroups.some((g) => g.name === '不老松')) {
  fails.push('team_rename 沒有生效 → 這次跑到的不是「組名不一致」那條路徑,測試無效');
}
try { pre.ws.close(); } catch {}

// 3. 模擬「助理端重整過頁面」→ 送出預設組名的 game_start
ass.send({
  type: 'game_start',
  controlCode: cc,
  payload: {
    mode: 'ordinary', customTiers: ['easy'], customTypes: ['multiple_choice'],
    totalQ: 5, spq: 5,
    groups: [{ name: '第一組' }, { name: '第二組' }],   // ← 這就是事故的來源
    rushMode: 'speed', wordGameCap: null, groupingMode: 'random',
    timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 120 },
  },
});
await wait(600);

// 4. 用一條全新連線取快照(等同「中途進場的人看到的世界」)
const probe = await conn({ role: 'presenter' });
await wait(400);
const snap = lastOf(probe.frames, '__room_state__');
const groups = snap?.payload?.groups || [];
const parts = snap?.payload?.participants || [];
log('game_start 後 groups =', JSON.stringify(groups.map((g) => ({ n: g.name, m: g.members, on: g.onlineMembers }))));
log('game_start 後 participants =', JSON.stringify(parts.map((p) => ({ n: p.name, t: p.team }))));

// ── 斷言 ──────────────────────────────────────────────────────────
const allMembers = groups.flatMap((g) => g.members || []);
if (!allMembers.includes('王秀琴')) fails.push('王秀琴 從分組名單消失(這就是原本的阻斷級 bug)');
if (!allMembers.includes('陳大明')) fails.push('陳大明 從分組名單消失(這就是原本的阻斷級 bug)');

for (const p of parts) {
  if (!groups.some((g) => g.name === p.team)) {
    fails.push(`${p.name} 的 team="${p.team}" 在 groups 裡找不到 → 他的 buzz_press 會被丟棄`);
  }
}
// onlineMembers 應該存在且只含在線的人
for (const g of groups) {
  if (!Array.isArray(g.onlineMembers)) fails.push(`${g.name} 缺少 onlineMembers 欄位`);
}

// 5. 真的按一下搶答,確認搶得到(最終證據)
ass.send({ type: 'start_rush', payload: { rerush: false }, controlCode: cc });
// 有效視窗從 armedAt 才開始 = startedAt + ARM_COUNTDOWN_MS(3800ms:3 秒倒數 + 800ms GO 停留)。
await wait(4500);
const me = parts.find((p) => p.name === '王秀琴');
p1.send({ type: 'buzz_press', payload: { name: '王秀琴', team: me?.team || '?', ts: Date.now() } });
await wait(1000);
// 若這一下被丟掉,再等到 fallback(armedAt+8000)觸發,才分得出是
// 「按了沒被計入」還是「整個 rush 沒跑起來」。
if (!lastOf(probe.frames, 'rush_winner')) { log('(第一下沒有立即產生 winner,等 fallback…)'); await wait(8000); }
const winner = lastOf(probe.frames, 'rush_winner');
log('rush_winner =', JSON.stringify(winner?.payload));
log('probe 收到的事件 =', probe.frames.map((f) => f.type).join(', '));
for (const c of [['ass', ass], ['p1', p1]]) {
  const errs = c[1].frames.filter((f) => f.type === '__error__');
  if (errs.length) log(`${c[0]} 收到錯誤 =`, JSON.stringify(errs.map((e) => e.payload)));
}
if (!winner) fails.push('沒有收到 rush_winner');
else if (winner.payload.fallback) fails.push('搶答被判定成「無人搶答」→ 真人按的那一下沒有被計入');
else if (winner.payload.personName !== '王秀琴') fails.push(`搶答得主應為王秀琴,實際為 ${winner.payload.personName}`);

for (const c of [ass, p1, p2, probe]) { try { c.ws.close(); } catch {} }

if (fails.length === 0) {
  log('\n✅ P1-1 驗證通過:改過組名 + 助理端重整後開新場,名單完整保留,搶答正常。');
  process.exit(0);
}
console.error('\n❌ P1-1 驗證失敗:');
for (const f of fails) console.error('   -', f);
process.exit(1);
