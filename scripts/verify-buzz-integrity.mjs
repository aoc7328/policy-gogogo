#!/usr/bin/env node
/**
 * verify-buzz-integrity.mjs — 搶答封包的身分與節流防線。
 *
 * Pre-req: 後端 dev server 要跑著(預設 127.0.0.1:1998)。
 *   npx wrangler dev -c worker/wrangler.jsonc --port 1998
 *   node scripts/verify-buzz-integrity.mjs 127.0.0.1:1998
 *
 * 這支腳本存在的理由(2026-07-23 實測):
 *  1. onBuzzPress 過去直接採信封包裡的 name / team → A 組的人可以送出
 *     team:"B組"、name:"隨便打的字" 幫別組搶答,投影幕照著顯示,還讓他
 *     變成 B 組的搶答 MVP。現在身分一律以 server 名冊為準。
 *  2. 狂點奪魁沒有任何頻率上限 → 一支腳本 5 秒送進 7,440 次點擊、人均
 *     1860 次,對面整組真人猛點只有 48 次。現在每連線每秒最多計 20 次。
 *  3. rename_self 沒有重名檢查 → 可以把自己改成別組某人的名字,名單、
 *     組長標記、MVP 統計全部混在一起。
 */
const HOST = process.argv[2] || '127.0.0.1:1998';
// 本機用 ws://,正式站(workers.dev)一定要 wss://
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ROOM = 'buzzint-' + Math.floor(Math.random() * 1e6);
const fails = [];
const log = (...a) => console.log(...a);

function conn(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams(query)}`);
    const frames = [];
    ws.addEventListener('message', (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({ ws, frames, send: (m) => ws.send(JSON.stringify(m)) }));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);

const ass = await conn({ role: 'assistant' });
await wait(300);
const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode'); process.exit(1); }

const a = await conn({ role: 'participant', deviceId: 'dev-a' });
const b = await conn({ role: 'participant', deviceId: 'dev-b' });
await wait(200);
a.send({ type: 'player_join', payload: { name: '阿明' } });
await wait(200);
b.send({ type: 'player_join', payload: { name: '阿華' } });
await wait(400);

const probe0 = await conn({ role: 'presenter' });
await wait(350);
const g0 = lastOf(probe0.frames, '__room_state__')?.payload?.groups || [];
const teamOfA = g0.find((g) => g.members.includes('阿明'))?.name;
const teamOfB = g0.find((g) => g.members.includes('阿華'))?.name;
log('分組:阿明 →', teamOfA, '/ 阿華 →', teamOfB);
try { probe0.ws.close(); } catch { /* ignore */ }
if (!teamOfA || !teamOfB || teamOfA === teamOfB) {
  console.error('❌ 前置條件失敗:兩人應該被分到不同組');
  process.exit(1);
}

ass.send({
  type: 'game_start', controlCode: cc,
  payload: {
    mode: 'ordinary', customTiers: ['easy'], customTypes: ['multiple_choice'],
    totalQ: 5, spq: 5, groups: [{ name: teamOfA }, { name: teamOfB }],
    rushMode: 'speed', wordGameCap: null, groupingMode: 'random',
    timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 120 },
  },
});
await wait(500);

// game_start 之後組名可能被 config 重新命名(依 idx 對位),要重新取一次
// 「阿明現在到底在哪一組」,不能沿用開賽前的組名。
const probe = await conn({ role: 'presenter' });
await wait(350);
const g1 = lastOf(probe.frames, '__room_state__')?.payload?.groups || [];
const nowTeamOfA = g1.find((g) => (g.onlineMembers ?? g.members).includes('阿明'))?.name;
const nowTeamOfB = g1.find((g) => (g.onlineMembers ?? g.members).includes('阿華'))?.name;
log('開賽後:阿明 →', nowTeamOfA, '/ 阿華 →', nowTeamOfB);

// ── 測 1:阿明冒充「阿華 / 阿華那一組」搶答 ────────────────────────
ass.send({ type: 'start_rush', payload: { rerush: false }, controlCode: cc });
await wait(4500);   // armedAt = startedAt + ARM_COUNTDOWN_MS(3800)
a.send({ type: 'buzz_press', payload: { name: '我是阿華啦', team: nowTeamOfB, ts: 1 } });
await wait(1200);

const w = lastOf(probe.frames, 'rush_winner');
log('偽造封包後的 rush_winner =', JSON.stringify(w?.payload));
if (!w) {
  fails.push('偽造封包後完全沒有 rush_winner(預期:仍以真實身分計入阿明那一組)');
} else {
  if (w.payload.groupName !== nowTeamOfA) {
    fails.push(`組別未以 server 為準:得主是 ${w.payload.groupName},應為阿明所屬的 ${nowTeamOfA}`);
  }
  if (w.payload.personName !== '阿明') {
    fails.push(`名字未以 server 為準:顯示 ${w.payload.personName},應為「阿明」`);
  }
}

// ── 測 2:狂點節流(重開一場,直接用 count 模式) ────────────────────
ass.send({ type: 'game_restart', payload: {}, controlCode: cc });
await wait(600);
ass.send({
  type: 'game_start', controlCode: cc,
  payload: {
    mode: 'ordinary', customTiers: ['easy'], customTypes: ['multiple_choice'],
    totalQ: 5, spq: 5, groups: [{ name: nowTeamOfA }, { name: nowTeamOfB }],
    rushMode: 'count', wordGameCap: null, groupingMode: 'random',
    timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 120 },
  },
});
await wait(600);
const before2 = probe.frames.length;
ass.send({ type: 'start_rush', payload: { rerush: false }, controlCode: cc });
await wait(3900);
// 狂點視窗 5 秒。用遠超人類極限的速度狂送。
const burstEnd = Date.now() + 4600;
let sent = 0;
while (Date.now() < burstEnd) {
  for (let i = 0; i < 40; i++) { a.send({ type: 'buzz_press', payload: { name: '阿明', team: nowTeamOfA, ts: Date.now() } }); sent++; }
  await wait(5);
}
await wait(2500);
const w2 = [...probe.frames.slice(before2)].reverse().find((f) => f.type === 'rush_winner');
log(`狂點測試:送出 ${sent} 次 → rush_winner =`, JSON.stringify(w2?.payload));
if (!w2 || w2.payload.rushMode !== 'count') {
  fails.push('狂點模式沒有跑起來,無法判定節流是否生效');
} else {
  const counted = w2.payload.teamTotalClicks ?? 0;
  // 節流上限 20/秒 × 5 秒視窗 = 100 上限。留一點餘裕。
  if (counted > 140) fails.push(`狂點沒有被節流:送 ${sent} 次,計入 ${counted} 次(上限應約 100)`);
  else log(`   → 計入 ${counted} 次,已壓回人類量級 ✅`);
}

// ── 測 3:改名撞名要被擋 ──────────────────────────────────────────
b.send({ type: 'rename_self', payload: { newName: '阿明' } });
await wait(600);
const err = [...b.frames].reverse().find((f) => f.type === '__error__');
log('撞名改名回應 =', JSON.stringify(err?.payload));
if (!err || err.payload?.code !== 'rename_failed') {
  fails.push('改成別人的名字沒有被擋(預期收到 __error__ code=rename_failed)');
}

for (const c of [ass, a, b, probe]) { try { c.ws.close(); } catch { /* ignore */ } }

if (fails.length === 0) {
  log('\n✅ verify-buzz-integrity: 身分以 server 為準、狂點已節流、撞名改名被擋。');
  process.exit(0);
}
console.error('\n❌ verify-buzz-integrity 失敗:');
for (const f of fails) console.error('   -', f);
process.exit(1);
