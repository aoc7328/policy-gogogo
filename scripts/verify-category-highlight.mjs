#!/usr/bin/env node
/** Regression: a new category preview must replace—not accompany—an old lock. */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(resolve(root, 'public/presenter.html'), 'utf8');
html = html.replace(/<script src="lib\/partybus\.js"><\/script>/, `<script>
window.PartyBus={_ev:{},init(){},emit(){},on(t,cb){(this._ev[t]=this._ev[t]||[]).push(cb)},onStatus(){},getControlCode(){return 'STUB'}};
window.PGGBankLoader={autoLoad(){return Promise.resolve({ok:true,banks:{},errors:[]})},difficultyForId(){return null}};
</script>`);
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=()=>{}</script>');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/, '<script>window.QRCode=function(){};QRCode.CorrectLevel={H:0}</script>');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/presenter.html?room=HIGHLIGHT01', virtualConsole: new VirtualConsole() });
const win = dom.window;
const doc = win.document;
await new Promise((resolve) => setTimeout(resolve, 250));

// Mimics a missed transition / reconnect: the screen still has last round's lock,
// then receives the authoritative preview for the current selection.
win.eval(`lockCategory('F4'); clearTimeout(categoryLockTimer); categoryLockTimer=null; previewCategory('F6');`);
const marked = [...doc.querySelectorAll('.cat-card.locked,.cat-card.preview')];
const labels = marked.map((card) => `${card.dataset.fid}:${card.classList.contains('locked') ? 'locked' : 'preview'}`).join(', ');
if (marked.length !== 1 || marked[0]?.dataset.fid !== 'F6' || !marked[0].classList.contains('preview')) {
  console.error(`雙亮防呆失敗：${labels || '沒有高亮'}`);
  process.exit(1);
}
console.log('九宮格高亮通過：新預覽 F6 已取代舊鎖定，畫面只有一格亮起。');
