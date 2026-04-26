#!/usr/bin/env node
/**
 * One-off diagnostic: load assistant.html in jsdom, mock partybus,
 * fill the setup form, click 開始遊戲, log the resulting DOM state.
 * Find out why sw('score') isn't switching the active page.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const html = readFileSync(resolve(ROOT, 'public', 'assistant.html'), 'utf8');

// Replace the <script src="lib/partybus.js"> with a stub so jsdom doesn't try to fetch.
const stubbed = html.replace(
  /<script src="lib\/partybus\.js"><\/script>/,
  `<script>
window.PartyBus = {
  _ev: {},
  init() { console.log('[stub] PartyBus.init'); },
  emit(t, p) { console.log('[stub] emit', t); (this._ev[t] || []).forEach(cb => cb(p)); },
  on(t, cb) { (this._ev[t] = this._ev[t] || []).push(cb); },
  onStatus(cb) { cb('connected'); },
  getControlCode() { return 'STUB12'; },
};
window.PGGBankLoader = {
  autoLoad() {
    return Promise.resolve({
      ok: true,
      banks: { easy: { questions: [{ id: 'E001', topic: 'f1', type: 'multiple_choice' }] } },
      errors: [],
    });
  },
  difficultyForId(id) { return id?.[0] === 'E' ? 'easy' : null; },
};
</script>`
);
// Drop QR script too (CDN, not needed)
const stubbed2 = stubbed.replace(
  /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/,
  '<script>function QRCode() {} QRCode.CorrectLevel = { H: 0, Q: 1, M: 2, L: 3 }; window.QRCode = QRCode;</script>'
);

const dom = new JSDOM(stubbed2, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'http://localhost:3000/assistant.html',
});

const win = dom.window;
const doc = win.document;

// Wait a tick for inline script to initialize
await new Promise((r) => setTimeout(r, 200));

const peek = (expr) => { try { return win.eval(expr); } catch (e) { return `<err: ${e.message}>`; } };

console.log('--- BEFORE click 開始遊戲 ---');
console.log('  S.gameStarted:', peek('S?.gameStarted'));
console.log('  S.mode:', peek('S?.mode'));
console.log('  active page:', doc.querySelector('.page.active')?.id);
console.log('  active tab:', doc.querySelector('.tab-btn.active')?.id);
console.log('  start-btn disabled:', doc.getElementById('start-btn')?.disabled);
console.log('  tb-score disabled class:', doc.getElementById('tb-score')?.classList.contains('disabled'));
console.log('  BANK_AUTO_LOAD_READY:', peek('typeof BANK_AUTO_LOAD_READY !== "undefined" ? BANK_AUTO_LOAD_READY : "undef"'));

// Force-fill the setup so the start button enables.
console.log('\n--- filling setup ---');
win.eval(`S.mode = 'ordinary';`);
doc.getElementById('i-q').value = '5';
doc.getElementById('i-s').value = '5';
doc.getElementById('i-n').value = '4';
['gn-0','gn-1','gn-2','gn-3'].forEach((id, i) => {
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement('input');
    el.id = id;
    el.value = `第${i+1}組`;
    doc.body.appendChild(el);
  } else {
    el.value = `第${i+1}組`;
  }
});
win.eval(`BANK_AUTO_LOAD_READY = true; chk();`);

console.log('  start-btn disabled after chk:', doc.getElementById('start-btn')?.disabled);
console.log('  tb-score disabled class:', doc.getElementById('tb-score')?.classList.contains('disabled'));

// Trace startGame execution by wrapping via eval
win.eval(`
window.__origStartGame = startGame;
window.startGame = function() {
  console.log('[trace] startGame ENTRY');
  try {
    window.__origStartGame();
    console.log('[trace] startGame RETURNED');
  } catch (e) {
    console.log('[trace] startGame THREW:', e.message);
    console.log('[trace] Stack:', (e.stack || '').split('\\n').slice(0, 5).join(' | '));
  }
};
`);

console.log('\n--- clicking 開始遊戲 ---');
doc.getElementById('start-btn')?.click();

await new Promise((r) => setTimeout(r, 100));

console.log('\n--- AFTER click ---');
console.log('  S.gameStarted:', peek('S?.gameStarted'));
console.log('  S.phase:', peek('S?.phase'));
console.log('  active page:', doc.querySelector('.page.active')?.id);
console.log('  active tab:', doc.querySelector('.tab-btn.active')?.id);
console.log('  tb-score disabled class:', doc.getElementById('tb-score')?.classList.contains('disabled'));
console.log('  pg-score active class:', doc.getElementById('pg-score')?.classList.contains('active'));
console.log('  pg-setup active class:', doc.getElementById('pg-setup')?.classList.contains('active'));

dom.window.close();
process.exit(0);
