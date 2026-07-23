#!/usr/bin/env node
/**
 * verify-buzz-ux.mjs — 參賽者端搶答體驗的回歸測試(純 client 邏輯,不需 dev server)。
 *
 * 背景(2026-07-23 兩場實測):
 *  1. 「321」倒數期間按下去,server 一律丟棄(rush/speed.ts:
 *     `if (record.ts < session.armedAt) return;`,armedAt = 開搶 + 3800ms),
 *     但手機端當場寫「已搶答 · 等待判定」→ 長輩以為搶到了就不再按,整輪白按。
 *     這對 55 歲以上、反應本來就慢的族群最不公平。
 *  2. 沒搶到的組按搶答鈕完全沒有回饋,他們會一直按、以為手機壞了。
 *  3. 時間到沒人按時,server 隨機指定一組,投影/手機卻顯示「○○○ 搶答耗時
 *     8.000 秒」,像真的有人按 —— 現在 payload 帶 fallback:true,要改口。
 *  4. 助理中途換搶答模式後,重連的手機仍顯示舊模式(要讀頂層 rushModeActual,
 *     不是會過期的 game.rushMode)。
 *
 *   node scripts/verify-buzz-ux.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const failures = [];
const passes = [];
function check(label, cond, detail) {
  if (cond) passes.push(label);
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const rawEasy = JSON.parse(
  readFileSync(resolve(ROOT, 'public', 'data', 'insurance-quiz-bank-easy.json'), 'utf8'),
);
const flat = [];
for (const [type, arr] of Object.entries(rawEasy.questions.easy ?? {})) {
  if (Array.isArray(arr)) arr.forEach((q) => flat.push({ ...q, type }));
}

const HTML_PATH = process.env.PGG_HTML || resolve(ROOT, 'public', 'participant.html');
let html = readFileSync(HTML_PATH, 'utf8');
html = html.replace(
  /<script src="lib\/partybus\.js"><\/script>/,
  `<script>
window.__emitted = [];
window.PartyBus = {
  _ev: {},
  init() {},
  emit(t, p) { window.__emitted.push({ t, p }); return true; },
  on(t, cb) { (this._ev[t] = this._ev[t] || []).push(cb); },
  onStatus() {},
  onUndelivered() {},
  getStatus() { return 'connected'; },
  getControlCode() { return 'STUB'; },
  __fire(t, p) { (this._ev[t] || []).forEach(cb => cb(p)); },
};
window.PGGBankLoader = {
  autoLoad() { return Promise.resolve({ ok: true, banks: { easy: { questions: ${JSON.stringify(flat)} } }, errors: [] }); },
  difficultyForId(id) { return id && id[0] === 'E' ? 'easy' : null; },
};
</script>`,
);
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=function(){};</script>');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost:8123/participant.html?room=TEST01&host=127.0.0.1:1998',
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
const doc = win.document;
await new Promise((r) => setTimeout(r, 300));

const btn = () => doc.getElementById('btn-buzz');
const statusText = () => (doc.getElementById('btn-status')?.textContent || '').trim();
const warnText = () => {
  const w = doc.querySelector('.buzz-warn');
  return w ? (w.textContent || '').replace(/\s+/g, ' ').trim() : '';
};

// 進入遊戲中的基本狀態
win.eval(`
  G.name = '王秀琴';
  G.team = '第一組';
  G._gameStarted = true;
  goStage('game');
`);

// ── 0. 修正的前提:收到 start_rush 後,GO 之前按鈕必須是 locked 且
//       G.rushArmAt 指向未來。1c 的「還沒開始」提示完全靠這兩個條件。 ──
win.eval(`
  G.buzzed = false;
  G.currentQ = null;
  PartyBus.__fire('start_rush', { rushMode: 'speed', rerush: false });
`);
check('0a. 開搶後、GO 之前按鈕是 locked(不是 armed)',
  btn().classList.contains('locked') && !btn().classList.contains('armed'),
  `class = "${btn().className}"`);
check('0b. 開搶後 G.rushArmAt 指向未來(倒數中)',
  win.eval('G.rushArmAt') > win.eval('Date.now()'),
  `rushArmAt - now = ${win.eval('G.rushArmAt - Date.now()')}ms`);

// ── 1. 倒數期間搶跑 ────────────────────────────────────────────────
win.eval(`
  G.buzzed = false;
  G.rushMode = 'speed';
  G.rushArmAt = Date.now() + 3000;   // 還在倒數中
  const b = document.getElementById('btn-buzz');
  b.className = 'circ-btn buzz-btn locked';
  window.__emitted.length = 0;
  handleBuzz();
`);
check('1a. 倒數期間按下去不會送出 buzz_press',
  win.__emitted.filter((e) => e.t === 'buzz_press').length === 0,
  `實際送出 ${JSON.stringify(win.__emitted)}`);
check('1b. 倒數期間按下去不會顯示「已搶答」',
  !/已搶答/.test(statusText()),
  `btn-status = "${statusText()}"`);
// Vincent 2026-07-23 決定:倒數期間維持原始的「完全靜默」。四種搶答模式
// 共用同一段「3、2、1、GO」倒數,規則單純就是 GO 才開始;倒數中再跳提示
// 會跟投影幕上的倒數搶注意力,而且是玩家已經學會的節奏,不該再變。
check('1c. 倒數期間按下去完全靜默(不跳提示,維持原始行為)',
  warnText() === '',
  `warn = "${warnText()}"`);
check('1d. 倒數期間按下去按鈕不會被鎖成已按(還能再按)',
  win.eval('G.buzzed') === false,
  `G.buzzed = ${win.eval('G.buzzed')}`);

// ── 2. GO 之後正常搶答 ─────────────────────────────────────────────
win.eval(`
  G.buzzed = false;
  G.rushArmAt = 0;                   // GO 已到
  const b = document.getElementById('btn-buzz');
  b.className = 'circ-btn buzz-btn armed';
  window.__emitted.length = 0;
  handleBuzz();
`);
check('2a. GO 之後按下去會送出 buzz_press',
  win.__emitted.filter((e) => e.t === 'buzz_press').length === 1,
  `實際送出 ${JSON.stringify(win.__emitted)}`);
check('2b. GO 之後按下去才顯示「已搶答」',
  /已搶答/.test(statusText()),
  `btn-status = "${statusText()}"`);

// ── 3. 沒搶到的組猛按要有回饋 ──────────────────────────────────────
win.eval(`
  G.buzzed = false;
  G.rushArmAt = 0;
  G.lastWinGroup = '第二組';
  const b = document.getElementById('btn-buzz');
  b.className = 'circ-btn buzz-btn locked';
  window.__emitted.length = 0;
  handleBuzz();
`);
check('3a. locked 狀態按下去不會送出 buzz_press',
  win.__emitted.filter((e) => e.t === 'buzz_press').length === 0);
check('3b. locked 狀態按下去有文字回饋(不是完全沒反應)',
  warnText().length > 0,
  `warn = "${warnText()}"`);

// ── 4. 無人搶答(fallback)不可以顯示假秒數與假人名 ────────────────
win.eval(`
  PartyBus.__fire('rush_winner', {
    groupIdx: 0, groupName: '第一組', rushMode: 'speed',
    personName: '陳大明', elapsedMs: 8000, fallback: true,
  });
`);
const stageText = () => (doc.querySelector('.stage.active')?.textContent || '').replace(/\s+/g, ' ');
check('4a. fallback 時不顯示秒數',
  !/8\.000|8\.0 ?秒/.test(stageText()),
  stageText().slice(0, 200));
check('4b. fallback 時不顯示被系統挑中的人名',
  !/陳大明/.test(stageText()),
  stageText().slice(0, 200));
check('4c. fallback 時要講「無人搶答」',
  /無人搶答|沒有人搶答/.test(stageText()),
  stageText().slice(0, 200));

// ── 5. 快照還原搶答模式要讀頂層(不是會過期的 game.rushMode) ───────
win.eval(`
  PartyBus.__fire('__room_state__', {
    phase: 'idle',
    game: { mode: 'ordinary', totalQ: 5, rushMode: 'speed' },   // 開場時的舊值
    groups: [{ idx: 0, name: '第一組', score: 0, leader: null, members: ['王秀琴','阿明'], onlineMembers: ['王秀琴'] }],
    currQ: 0, totalQ: 5,
    rushMode: 'count', rushModeActual: 'count',                  // 助理中途改成狂點
    currentQuestion: null, currentCat: null, catLocked: false, purgArmed: false,
    participants: [{ name: '王秀琴', team: '第一組' }],
    groupingMode: 'random', timerRemainingSec: 0,
  });
`);
check('5a. 重連後顯示的是當前搶答模式(狂點奪魁),不是開場時的電光石火',
  win.eval('G.rushMode') === 'count',
  `G.rushMode = ${win.eval('G.rushMode')}`);

// ── 6. onlineMembers:名單只算真的連著的人 ────────────────────────
// ⚠ 這一項一定要在「集合頁」上驗:組員 chips 與「X 位夥伴已就位」都畫在
//   stage-lobby。之前在 stage-game 上檢查,舊版新版都綠 —— 那是假測試。
win.eval(`goStage('lobby'); renderLobby();`);
const lobbyText = () => (doc.getElementById('stage-lobby')?.textContent || '').replace(/\s+/g, ' ');
check('6a. 集合頁組員名單不含已離開的人(用 onlineMembers)',
  /王秀琴/.test(lobbyText()) && !/阿明/.test(lobbyText()),
  lobbyText().slice(0, 200));
check('6b. 集合頁人數只算在線的(1 人,不是 2 人)',
  /1 ?人/.test(lobbyText()) && !/2 ?人/.test(lobbyText()),
  lobbyText().slice(0, 200));
win.eval(`goStage('game');`);

// ── 7. 公佈答案後狀態文字不可以還寫「答題中」 ─────────────────────
// ⚠ 先把 btn-status 真的設成「答題中」(出題時的實際狀態),否則舊版也會
//   通過 —— 因為那個字根本沒被寫上去。
win.eval(`
  G.currentQ = { id: 'X', type: 'multiple_choice' };
  document.getElementById('btn-status').textContent = '答題中';
  PartyBus.__fire('reveal_answer', { id: 'X' });
`);
check('7a. 公佈答案後狀態列不再寫「答題中」',
  !/答題中/.test(statusText()),
  `btn-status = "${statusText()}"`);

// ── 結果 ──────────────────────────────────────────────────────────
for (const p of passes) console.log(`  ✓ ${p}`);
try { dom.window.close(); } catch { /* ignore */ }   // jsdom 的計時器會讓 process 掛住
if (failures.length) {
  console.error('');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n${passes.length} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`\n${passes.length} passed, 0 failed`);
process.exit(0);
