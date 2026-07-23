#!/usr/bin/env node
/**
 * verify-regroup-names.mjs — 「重新分組」要把玩家自訂的組名一併清空。
 *
 * Pre-req: 後端要跑著。
 *   npx wrangler dev -c worker/wrangler.jsonc --port 1998
 *   node scripts/verify-regroup-names.mjs 127.0.0.1:1998
 *   node scripts/verify-regroup-names.mjs policy-gogogo-party.aoc7328.workers.dev
 *
 * 為什麼(Vincent 2026-07-23 決定,選項 a):
 * 組名是綁在「組別位置」上的,不會跟著人走。王秀琴把自己那組取名「勇腳團」,
 * 助理按「重新分組」全員重洗之後,她被分到第二個位置、而「勇腳團」這個名字
 * 留在第一個位置變成別人那組 —— 現場會完全對不上。與其讓名字錯位,不如在
 * 重洗時一併清回「第一組/第二組…」,請各組組長重新取名。
 */
const HOST = process.argv[2] || '127.0.0.1:1998';
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ROOM = 'regroup-' + Math.floor(Math.random() * 1e6);
const fails = [];
const log = (...a) => console.log(...a);

function conn(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams(query)}`);
    const frames = [];
    ws.addEventListener('message', (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({ ws, frames, send: (m) => ws.send(JSON.stringify(m)) }));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);

const ass = await conn({ role: 'assistant' });
await wait(400);
const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode'); process.exit(1); }

// 四個人進場,湊得出兩組
const ps = [];
for (const [i, name] of ['王秀琴', '陳大明', '林淑芬', '張阿伯'].entries()) {
  const p = await conn({ role: 'participant', deviceId: 'dev-' + i });
  await wait(150);
  p.send({ type: 'player_join', payload: { name } });
  await wait(250);
  ps.push(p);
}

// 組長取名
ass.send({ type: 'team_rename', payload: { oldName: '第一組', newName: '勇腳團', by: '王秀琴' }, controlCode: cc });
await wait(300);
ass.send({ type: 'team_rename', payload: { oldName: '第二組', newName: '不老松', by: '陳大明' }, controlCode: cc });
await wait(500);

const before = await conn({ role: 'presenter' });
await wait(400);
const g0 = lastOf(before.frames, '__room_state__')?.payload?.groups || [];
log('取名後 =', JSON.stringify(g0.map((g) => ({ n: g.name, m: g.members }))));
try { before.ws.close(); } catch { /* ignore */ }
if (!g0.some((g) => g.name === '勇腳團') || !g0.some((g) => g.name === '不老松')) {
  console.error('❌ 前置條件失敗:組名沒有改成功,後面測不出東西');
  process.exit(1);
}

// 助理按「重新分組（全員隨機重洗）」
ass.send({ type: 'team_count_changed', payload: { count: 2, reshuffle: true }, controlCode: cc });
await wait(800);

const after = await conn({ role: 'presenter' });
await wait(500);
const g1 = lastOf(after.frames, '__room_state__')?.payload?.groups || [];
const roster = lastOf(ass.frames, 'roster_reshuffled')?.payload?.groups || [];
log('重洗後 =', JSON.stringify(g1.map((g) => ({ n: g.name, m: g.members }))));
log('roster_reshuffled 廣播的組名 =', JSON.stringify(roster.map((g) => g.name)));

const names = g1.map((g) => g.name);
if (names.includes('勇腳團') || names.includes('不老松')) {
  fails.push(`重洗後組名沒有被清掉,仍是 ${JSON.stringify(names)}`);
}
if (names[0] !== '第一組' || names[1] !== '第二組') {
  fails.push(`重洗後組名應回到「第一組/第二組」,實際是 ${JSON.stringify(names)}`);
}
if (roster.length && (roster.includes('勇腳團') || roster.includes('不老松'))) {
  fails.push('roster_reshuffled 廣播出去的還是舊組名,三端畫面會留著錯的名字');
}
// 人不能掉:四個人都要還在名單裡
const listed = g1.flatMap((g) => g.members || []);
for (const n of ['王秀琴', '陳大明', '林淑芬', '張阿伯']) {
  if (!listed.includes(n)) fails.push(`${n} 重洗後從名單消失`);
}
// 每個人的 team 都要指得到實際存在的組
for (const p of lastOf(after.frames, '__room_state__')?.payload?.participants || []) {
  if (!names.includes(p.team)) fails.push(`${p.name} 的 team="${p.team}" 不存在於 groups`);
}

for (const c of [ass, after, ...ps]) { try { c.ws.close(); } catch { /* ignore */ } }

if (fails.length === 0) {
  log('\n✅ verify-regroup-names: 重新分組會清掉自訂組名,而且沒有人掉出名單。');
  process.exit(0);
}
console.error('\n❌ verify-regroup-names 失敗:');
for (const f of fails) console.error('   -', f);
process.exit(1);
