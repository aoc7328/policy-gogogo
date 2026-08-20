#!/usr/bin/env node
/**
 * verify-rush-modes.mjs — 四種搶答模式 + 隨機的端到端判定驗證。
 *
 * verify-full-game 只跑「電光石火」。現場助理可能挑任何一種,這支把其餘
 * 三種各自的規則都真的觸發一次,確認 server 判的贏家符合規則:
 *
 *   speed     電光石火:倒數後第一個有效按下者獲勝
 *   count     狂點奪魁:[armedAt, +5s) 內累計點擊最多的隊獲勝
 *   lightning 閃電一按:[armedAt, +3s) 內按下 = 淘汰;[+3s, +8s) 首位有效者勝
 *   allhands  全組到位:[armedAt, +8s) 內同隊 500ms 窗口同步人數最多者勝
 *   random    隨機:先送 rush_reveal 揭曉實際模式,再開始
 *
 * 每個模式各開一間新房(避免互相污染),兩隊各兩人。
 * 用法: node scripts/verify-rush-modes.mjs [host]
 */

const HOST = process.argv[2] || '127.0.0.1:1999';
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ARM_COUNTDOWN_MS = 3800;      // 與 party/rush/types.ts 對齊
const LIGHTNING_DISQUAL_MS = 3000;
const COUNT_DURATION_MS = 5000;

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
      ws, frames,
      send: (m) => ws.send(JSON.stringify(m)),
      cursor: () => frames.length,
      since: (n, type) => frames.slice(n).find((f) => f.type === type),
      allSince: (n, type) => frames.slice(n).filter((f) => f.type === type),
    }));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
async function until(client, cursor, type, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = client.since(cursor, type);
    if (hit) return hit;
    await wait(120);
  }
  return null;
}

/** 開一間新房、四人進場(兩隊各兩人)、開賽。回傳操作握把。 */
async function setupRoom(rushMode) {
  const room = `rush-${rushMode}-${Math.floor(Math.random() * 1e6)}`;
  const ass = await conn(room, { role: 'assistant' });
  await wait(400);
  const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
  if (!cc) throw new Error('拿不到 controlCode');
  const pre = await conn(room, { role: 'presenter' });

  const players = [];
  for (let i = 0; i < 4; i++) {
    const p = await conn(room, { role: 'participant', deviceId: `rm-${i}` });
    p.name = `選手${i + 1}`;
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
      rushMode, wordGameCap: 0, groupingMode: 'random',
      timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 180 },
    },
  });
  await until(pre, 0, 'game_start');
  await wait(400);

  // 用新連線取權威名單,確定誰在哪一隊
  const probe = await conn(room, { role: 'presenter' });
  await wait(500);
  const groups = lastOf(probe.frames, '__room_state__')?.payload?.groups || [];
  try { probe.ws.close(); } catch {}
  const teamOf = new Map();
  groups.forEach((g, idx) => (g.members || []).forEach((m) => teamOf.set(m, idx)));
  const teamA = players.filter((p) => teamOf.get(p.name) === 0);
  const teamB = players.filter((p) => teamOf.get(p.name) === 1);

  return { room, ass, pre, players, teamA, teamB, cc, close: () => {
    [ass, pre, ...players].forEach((c) => { try { c.ws.close(); } catch {} });
  } };
}

/** 送出 start_rush,等到倒數結束(armedAt)才回來。 */
async function armed(ctx) {
  const c = ctx.pre.cursor();
  ctx.ass.send({ type: 'start_rush', controlCode: ctx.cc });
  const sr = await until(ctx.pre, c, 'start_rush');
  if (!sr) throw new Error('沒收到 start_rush');
  await wait(ARM_COUNTDOWN_MS + 300);
  return c;
}
const press = (p) => p.send({ type: 'buzz_press', payload: { ts: Date.now() } });

// ═══ speed ═══════════════════════════════════════════════
async function testSpeed() {
  console.log('\n【電光石火 speed】倒數後第一個按的人獲勝');
  const ctx = await setupRoom('speed');
  try {
    if (!ctx.teamB.length) { check('分組成功', false, '第二組沒人'); return; }
    const c = await armed(ctx);
    press(ctx.teamB[0]);                       // 第二組先按
    await wait(250);
    press(ctx.teamA[0]);                       // 第一組慢一步
    const w = await until(ctx.pre, c, 'rush_winner');
    check('先按的第二組獲勝', w?.payload?.groupIdx === 1,
      w ? `勝方=${w.payload.groupName} / ${w.payload.personName} (+${w.payload.elapsedMs}ms)` : '沒有勝方');
  } finally { ctx.close(); }
}

// ═══ count ═══════════════════════════════════════════════
async function testCount() {
  console.log('\n【狂點奪魁 count】5 秒內累計點擊最多的隊獲勝');
  const ctx = await setupRoom('count');
  try {
    const c = await armed(ctx);
    // 第一組狂點,第二組只點幾下
    const t0 = Date.now();
    const spam = setInterval(() => ctx.teamA.forEach(press), 90);
    const slow = setInterval(() => ctx.teamB[0] && press(ctx.teamB[0]), 900);
    await wait(COUNT_DURATION_MS - 400);
    clearInterval(spam); clearInterval(slow);
    const tick = ctx.pre.allSince(c, 'rush_tick');
    const w = await until(ctx.pre, c, 'rush_winner');
    check('狂點的第一組獲勝', w?.payload?.groupIdx === 0,
      w ? `勝方=${w.payload.groupName} 全隊 ${w.payload.teamTotalClicks} 點 / MVP ${w.payload.personName} ${w.payload.mvpClicks} 點` : '沒有勝方');
    check('計數過程有即時 rush_tick 廣播', tick.length > 5, `${tick.length} 次`);
  } finally { ctx.close(); }
}

// ═══ lightning ═══════════════════════════════════════════
async function testLightning() {
  console.log('\n【閃電一按 lightning】前 3 秒按下 = 淘汰,之後第一位有效者勝');
  const ctx = await setupRoom('lightning');
  try {
    const c = await armed(ctx);
    press(ctx.teamA[0]);                        // 淘汰窗內按 → 應被淘汰
    const dq = await until(ctx.pre, c, 'lightning_disqualify', 4000);
    check('淘汰窗內按下的人被判淘汰', !!dq,
      dq ? `${dq.payload.name}(${dq.payload.team}) @${dq.payload.elapsedMs}ms` : '沒有 lightning_disqualify');
    await wait(LIGHTNING_DISQUAL_MS + 400);     // 等進入有效窗
    press(ctx.teamB[0]);
    const w = await until(ctx.pre, c, 'rush_winner');
    check('有效窗內按下的第二組獲勝', w?.payload?.groupIdx === 1,
      w ? `勝方=${w.payload.groupName} / ${w.payload.personName}` : '沒有勝方');
  } finally { ctx.close(); }
}

// ═══ allhands ════════════════════════════════════════════
async function testAllhands() {
  console.log('\n【全組到位 allhands】500ms 內同步按下人數最多的隊獲勝');
  const ctx = await setupRoom('allhands');
  try {
    if (ctx.teamA.length < 2) { check('第一組有兩人可同步', false, `只有 ${ctx.teamA.length} 人`); return; }
    const c = await armed(ctx);
    // 第一組兩人在 500ms 窗內同步按 → cluster = 2
    press(ctx.teamA[0]);
    await wait(150);
    press(ctx.teamA[1]);
    // 第二組只有一人按 → cluster = 1
    await wait(600);
    press(ctx.teamB[0]);
    const prog = await until(ctx.pre, c, 'allhands_progress', 4000);
    check('過程有 allhands_progress 進度廣播', !!prog);
    const w = await until(ctx.pre, c, 'rush_winner', 14000);
    check('同步兩人的第一組獲勝', w?.payload?.groupIdx === 0,
      w ? `勝方=${w.payload.groupName} cluster=${w.payload.clusterCount}/${w.payload.totalCount}` : '沒有勝方');
    check('勝方 cluster 人數為 2', w?.payload?.clusterCount === 2, String(w?.payload?.clusterCount));
  } finally { ctx.close(); }
}

// ═══ random ══════════════════════════════════════════════
async function testRandom() {
  console.log('\n【隨機 random】先揭曉實際模式,再開始搶答');
  const ctx = await setupRoom('random');
  try {
    const c = ctx.pre.cursor();
    ctx.ass.send({ type: 'start_rush', controlCode: ctx.cc });
    const reveal = await until(ctx.pre, c, 'rush_reveal', 6000);
    check('先收到 rush_reveal 揭曉', !!reveal,
      reveal ? `實際模式=${reveal.payload.rushMode} 揭曉 ${reveal.payload.revealMs}ms` : '');
    const actual = reveal?.payload?.rushMode;
    check('揭曉的是四種實際模式之一',
      ['speed', 'count', 'lightning', 'allhands'].includes(actual), String(actual));
    const sr = await until(ctx.pre, c, 'start_rush', 12000);
    check('揭曉後才真正開始搶答', !!sr && sr.payload.rushMode === actual,
      sr ? `start_rush 模式=${sr.payload.rushMode}` : '沒有 start_rush');
  } finally { ctx.close(); }
}

console.log(`\n═══ 搶答模式驗證 · host=${HOST} ═══`);
await testSpeed();
await testCount();
await testLightning();
await testAllhands();
await testRandom();

if (fails.length) {
  console.error(`\n❌ ${fails.length} 項未通過:`);
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✅ 五種搶答設定全部依規則正確判定。');
process.exit(0);
