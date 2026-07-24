#!/usr/bin/env node
/** Regression: group controls must be mode-specific and cannot visually mislead staff. */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(resolve(root, 'public/assistant.html'), 'utf8');
html = html.replace(/<script src="lib\/partybus\.js"><\/script>/, `<script>
window.__emits=[]; window.PartyBus={_ev:{},init(){},emit(t,p){window.__emits.push({t,p})},on(t,cb){(this._ev[t]=this._ev[t]||[]).push(cb)},onStatus(){},getControlCode(){return'STUB'}};
window.PGGBankLoader={autoLoad(){return Promise.resolve({ok:true,banks:{},errors:[]})},difficultyForId(){return null}};
</script>`);
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=()=>{}</script>');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/, '<script>window.QRCode=function(){};QRCode.CorrectLevel={H:0}</script>');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/assistant.html?room=GROUP01', virtualConsole: new VirtualConsole() });
const win = dom.window;
const doc = win.document;
await new Promise((resolve) => setTimeout(resolve, 250));
const failures = [];
const check = (label, ok) => { if (ok) console.log(`✓ ${label}`); else failures.push(label); };

check('分組方式名稱為隨機平均／前綴分組',
  doc.querySelector('[data-gmode="random"]')?.textContent?.trim() === '隨機平均'
  && doc.querySelector('[data-gmode="prefix"]')?.textContent?.trim() === '前綴分組');

win.eval(`S.gameStarted=false; S.leaders={}; S.groups=[{id:'GROUP 01',name:'甲組',score:0,members:['小明']}]; S.groupingMode='random'; renderGroups(); updateLobbyOnlyControls();`);
check('隨機平均：全域重新分組亮起可按', !doc.getElementById('regroup-btn')?.disabled);
check('隨機平均：各組不顯示前綴通知', !doc.querySelector('#group-grid .gc-notify')?.textContent?.includes('通知改名') && !doc.querySelector('#group-grid .gc-notify')?.textContent?.includes('確認前綴'));
check('隨機平均：各組仍可重抽組長', doc.querySelector('#group-grid .gc-notify')?.textContent?.includes('重抽組長'));

win.eval(`S.groupingMode='prefix'; renderGroups(); updateLobbyOnlyControls();`);
check('前綴分組：全域重新分組熄燈不可按', !!doc.getElementById('regroup-btn')?.disabled);
check('前綴分組：顯示通知改名', doc.querySelector('#group-grid .gc-notify')?.textContent?.includes('通知改名'));
check('前綴分組：軟性按鈕改名為確認前綴', doc.querySelector('#group-grid .gc-notify')?.textContent?.includes('確認前綴'));

if (failures.length) { console.error(`\n${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log('\n7 passed, 0 failed');
