#!/usr/bin/env node
/**
 * verify-assistant-restart.mjs — 助理端「開下一場」的回歸測試。
 *
 * 實戰連續兩次卡住:上一場結束後想開第二場,「確定、開始遊戲」按不下去。
 * 原因是 chk() 用 `|| !!S.gameStarted` 判斷,而 S.gameStarted 在一場結束
 * (phase='ended')之後仍然是 true —— 但 _doEndImpl 明明解鎖了設定分頁,
 * 狀態列還寫著「可切到『設定』改分組重新開始」。UI 承諾了它做不到的事。
 *
 * 附帶盯住一個資料完整性問題:/api/game 以 game_key upsert 且
 * `finished = excluded.finished`。結束本場 recSave(true) 之後若沒有把
 * REC.key 斷開,接著按「重新開始」會用同一個 key 再存一次 finished=false,
 * 把剛收好的那一場覆寫成「未完成」。
 *
 * 不需要 dev server(純 client 邏輯,PartyBus 走 stub)。
 *   node scripts/verify-assistant-restart.mjs
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

const HTML_PATH = process.env.PGG_HTML || resolve(ROOT, 'public', 'assistant.html');
let html = readFileSync(HTML_PATH, 'utf8');

// 記下所有 emit 出去的命令,才驗得到「有沒有真的送 game_restart / game_start」
html = html.replace(
  /<script src="lib\/partybus\.js"><\/script>/,
  `<script>
window.__emits = [];
window.PartyBus = {
  _ev: {},
  init() {},
  emit(t, p) { window.__emits.push({ type: t, payload: p }); },
  on(t, cb) { (this._ev[t] = this._ev[t] || []).push(cb); },
  onStatus() {},
  getControlCode() { return 'STUB'; },
  __fire(t, p) { (this._ev[t] || []).forEach(cb => cb(p)); },
};
window.PGGBankLoader = {
  autoLoad() { return Promise.resolve({ ok: true, banks: {}, errors: [] }); },
  difficultyForId() { return null; },
};
</script>`,
);
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=function(){};</script>');
html = html.replace(
  /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/,
  '<script>function QRCode(){} QRCode.CorrectLevel={H:0,Q:1,M:2,L:3}; window.QRCode=QRCode;</script>',
);

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost:8123/assistant.html?room=TEST01&host=127.0.0.1:1999',
  virtualConsole: new VirtualConsole(),
});
const win = dom.window;
const doc = win.document;
// fetch 在 jsdom 沒有;recSave 會用到,記下呼叫內容當作「有沒有寫報告」的證據
win.eval(`
  window.__posts = [];
  window.fetch = function (url, opt) {
    try { window.__posts.push({ url: String(url), body: opt && opt.body }); } catch (e) {}
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
`);
await new Promise((r) => setTimeout(r, 300));

// ── 布置一場「已經打完」的比賽 ──
win.eval(`
  BANK_AUTO_LOAD_READY = true;
  S.mode = 'ordinary';
  S.groupingMode = 'random';
  S.gameStarted = true;
  document.getElementById('i-q').value = '20';
  document.getElementById('i-s').value = '10';
  document.getElementById('i-n').value = '4';
  S.groups = [
    { id:'GROUP 01', name:'第一組', score:30, members:['甲'] },
    { id:'GROUP 02', name:'第二組', score:50, members:['乙'] },
  ];
  REC.key = 'TEST01-1000';      // 這一場的報告 key
  REC.startedAt = 1000;
`);

// 遊戲進行中 → 開始鈕必須是鎖住的(這道保護不能被修掉)
win.eval(`setPhase('answering'); chk();`);
check('1. 遊戲進行中 → 開始鈕維持鎖定(誤按保護還在)',
  doc.getElementById('start-btn')?.disabled === true,
  `disabled=${doc.getElementById('start-btn')?.disabled}`);

// ── 按「結束本場」 ──
win.eval(`__posts.length = 0; _doEndImpl();`);
await new Promise((r) => setTimeout(r, 60));

check('2. 結束本場會把報告收檔(finished=true)',
  win.eval(`__posts.some(p => p.url.indexOf('/api/game') >= 0 && JSON.parse(p.body).finished === true)`),
  `posts=${win.eval('JSON.stringify(__posts.map(p=>p.url))')}`);
check('3. 收檔後 REC.key 斷開(避免之後被覆寫成未完成)',
  win.eval(`REC.key === null`),
  `REC.key=${win.eval('String(REC.key)')}`);

// ── 這就是實戰卡住的地方:結束後回設定頁改難度 ──
win.eval(`S.mode = 'hell'; chk();`);
check('4. 上一場結束後,開始鈕可以按(實戰卡住的點)',
  doc.getElementById('start-btn')?.disabled === false,
  `disabled=${doc.getElementById('start-btn')?.disabled}`);
check('5. 按鈕文字改成「開始新的一場」,不會讓人以為是續打同一場',
  (doc.getElementById('start-btn')?.textContent || '').includes('新的一場'),
  `文字=「${doc.getElementById('start-btn')?.textContent?.trim()}」`);
check('6. 灰掉的原因提示要收起來(按鈕根本沒灰)',
  doc.getElementById('start-hint')?.style.display === 'none',
  `display=${doc.getElementById('start-hint')?.style.display}`);

// ── 真的按下去 ──
win.eval(`__emits.length = 0; __posts.length = 0; startGame();`);
await new Promise((r) => setTimeout(r, 80));

const emits = win.eval('JSON.stringify(__emits.map(e => e.type))');
check('7. 按下去會先送 game_restart(server 只在 lobby 收 game_start)',
  win.eval(`__emits.findIndex(e => e.type === 'game_restart') >= 0`),
  `emits=${emits}`);
check('8. 而且 game_restart 排在 game_start 前面',
  win.eval(`
    (function(){
      var r = __emits.findIndex(function(e){return e.type==='game_restart';});
      var s = __emits.findIndex(function(e){return e.type==='game_start';});
      return r >= 0 && s >= 0 && r < s;
    })()
  `),
  `emits=${emits}`);
check('9. 新的一場真的開起來了',
  win.eval(`S.gameStarted === true && S.phase !== 'ended'`),
  `gameStarted=${win.eval('String(S.gameStarted)')} phase=${win.eval('String(S.phase)')}`);
check('10. 中途的重置沒有把上一場的報告覆寫成未完成',
  win.eval(`!__posts.some(p => p.url.indexOf('/api/game') >= 0 && JSON.parse(p.body).game_key === 'TEST01-1000' && JSON.parse(p.body).finished === false)`),
  '偵測到用舊 game_key 寫入 finished=false');

// ── 另一條路徑:直接按「重新開始」也要讓開始鈕自己亮回來 ──
win.eval(`
  S.gameStarted = true; setPhase('answering');
  S.mode = 'ordinary';
  document.getElementById('i-q').value = '20';
  document.getElementById('i-s').value = '10';
  document.getElementById('i-n').value = '4';
  chk();
`);
const beforeRestart = doc.getElementById('start-btn')?.disabled;
win.eval(`_doRestartImpl(true);`);
await new Promise((r) => setTimeout(r, 60));
check('11. 按「重新開始」後開始鈕自己解鎖(不必去亂動設定欄位)',
  beforeRestart === true && doc.getElementById('start-btn')?.disabled === false,
  `重置前 disabled=${beforeRestart},重置後 disabled=${doc.getElementById('start-btn')?.disabled}`);

// ── 分組表版面:三顆鈕移到第二行、且不帶符號 ──
win.eval(`S.groups = [{ id:'GROUP 01', name:'第一組', score:0, members:['胖奇'] }]; renderGroups();`);
await new Promise((r) => setTimeout(r, 60));
const hdTop = doc.querySelector('.gc-hd .gc-hd-top');
const notify = doc.querySelector('.gc-hd .gc-notify');
check('12. 組卡標頭第一行只有組號與組名',
  !!hdTop && !hdTop.querySelector('.gc-nbtn'),
  hdTop ? '第一行裡還有按鈕' : '找不到 .gc-hd-top');
check('13. 隨機平均時只保留重抽組長操作鈕',
  !!notify && notify.parentElement?.classList.contains('gc-hd')
    && notify.querySelectorAll('.gc-nbtn').length === 1,
  `找到 ${notify?.querySelectorAll('.gc-nbtn').length ?? 0} 顆`);
const btnTexts = [...(notify?.querySelectorAll('.gc-nbtn') ?? [])].map(b => b.textContent.trim());
check('14. 隨機平均的操作鈕文字正確',
  btnTexts.length === 1 && btnTexts[0] === '重抽組長',
  `文字=${JSON.stringify(btnTexts)}`);

// ══════════════════════════════════════════════════════════════════════
// 自訂房號 + 房號鎖
// 規格:房間完全還沒被用過時可以改房號;投影端已就緒 / 有人加入過 /
// 已開賽,任一成立就鎖死。狀態不明(還沒收到快照、斷線)也一律鎖住。
// ══════════════════════════════════════════════════════════════════════
const roomInput = () => doc.getElementById('room-input');
const applyBtn = () => doc.getElementById('btn-apply-room');
const regenBtn = () => doc.getElementById('btn-regen-room');
const lockHint = () => doc.getElementById('room-lock-hint');
const resetLock = () => win.eval(`
  _roomSnapSeen=false; _roomEverJoined=false; _roomPresenter=false; _roomStarted=false;
`);

// (a) 還沒收到快照 → 必須是鎖住的(fail-safe)
resetLock(); win.eval('updateRoomLock();');
check('15. 還沒收到 server 快照時,房號是鎖住的(fail-safe)',
  roomInput()?.disabled === true && applyBtn()?.disabled === true && regenBtn()?.disabled === true,
  `input=${roomInput()?.disabled} apply=${applyBtn()?.disabled} regen=${regenBtn()?.disabled}`);

// (b) 收到快照且房間是空的 → 解鎖
resetLock();
win.eval(`syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[{name:'第一組',members:[]}], participants:[] });`);
check('16. 空房間 → 可以改房號',
  roomInput()?.disabled === false && applyBtn()?.disabled === false,
  `input=${roomInput()?.disabled} hint=「${lockHint()?.textContent?.trim().slice(0, 24)}」`);

// (c) 有人加入過 → 鎖(用 groups[].members,不是線上人數)
resetLock();
win.eval(`syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[{name:'第一組',members:['胖奇']}], participants:[] });`);
check('17. 有組員(即使當下沒人在線)→ 鎖住',
  roomInput()?.disabled === true && /加入/.test(lockHint()?.textContent || ''),
  `disabled=${roomInput()?.disabled} hint=「${lockHint()?.textContent?.trim()}」`);

// (d) 斷線後人數歸零,也不能放開 —— 這是本設計最重要的一條
win.eval(`syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[{name:'第一組',members:[]}], participants:[] });`);
check('18. 有人加入過之後,即使名單暫時空了也不會解鎖(黏著)',
  roomInput()?.disabled === true,
  `disabled=${roomInput()?.disabled} hint=「${lockHint()?.textContent?.trim()}」`);

// (e) 投影端認領 → 鎖
resetLock();
win.eval(`syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[], participants:[] });`);
const unlockedBeforePresenter = roomInput()?.disabled === false;
win.eval(`PartyBus.__fire('presenter_claimed', { at: 1 });`);
check('19. 投影端一認領就鎖住(助理端有接這個廣播)',
  unlockedBeforePresenter && roomInput()?.disabled === true
    && /投影端/.test(lockHint()?.textContent || ''),
  `認領前 unlocked=${unlockedBeforePresenter} 認領後 disabled=${roomInput()?.disabled}`);

// (f) player_join 廣播 → 立刻鎖
resetLock();
win.eval(`syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[], participants:[] });`);
const unlockedBeforeJoin = roomInput()?.disabled === false;
win.eval(`PartyBus.__fire('player_join', { name:'胖奇', team:'第一組' });`);
check('20. 有人加入的廣播一到就鎖住',
  unlockedBeforeJoin && roomInput()?.disabled === true,
  `加入前 unlocked=${unlockedBeforeJoin} 加入後 disabled=${roomInput()?.disabled}`);

// (g) 已開賽 → 鎖
resetLock();
win.eval(`syncRoomLockFromSnapshot({ phase:'answering', presenterClaimed:false, groups:[], participants:[] });`);
check('21. 已開賽 → 鎖住',
  roomInput()?.disabled === true && /已開始/.test(lockHint()?.textContent || ''),
  `hint=「${lockHint()?.textContent?.trim()}」`);

// (h) 斷線 → 回到鎖住
resetLock();
win.eval(`syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[], participants:[] });`);
const unlockedBeforeDrop = roomInput()?.disabled === false;
win.eval(`updateConnectionStatus('disconnected');`);
check('22. 斷線時鎖回去(看不到房間狀態就不放行)',
  unlockedBeforeDrop && roomInput()?.disabled === true,
  `斷線前 unlocked=${unlockedBeforeDrop} 斷線後 disabled=${roomInput()?.disabled}`);

// (i) 房號格式檢核 —— 不合法不得換頁
resetLock();
win.eval(`
  syncRoomLockFromSnapshot({ phase:'lobby', presenterClaimed:false, groups:[], participants:[] });
  window.__navigated = null;
  window.gotoRoom = function(c){ window.__navigated = c; };   // 攔住真的重新載入
`);
const bad = ['', '12', '123456789', '12a4', '１２３４'];
let badBlocked = true;
for (const v of bad) {
  win.eval(`document.getElementById('room-input').value = ${JSON.stringify(v)}; applyCustomRoom();`);
  if (win.eval('window.__navigated') !== null) { badBlocked = false; break; }
}
check('23. 不合法房號(空/太短/太長/含字母/全形)一律擋下',
  badBlocked, `被放行的值=${win.eval('String(window.__navigated)')}`);

win.eval(`document.getElementById('room-input').value='0730'; applyCustomRoom();`);
check('24. 合法房號會帶著新房號重新載入',
  win.eval('window.__navigated') === '0730',
  `__navigated=${win.eval('String(window.__navigated)')}`);

// (j) 鎖住時就算硬呼叫也不能換房(按鈕熄燈之外的第二道保險)
win.eval(`
  window.__navigated = null;
  _roomEverJoined = true; updateRoomLock();
  document.getElementById('room-input').value='0731'; applyCustomRoom();
`);
check('25. 鎖住時直接呼叫 applyCustomRoom() 也換不了房',
  win.eval('window.__navigated') === null,
  `__navigated=${win.eval('String(window.__navigated)')}`);

console.log('\n=== 助理端:開下一場 + 分組表版面 + 房號鎖 ===');
passes.forEach((p) => console.log(`  ✓ ${p}`));
failures.forEach((f) => console.log(`  ✗ ${f}`));
console.log(`\n${passes.length} passed, ${failures.length} failed`);

dom.window.close();
process.exit(failures.length > 0 ? 1 : 0);
