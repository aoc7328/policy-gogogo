#!/usr/bin/env node
/**
 * verify-reload-restore.mjs — 「重載後接得回進度」的回歸測試。
 *
 * 背景(2026-07-23 三十人實戰):參賽者接完電話回來、或 iOS Safari 把背景
 * 分頁回收後重整,會落在「等待下一題」的空白畫面 —— 題目看不到、題號歸 0、
 * 倒數消失、分數是空的,要等助理推下一題才跟得上。root cause 是 server 每次
 * 連線都推了完整快照(__room_state__),但參賽者端從來沒讀 currentQuestion /
 * currQ / timerRemainingSec 這三個欄位。
 *
 * 這支測試在 jsdom 裡重演那個情境:模擬「重載後剛登入、停在集合頁」,丟一份
 * 遊戲進行中的快照進去,驗證畫面有沒有接回來。
 *
 * 不需要 dev server(純 client 邏輯,PartyBus 走 stub)。
 *   node scripts/verify-reload-restore.mjs
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

// ── 用真題庫(把 System A 的巢狀結構壓平,跟 client/bankloader.ts 同一套規則)──
const rawEasy = JSON.parse(
  readFileSync(resolve(ROOT, 'public', 'data', 'insurance-quiz-bank-easy.json'), 'utf8'),
);
const flat = [];
for (const [type, arr] of Object.entries(rawEasy.questions.easy ?? {})) {
  if (Array.isArray(arr)) arr.forEach((q) => flat.push({ ...q, type }));
}
if (flat.length === 0) {
  console.error('✗ 題庫壓平後是空的,測試前提不成立');
  process.exit(1);
}
const TARGET = flat[0];

// ── 載入 participant.html,把外部相依換成 stub ──
// PGG_HTML 可指向另一份 participant.html —— 用來確認這支測試在「修好之前」
// 的版本上真的會紅(測試通過但抓不到 bug 等於沒測)。
const HTML_PATH = process.env.PGG_HTML || resolve(ROOT, 'public', 'participant.html');
let html = readFileSync(HTML_PATH, 'utf8');
html = html.replace(
  /<script src="lib\/partybus\.js"><\/script>/,
  `<script>
window.PartyBus = {
  _ev: {},
  init() {},
  emit() {},
  on(t, cb) { (this._ev[t] = this._ev[t] || []).push(cb); },
  onStatus() {},
  getControlCode() { return 'STUB'; },
  __fire(t, p) { (this._ev[t] || []).forEach(cb => cb(p)); },
};
window.PGGBankLoader = {
  autoLoad() {
    return Promise.resolve({
      ok: true,
      banks: { easy: { questions: ${JSON.stringify(flat)} } },
      errors: [],
    });
  },
  difficultyForId(id) { return id && id[0] === 'E' ? 'easy' : null; },
};
</script>`,
);
// Clarity 是外部 CDN,測試環境不連外
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=function(){};</script>');

const vc = new VirtualConsole();          // 吞掉頁面自己的 console 噪音
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost:8123/participant.html?room=TEST01&host=127.0.0.1:1999',
  virtualConsole: vc,
});
const win = dom.window;
const doc = win.document;

await new Promise((r) => setTimeout(r, 300));   // 等 inline script + autoLoad 的 promise

// ── 重演「重載後」的起始狀態:名字已自動回填登入,停在集合頁,本機什麼都不知道 ──
win.eval(`
  G.name = '梓瑜';
  G.team = '第三組';
  G._gameStarted = false;
  G.round = 0;
  G.totalQ = 0;
  goStage('lobby');
`);
check('前置:重載後停在集合頁',
  doc.getElementById('stage-lobby')?.classList.contains('active'),
  `目前 active=${doc.querySelector('.stage.active')?.id}`);

// ── server 推快照:遊戲進行到第 3 題、倒數 120 秒、各組已有分數 ──
const snapshot = {
  phase: 'answering',
  game: { mode: 'ordinary', totalQ: 20 },
  groups: [
    { idx: 0, name: '第一組', score: 30, leader: null, members: [] },
    { idx: 1, name: '第二組', score: 50, leader: null, members: [] },
    { idx: 2, name: '第三組', score: 20, leader: null, members: ['梓瑜'] },
    { idx: 3, name: '第四組', score: 0, leader: null, members: [] },
  ],
  currQ: 3,
  totalQ: 20,
  rushMode: 'speed',
  rushModeActual: null,
  currentQuestion: { id: TARGET.id, difficulty: 'easy', framework: 'f1_insurance_basics' },
  currentCat: 'F1',
  catLocked: true,
  purgArmed: false,
  participants: [{ name: '梓瑜', team: '第三組' }],
  askedIds: [TARGET.id],
  presenterClaimed: false,
  groupingMode: 'random',
  onboardingEnabled: false,
  timerRemainingSec: 120,
  frameworks: { A: [], B: [] },
  branding: { titlePrefix: '保險知識', titleSuffix: '星攻略' },
};
win.eval(`window.PartyBus.__fire('__room_state__', ${JSON.stringify(snapshot)})`);
await new Promise((r) => setTimeout(r, 120));

// ── 驗收 ──
const qBody = doc.getElementById('q-body');
const qWait = doc.getElementById('q-wait');
const buzz = doc.getElementById('btn-buzz');

check('1. 切到遊戲頁',
  doc.getElementById('stage-game')?.classList.contains('active'),
  `目前 active=${doc.querySelector('.stage.active')?.id}`);

check('2. 題目區顯示出來',
  qBody && qBody.style.display === 'block',
  `q-body display=${qBody?.style.display}`);

check('3. 題目區有內容(不是空白等待畫面)',
  (qBody?.innerHTML || '').length > 50,
  `innerHTML 長度=${(qBody?.innerHTML || '').length}`);

check('4. 顯示的是快照指定的那一題',
  (qBody?.textContent || '').includes(TARGET.question?.slice(0, 12) ?? '###'),
  `找不到題幹片段「${TARGET.question?.slice(0, 12)}」`);

check('5. 等待畫面收起來',
  qWait && qWait.style.display === 'none',
  `q-wait display=${qWait?.style.display}`);

check('6. 題號用 server 的絕對值 03 / 20(不是本機從 0 累加的 01)',
  doc.getElementById('gs-round')?.textContent.trim() === '03 / 20',
  `實際=「${doc.getElementById('gs-round')?.textContent.trim()}」`);

const timerBox = doc.getElementById('p-timer');
const timerVal = doc.getElementById('p-timer-val');
// 120 秒會被格式化成 "2:00"(fmt: >=60 秒用 m:ss),所以比對格式而不是比大小
check('7. 倒數接回來且在跑',
  timerBox && timerBox.style.display !== 'none'
    && /^(\d+:[0-5]\d|\d+)$/.test((timerVal?.textContent || '').trim())
    && (timerVal?.textContent || '').trim() !== '0',
  `display=「${timerBox?.style.display}」val=「${timerVal?.textContent}」`);

const sbText = doc.getElementById('sb-list')?.textContent || '';
check('8. 各組分數還原',
  sbText.includes('50') && sbText.includes('30'),
  `戰況長條內容=「${sbText.slice(0, 80)}」`);

check('9. 搶答鈕維持鎖定(講好的取捨:重載回來這輪不參與)',
  buzz?.classList.contains('locked'),
  `class=「${buzz?.className}」`);

// ── 冪等性:短暫斷線重連會再收到一次快照,不能把已渲染的題目洗掉 ──
const beforeHtml = qBody?.innerHTML;
win.eval(`window.PartyBus.__fire('__room_state__', ${JSON.stringify(snapshot)})`);
await new Promise((r) => setTimeout(r, 60));
check('10. 重複收到同一份快照不會重畫題目(斷線重連不洗掉已公布的答案)',
  qBody?.innerHTML === beforeHtml,
  '題目區被重新渲染了');

// ── 換到下一題:題號要跟著 server 的 roundQ 走 ──
win.eval(`window.PartyBus.__fire('next_question', {})`);
win.eval(`window.PartyBus.__fire('question_pick', ${JSON.stringify({
  id: TARGET.id, difficulty: 'easy', framework: 'f1_insurance_basics', roundQ: 4,
})})`);
await new Promise((r) => setTimeout(r, 60));
check('11. 下一題題號跟著 server 走(04 / 20)',
  doc.getElementById('gs-round')?.textContent.trim() === '04 / 20',
  `實際=「${doc.getElementById('gs-round')?.textContent.trim()}」`);

// ── 報告 ──
console.log('\n=== 重載後接回進度 ===');
passes.forEach((p) => console.log(`  ✓ ${p}`));
failures.forEach((f) => console.log(`  ✗ ${f}`));
console.log(`\n${passes.length} passed, ${failures.length} failed`);

dom.window.close();
process.exit(failures.length > 0 ? 1 : 0);
