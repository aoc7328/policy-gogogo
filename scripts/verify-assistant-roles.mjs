#!/usr/bin/env node
/**
 * verify-assistant-roles.mjs — 多助理權限(伺服器權威的角色授權)回歸驗證。
 *
 * Pre-req: 後端 dev server 要跑著(預設 127.0.0.1:1998)。
 *   npx wrangler dev -c worker/wrangler.jsonc --port 1998
 *   node scripts/verify-assistant-roles.mjs 127.0.0.1:1998
 *
 * 驗證的規則(docs/adr/0001 + CONTEXT 定案):
 *  1. 第一個連上的助理 = 總助理(chief);其餘 = 未指派(unassigned)。
 *  2. 助理身分/角色跟著 assistantId(deviceId)走;同 deviceId 重連恢復原角色。
 *  3. 只有 chief / admin 能管理助理;光有 controlCode(所有助理都有)不夠。
 *  4. chief 可指派任何非 chief;admin 只能管四種執行助理、不能碰 chief/admin。
 *  5. 每房最多一位 admin;助理姓名不可重複;chief 身分不可被變更。
 *
 * 全部以「server 實際回覆的 __welcome__ / assistant_roster / __error__」判定,
 * 不看前端畫面 —— 權限必須是伺服器權威,不能只靠前端藏按鈕。
 */
const HOST = process.argv[2] || '127.0.0.1:1998';
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const ROOM = 'roles-' + Math.floor(Math.random() * 1e6);
const fails = [];
const log = (...a) => console.log(...a);
const ok = (cond, msg) => { if (cond) log(`  ✅ ${msg}`); else { log(`  ❌ ${msg}`); fails.push(msg); } };

function conn(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams(query)}`);
    const frames = [];
    ws.addEventListener('message', (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ } });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      ws, frames,
      send: (m) => ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    }));
    setTimeout(() => reject(new Error('connect timeout — 後端有跑嗎?')), 5000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOf = (frames, type) => [...frames].reverse().find((f) => f.type === type);
const roleOf = (roster, id) => (roster?.assistants || []).find((a) => a.id === id)?.role;
/** 某連線目前看到的最新名冊(assistant_roster 是廣播,累積在 frames)。 */
const latestRoster = (c) => lastOf(c.frames, 'assistant_roster')?.payload;
const roleSeen = (c, id) => roleOf(latestRoster(c), id);
const nameSeen = (c, id) => (latestRoster(c)?.assistants || []).find((a) => a.id === id)?.name;
/** 送一個特權指令(帶 controlCode),回傳「送出後這段時間內」收到的 frames
 *  (給錯誤判定用);名冊狀態一律另用 latestRoster() 讀最新廣播,避免 200ms
 *  切窗剛好漏接非同步廣播造成的偽失敗。 */
async function priv(c, cc, type, payload) {
  const before = c.frames.length;
  c.send({ type, payload, controlCode: cc });
  await wait(350);
  return c.frames.slice(before);
}
const errCodeIn = (frames) => lastOf(frames, '__error__')?.payload?.code;

log(`\n多助理權限驗證 @ ${HOST}  room=${ROOM}\n`);

// ── 1. 建房者 = 總助理 ────────────────────────────────────────────
const chief = await conn({ role: 'assistant', deviceId: 'A', name: '老大' });
await wait(300);
const wChief = lastOf(chief.frames, '__welcome__')?.payload;
const cc = wChief?.controlCode;
log('1) 建房者取得總助理身分');
ok(wChief?.assistantRole === 'chief', '第一個助理 welcome.assistantRole === chief');
ok(wChief?.assistantId === 'A', 'welcome.assistantId 回傳自身 deviceId');
ok(typeof cc === 'string' && cc.length === 4, '總助理拿到 controlCode');

// ── 2. 後續助理 = 未指派 ─────────────────────────────────────────
const b = await conn({ role: 'assistant', deviceId: 'B', name: '助理B' });
const c = await conn({ role: 'assistant', deviceId: 'C', name: '助理C' });
await wait(300);
log('2) 後續助理為未指派');
ok(lastOf(b.frames, '__welcome__')?.payload?.assistantRole === 'unassigned', 'B welcome.assistantRole === unassigned');
ok(lastOf(c.frames, '__welcome__')?.payload?.assistantRole === 'unassigned', 'C welcome.assistantRole === unassigned');

// ── 3. 非管理者不能管理 ──────────────────────────────────────────
log('3) 未指派助理不能指派他人');
let f = await priv(c, cc, 'assign_assistant_role', { assistantId: 'B', role: 'scorer' });
ok(errCodeIn(f) === 'forbidden', 'C(未指派)指派 → forbidden');
ok(roleSeen(chief, 'B') !== 'scorer', 'B 角色未被非管理者改動');

// ── 4. 總助理指派:B→admin、C→scorer ────────────────────────────
log('4) 總助理指派角色');
await priv(chief, cc, 'assign_assistant_role', { assistantId: 'B', role: 'admin' });
ok(roleSeen(chief, 'B') === 'admin', 'chief 把 B 設成 admin');
ok(roleSeen(b, 'B') === 'admin', 'B 端即時收到自身角色變更');
await priv(chief, cc, 'assign_assistant_role', { assistantId: 'C', role: 'scorer' });
ok(roleSeen(chief, 'C') === 'scorer', 'chief 把 C 設成 scorer');

// ── 5. admin 唯一 ───────────────────────────────────────────────
log('5) 每房最多一位管理助理');
f = await priv(chief, cc, 'assign_assistant_role', { assistantId: 'C', role: 'admin' });
ok(errCodeIn(f) === 'admin_exists', '已有 admin 時再指派第二個 → admin_exists');
ok(roleSeen(chief, 'C') === 'scorer', 'C 仍為 scorer(未被改動)');

// ── 6. chief 身分不可變更 ────────────────────────────────────────
log('6) 總助理身分固定');
f = await priv(chief, cc, 'assign_assistant_role', { assistantId: 'A', role: 'scorer' });
ok(errCodeIn(f) === 'forbidden', '連 chief 自己都不能把 chief 改成別的角色');
ok(roleSeen(chief, 'A') === 'chief', 'A 仍為 chief');

// ── 7. admin 只能管四種執行助理 ─────────────────────────────────
log('7) 管理助理的權限邊界');
await priv(b, cc, 'assign_assistant_role', { assistantId: 'C', role: 'host' });
ok(roleSeen(b, 'C') === 'host', 'admin 可改動執行助理(C scorer→host)');
f = await priv(b, cc, 'assign_assistant_role', { assistantId: 'A', role: 'scorer' });
ok(errCodeIn(f) === 'forbidden', 'admin 不能變更總助理 → forbidden');
f = await priv(b, cc, 'assign_assistant_role', { assistantId: 'C', role: 'admin' });
ok(errCodeIn(f) === 'forbidden', 'admin 不能指派「管理助理」角色 → forbidden');

// ── 8. 姓名不可重複 ─────────────────────────────────────────────
log('8) 助理姓名不可重複');
f = await priv(chief, cc, 'rename_assistant', { assistantId: 'C', name: '助理B' });
ok(errCodeIn(f) === 'rename_failed', '改成已存在的名字 → rename_failed(duplicate)');
await priv(chief, cc, 'rename_assistant', { assistantId: 'C', name: '記分手' });
ok(nameSeen(chief, 'C') === '記分手', 'chief 改名成功(唯一名字)');

// ── 9. 逐指令角色授權(onMessage 的 ROLE_PERMS gate)────────────
log('9) 逐指令角色授權(遊戲流程 vs 計分 vs 未指派)');
await priv(chief, cc, 'assign_assistant_role', { assistantId: 'C', role: 'scorer' }); // C 設回記分助理
// 遊戲流程指令 = 只有總助理
f = await priv(b, cc, 'start_rush', {});
ok(errCodeIn(f) === 'forbidden', '管理助理送 start_rush → forbidden(遊戲流程只有總助理)');
f = await priv(c, cc, 'next_question', {});
ok(errCodeIn(f) === 'forbidden', '記分助理送 next_question → forbidden');
f = await priv(c, cc, 'game_restart', {});
ok(errCodeIn(f) === 'forbidden', '記分助理送 game_restart → forbidden');
// 計分助理送 score_adjust → 通過角色 gate(pre-game 無得分會靜默 no-op,重點是「不得 forbidden」)
f = await priv(c, cc, 'score_adjust', { teamIdx: 0, delta: 1 });
ok(errCodeIn(f) !== 'forbidden', '記分助理送 score_adjust → 通過角色 gate(非 forbidden)');
// 總助理送 start_rush → 通過 gate,卡在相位(lobby)→ wrong_phase(證明 gate 有放行 chief)
f = await priv(chief, cc, 'start_rush', {});
ok(errCodeIn(f) === 'wrong_phase', '總助理送 start_rush → 通過 gate(卡相位 wrong_phase,非 forbidden)');
// 未指派助理:連計分都不行
const d = await conn({ role: 'assistant', deviceId: 'D', name: '助理D' });
await wait(250);
f = await priv(d, cc, 'score_adjust', { teamIdx: 0, delta: 1 });
ok(errCodeIn(f) === 'forbidden', '未指派助理送 score_adjust → forbidden');

// ── 9b. 請輸入姓名(set_own_name)──────────────────────────────
log('9b) 加入時自我命名');
const e = await conn({ role: 'assistant', deviceId: 'E' });   // 無 name query
await wait(250);
ok(lastOf(e.frames, '__welcome__')?.payload?.assistantName === '',
   '無名字加入的助理 welcome.assistantName === ""(前端出現「請輸入姓名」)');
f = await priv(e, cc, 'set_own_name', { name: '記分手' });    // 撞名(C 已改名為「記分手」)
ok(errCodeIn(f) === 'rename_failed', 'set_own_name 撞名 → rename_failed');
await priv(e, cc, 'set_own_name', { name: '新來的' });
ok(nameSeen(chief, 'E') === '新來的', 'set_own_name 唯一名字 → 命名成功,名冊更新');

// ── 9c. 移除助理(撤權)+ 主動轉為參賽者 ─────────────────────────
log('9c) 移除助理 / 轉為參賽者');
await priv(chief, cc, 'assign_assistant_role', { assistantId: 'E', role: 'scorer' }); // E → 執行助理
f = await priv(e, cc, 'remove_assistant', { assistantId: 'C' });   // 記分助理移除他人
ok(errCodeIn(f) === 'forbidden', '記分助理移除他人 → forbidden');
f = await priv(chief, cc, 'remove_assistant', { assistantId: 'A' }); // 移除總助理
ok(errCodeIn(f) === 'forbidden', '移除總助理 → forbidden');
await priv(chief, cc, 'remove_assistant', { assistantId: 'E' });     // 總助理撤銷 E
ok(lastOf(e.frames, '__role_revoked__')?.payload?.by === 'chief', 'E 被撤銷 → 收到 __role_revoked__(by:chief)');
ok(!(latestRoster(chief)?.assistants || []).some(a => a.id === 'E'), 'E 已從名冊移除');
await priv(c, cc, 'remove_assistant', { assistantId: 'C' });         // C 主動轉為參賽者(移除自己)
ok(lastOf(c.frames, '__role_revoked__')?.payload?.by === 'self', 'C 主動轉換 → __role_revoked__(by:self)');

// ── 9d. 分組助理巡檢:置頂 + 通知操作者紀錄 ─────────────────────
log('9d) 分組助理巡檢(前綴分組)');
await priv(chief, cc, 'grouping_mode_changed', { mode: 'prefix' });   // 切前綴分組
const pp = await conn({ role: 'participant', deviceId: 'pp1' });      // 參賽者建出「星光一」組
pp.send({ type: 'player_join', payload: { name: '星光一-小明' } });
await wait(350);
await priv(chief, cc, 'assign_assistant_role', { assistantId: 'D', role: 'grouper' });
await priv(d, cc, 'set_own_name', { name: '分組手D' });
await priv(d, cc, 'toggle_group_pin', { team: '星光一', pinned: true });
ok((lastOf(d.frames, 'group_watch')?.payload?.pinned || []).includes('星光一'),
   '分組助理置頂已存在的組 → group_watch.pinned 含該組');
await priv(d, cc, 'notify_group', { team: '星光一', kind: 'confirm' });
{
  const n = (lastOf(d.frames, 'group_watch')?.payload?.notices || [])
    .find(x => x.team === '星光一' && x.kind === 'confirm');
  ok(!!n && n.by === '分組手D', '通知操作 → group_watch.notices 記錄最近操作者(分組手D)');
}
const g = await conn({ role: 'assistant', deviceId: 'G' });   // 全新未指派
await wait(250);
f = await priv(g, cc, 'toggle_group_pin', { team: '星光一', pinned: true });
ok(errCodeIn(f) === 'forbidden', '未指派助理置頂巡檢 → forbidden');

// ── 10. 24h 重連恢復原角色 ──────────────────────────────────────
log('10) 同裝置重連恢復角色');
b.close();
await wait(300);
const b2 = await conn({ role: 'assistant', deviceId: 'B', name: '助理B' });
await wait(300);
ok(lastOf(b2.frames, '__welcome__')?.payload?.assistantRole === 'admin', 'B 以同 deviceId 重連 → 仍是 admin(非重置為未指派)');

// ── 11. 「重新開始」不得清空助理名冊 / 總助理身分(嚴重權限漏洞回歸)──
log('11) 重新開始後總助理身分與名冊保留');
await priv(chief, cc, 'game_restart', {});
await wait(400);
// 總助理仍在名冊、仍是 chief
ok(latestRoster(chief) && roleSeen(chief, 'A') === 'chief', '重新開始後 → 總助理(A)仍在名冊且仍是 chief');
// 重新開始後新連進來的助理不得變成總助理(chiefId 未被清空)
const h = await conn({ role: 'assistant', deviceId: 'H' });
await wait(300);
ok(lastOf(h.frames, '__welcome__')?.payload?.assistantRole === 'unassigned',
   '重新開始後新助理(H)= unassigned(不會因 chiefId 遺失而變總助理)');
// 總助理仍能執行特權指令(非「未指派」被擋)
f = await priv(chief, cc, 'assign_assistant_role', { assistantId: 'H', role: 'scorer' });
ok(errCodeIn(f) !== 'forbidden' && roleSeen(chief, 'H') === 'scorer', '重新開始後總助理仍可指派(權限未遺失)');

for (const x of [chief, b, c, d, e, g, h, pp, b2]) { try { x.close(); } catch { /* ignore */ } }

log('');
if (fails.length === 0) {
  log('✅ 多助理權限:全部通過');
  process.exit(0);
} else {
  log(`❌ ${fails.length} 項失敗`);
  for (const m of fails) log(`   - ${m}`);
  process.exit(1);
}
