#!/usr/bin/env node
/**
 * verify-group-stability.mjs — 「組員不可以到處亂跑」的回歸測試。
 *
 * 這是 30 人實戰真的發生過的災情,分兩類:
 *   1. 有人接電話 / 切出去 / 手機鎖屏 → 斷線重連後被丟到別組
 *   2. 遲到的人一加入 → 全場重新洗牌,已經分好的組全亂掉
 *
 * server 的入組優先序(party/server.ts onPlayerJoin):
 *   ① 裝置鎖(同一支手機 24h 內固定同組,改名也拉得回來)
 *   ② 名字已在某組名單 → 回原組(斷線不清名單)
 *   ③ 都沒有 → 最少人組 = 遲到者平均分配
 * 這支把每一條都真的觸發一次,並在每個事件前後比對
 * 「每個人 → 第幾組」的完整對照表,只要有任何人換組就報錯。
 *
 * 用法: node scripts/verify-group-stability.mjs [host]
 */

const HOST = process.argv[2] || '127.0.0.1:1999';
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ROOM = 'grpstab-' + Math.floor(Math.random() * 1e6);
const ARM_COUNTDOWN_MS = 3800;

const fails = [];
const check = (label, ok, detail) => {
  if (ok) console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  else { fails.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};
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

/** 用一條全新連線取權威快照,回傳「名字 → 第幾組」對照表。 */
async function seating() {
  const p = await conn({ role: 'presenter' });
  await wait(600);
  const s = lastOf(p.frames, '__room_state__')?.payload;
  try { p.ws.close(); } catch {}
  const map = {};
  (s?.groups || []).forEach((g, idx) => (g.members || []).forEach((m) => { map[m] = idx; }));
  return { map, snap: s };
}
/** 比對兩張座位表,列出換過組的人(只看 before 就存在的人)。 */
function movers(before, after) {
  return Object.keys(before).filter((n) => after[n] !== undefined && after[n] !== before[n])
    .map((n) => `${n}: 第${before[n] + 1}組 → 第${after[n] + 1}組`);
}
/** 模擬「接電話 / 切出去 / 鎖屏」:斷線後用同一支裝置重新連回並重新報到。 */
async function reconnect(p) {
  try { p.ws.close(); } catch {}
  await wait(900);
  const back = await conn({ role: 'participant', deviceId: p.deviceId });
  back.deviceId = p.deviceId;
  back.name = p.name;
  await wait(250);
  back.send({ type: 'player_join', payload: { name: p.name } });
  await wait(600);
  return back;
}
async function join(i, name) {
  const deviceId = `gs-dev-${i}`;
  const p = await conn({ role: 'participant', deviceId });
  p.deviceId = deviceId; p.name = name;
  await wait(200);
  p.send({ type: 'player_join', payload: { name } });
  await wait(450);
  return p;
}

console.log(`\n═══ 分組穩定性驗證 · host=${HOST} · room=${ROOM} ═══`);

const ass = await conn({ role: 'assistant' });
await wait(400);
const cc = lastOf(ass.frames, '__welcome__')?.payload?.controlCode;
if (!cc) { console.error('❌ 拿不到 controlCode'); process.exit(1); }
const pre = await conn({ role: 'presenter' });

// ── 先進場 6 人 ──────────────────────────────────────────
const players = [];
for (let i = 0; i < 6; i++) players.push(await join(i, `學員${i + 1}`));
await wait(600);
let s0 = await seating();
console.log(`\n初始分組:${JSON.stringify(s0.map)}`);
check('六人都分到組別', Object.keys(s0.map).length === 6, `${Object.keys(s0.map).length} 人`);

// ── A. 遲到者陸續加入,既有成員不可以被重洗 ────────────────
console.log('\n【A. 分好組之後,遲到的人一個一個加進來】');
{
  let base = s0.map;
  for (let k = 0; k < 3; k++) {
    const late = await join(100 + k, `遲到${k + 1}`);
    players.push(late);
    const now = await seating();
    const moved = movers(base, now.map);
    check(`第 ${k + 1} 位遲到者加入後,原本的人都沒換組`, moved.length === 0, moved.join(' / ') || `新人 遲到${k + 1} → 第${now.map[`遲到${k + 1}`] + 1}組`);
    base = now.map;
  }
  const fin = await seating();
  const sizes = (fin.snap?.groups || []).map((g) => (g.members || []).length);
  check('遲到者被塞進人數較少的組(人數仍平均)',
    Math.max(...sizes) - Math.min(...sizes) <= 1, `各組人數 ${sizes.join(' / ')}`);
  s0 = fin;
}

// ── B. 接電話 / 畫面跳出去 → 回來要在原組 ─────────────────
console.log('\n【B. 有人接電話、畫面跳出去一下】');
{
  const before = (await seating()).map;
  const target = players[2];
  const back = await reconnect(target);
  players[2] = back;
  const after = (await seating()).map;
  check(`${target.name} 重連後回到原組`, after[target.name] === before[target.name],
    `原第${before[target.name] + 1}組 → 現第${(after[target.name] ?? -1) + 1}組`);
  const moved = movers(before, after);
  check('其他人一個都沒被牽動', moved.length === 0, moved.join(' / '));
  check('沒有人憑空消失或多出來',
    Object.keys(after).length === Object.keys(before).length,
    `${Object.keys(before).length} → ${Object.keys(after).length}`);
}

// ── C. 斷線期間有新人加入,原本的人回來仍要在原組 ──────────
console.log('\n【C. 斷線的期間又有新人進來(最惡劣的情況)】');
{
  const before = (await seating()).map;
  const target = players[4];
  try { target.ws.close(); } catch {}
  await wait(900);
  const late = await join(200, '插隊者');
  players.push(late);
  await wait(400);
  const back = await reconnect(target);
  players[4] = back;
  const after = (await seating()).map;
  check(`${target.name} 斷線期間有人插隊,回來仍在原組`,
    after[target.name] === before[target.name],
    `原第${before[target.name] + 1}組 → 現第${(after[target.name] ?? -1) + 1}組`);
  const moved = movers(before, after);
  check('插隊者加入沒有把任何人擠走', moved.length === 0, moved.join(' / '));
}

// ── D. 多人同時重連 ──────────────────────────────────────
console.log('\n【D. 一次好幾個人同時斷線重連(訊號不穩)】');
{
  const before = (await seating()).map;
  const batch = [players[0], players[1], players[3]];
  batch.forEach((p) => { try { p.ws.close(); } catch {} });
  await wait(1000);
  const backs = await Promise.all(batch.map(async (p) => {
    const b = await conn({ role: 'participant', deviceId: p.deviceId });
    b.deviceId = p.deviceId; b.name = p.name;
    b.send({ type: 'player_join', payload: { name: p.name } });
    return b;
  }));
  await wait(1200);
  players[0] = backs[0]; players[1] = backs[1]; players[3] = backs[2];
  const after = (await seating()).map;
  const moved = movers(before, after);
  check('三個人同時重連,沒有任何人跳組', moved.length === 0, moved.join(' / '));
  check('人數沒有變', Object.keys(after).length === Object.keys(before).length,
    `${Object.keys(before).length} → ${Object.keys(after).length}`);
}

// ── E. 改名後重連(裝置鎖) ────────────────────────────────
console.log('\n【E. 有人把名字改掉再回來(靠裝置鎖拉回原組)】');
{
  const before = (await seating()).map;
  const target = players[5];
  const oldTeam = before[target.name];
  try { target.ws.close(); } catch {}
  await wait(900);
  const renamed = await conn({ role: 'participant', deviceId: target.deviceId });
  renamed.deviceId = target.deviceId; renamed.name = target.name + '改';
  await wait(200);
  renamed.send({ type: 'player_join', payload: { name: renamed.name } });
  await wait(800);
  players[5] = renamed;
  const after = (await seating()).map;
  check('改名後仍被裝置鎖拉回原組', after[renamed.name] === oldTeam,
    `原第${oldTeam + 1}組 → 現第${(after[renamed.name] ?? -1) + 1}組`);
}

// ── F. 開賽後斷線重連 ────────────────────────────────────
console.log('\n【F. 遊戲開始之後才斷線重連】');
{
  const roster = (await seating()).snap;
  ass.send({
    type: 'game_start', controlCode: cc,
    payload: {
      mode: 'ordinary', customTiers: ['easy'], customTypes: ['multiple_choice'],
      totalQ: 5, spq: 5,
      groups: (roster?.groups || []).map((g) => ({ name: g.name })),
      rushMode: 'speed', wordGameCap: 0, groupingMode: 'random',
      timerDefaults: { word_game: 10, multiple_choice: 20, short_answer: 30, calculation: 60, essay: 180 },
    },
  });
  await until(pre, 0, 'game_start');
  await wait(700);

  const before = (await seating()).map;
  const target = players[1];
  const back = await reconnect(target);
  players[1] = back;
  const after = (await seating()).map;
  check(`開賽後 ${target.name} 重連仍在原組`, after[target.name] === before[target.name],
    `原第${before[target.name] + 1}組 → 現第${(after[target.name] ?? -1) + 1}組`);
  const moved = movers(before, after);
  check('開賽後重連不會牽動別人', moved.length === 0, moved.join(' / '));

  // 重連的人還能正常搶答(不是幽靈)
  const c = pre.cursor();
  ass.send({ type: 'start_rush', controlCode: cc });
  await until(pre, c, 'start_rush');
  await wait(ARM_COUNTDOWN_MS + 300);
  back.send({ type: 'buzz_press', payload: { ts: Date.now() } });
  const w = await until(pre, c, 'rush_winner');
  check('重連回來的人搶答有效(不是幽靈組員)',
    w?.payload?.personName === back.name, `勝方=${w?.payload?.personName} / ${w?.payload?.groupName}`);
  check('搶答判給他原本的那一組', w?.payload?.groupIdx === before[target.name],
    `判給第${(w?.payload?.groupIdx ?? -1) + 1}組,應為第${before[target.name] + 1}組`);
}

// ── G. 開賽後才進來的遲到者 ──────────────────────────────
console.log('\n【G. 遊戲已經開始,又有人才進來】');
{
  const before = (await seating()).map;
  const late = await join(300, '超級遲到');
  players.push(late);
  await wait(500);
  const after = (await seating()).map;
  const moved = movers(before, after);
  check('開賽後有人加入,現有分組完全不動', moved.length === 0, moved.join(' / '));
  check('遲到者有被分到組別', after['超級遲到'] !== undefined,
    after['超級遲到'] !== undefined ? `第${after['超級遲到'] + 1}組` : '沒分到組');
}

[ass, pre, ...players].forEach((x) => { try { x.ws.close(); } catch {} });

if (fails.length) {
  console.error(`\n❌ ${fails.length} 項未通過:`);
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✅ 分組穩定:斷線重連、改名、遲到加入、開賽前後,都沒有人被換組。');
process.exit(0);
