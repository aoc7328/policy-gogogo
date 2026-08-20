#!/usr/bin/env node
/**
 * stage-room.mjs — 把一間房佈置到「正在作答」狀態並維持住,方便用真瀏覽器
 * 檢查投影端 / 參賽者端的畫面。助理與參賽者都是真連線。
 *
 * 用法: node scripts/stage-room.mjs <room> [host] [人數]
 * 完成後印出控制碼與題目資訊,並保持連線(Ctrl+C 結束)。
 */

const ROOM = process.argv[2];
const HOST = process.argv[3] || 'policy-gogogo-party.aoc7328.workers.dev';
const N = Number(process.argv[4] || 2);
if (!ROOM) { console.error('用法: node scripts/stage-room.mjs <room> [host] [人數]'); process.exit(1); }
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ARM_COUNTDOWN_MS = 3800;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (f, t) => [...f].reverse().find((x) => x.type === t);
function conn(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams(query)}`);
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
async function until(c, cur, type, ms = 12000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { const h = c.since(cur, type); if (h) return h; await wait(120); }
  return null;
}

const ass = await conn({ role: 'assistant' });
await wait(400);
const w = lastOf(ass.frames, '__welcome__')?.payload;
const cc = w?.controlCode;
console.log(`房號 ${ROOM} · 投影碼 ${cc} · 助理碼 ${w?.assistantCode}`);

const pre = await conn({ role: 'presenter' });
const players = [];
for (let i = 0; i < N; i++) {
  const p = await conn({ role: 'participant', deviceId: `stage-${i}` });
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
console.log('已開賽');

let c = pre.cursor();
ass.send({ type: 'start_rush', controlCode: cc });
await until(pre, c, 'start_rush');
await wait(ARM_COUNTDOWN_MS + 300);
players[0].send({ type: 'buzz_press', payload: { ts: Date.now() } });
const win = await until(pre, c, 'rush_winner');
console.log(`勝方:${win?.payload?.groupName} / ${win?.payload?.personName}`);

c = pre.cursor();
ass.send({ type: 'enter_category', controlCode: cc });
await until(pre, c, 'enter_category');
c = pre.cursor();
ass.send({ type: 'category_confirm', controlCode: cc, payload: { fid: 'F1' } });
const q = await until(pre, c, 'question_pick');
console.log(`題目:${q?.payload?.difficulty} / ${q?.payload?.framework} / ${q?.payload?.type}`);
console.log(`題幹:${String(q?.payload?.question || '').slice(0, 60)}`);
ass.send({ type: 'set_timer', controlCode: cc, payload: { seconds: 300 } });

console.log('\n房間已停在「正在作答」,連線保持中。可用瀏覽器檢查:');
console.log(`  投影端  https://policy-gogogo.pages.dev/pj?room=${ROOM}&controlCode=${cc}`);
console.log(`  參賽者  https://policy-gogogo.pages.dev/gamer/${ROOM}`);
setInterval(() => {}, 1 << 30);
