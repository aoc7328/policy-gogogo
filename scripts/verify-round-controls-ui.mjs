#!/usr/bin/env node
/**
 * Regression: mid-round recovery controls (2026-08-27 現場事故修正).
 *   1. rushing 階段左鈕必須是可按的藍色「重新搶答」(搶答判定卡住的逃生口),
 *      「重新這一次」「重新這一輪」也要解鎖。
 *   2. won 階段同樣保留左鈕重新搶答。
 *   3. round_reset 事件把助理端拉回 idle:左鈕回「開始搶答」、重置鈕鎖住、
 *      本輪失格名單清空。
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(resolve(root, 'public/assistant.html'), 'utf8');
html = html.replace(/<script src="lib\/partybus\.js"><\/script>/, `<script>
window.__emits=[]; window.PartyBus={_ev:{},init(){},emit(t,p){window.__emits.push({t,p})},on(t,cb){(this._ev[t]=this._ev[t]||[]).push(cb)},onStatus(){},onUndelivered(){},getControlCode(){return'STUB'},__fire(t,p){(this._ev[t]||[]).forEach(cb=>cb(p))}};
window.PGGBankLoader={autoLoad(){return Promise.resolve({ok:true,banks:{},errors:[]})},difficultyForId(){return null}};
</script>`);
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=()=>{}</script>');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/, '<script>window.QRCode=function(){};QRCode.CorrectLevel={H:0}</script>');
const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/assistant.html?room=ROUNDCTL01', virtualConsole:new VirtualConsole() });
const win = dom.window;
const doc = win.document;
await new Promise((r) => setTimeout(r, 250));

const failures = [];
function check(label, ok) { if (ok) console.log(`✓ ${label}`); else failures.push(label); }
const btn = (id) => doc.getElementById(id);

win.eval(`
  S.groups=[{name:'A',score:0,members:['a1']},{name:'B',score:0,members:['b1']}];
  S.gameStarted=true;
  PartyBus.__fire('start_rush',{rushMode:'speed'});
`);
check('rushing: left control enabled as recovery 重新搶答',
  !btn('btn-rush').disabled && /重新搶答/.test(btn('btn-rush').textContent) &&
  btn('btn-rush').classList.contains('recovery'));
check('rushing: 重新這一次 / 重新這一輪 both enabled',
  !btn('btn-reset-attempt').disabled && !btn('btn-reset-round').disabled);

win.eval(`PartyBus.__fire('rush_winner',{groupIdx:0,groupName:'A',rushMode:'speed',personName:'a1',elapsedMs:123});`);
check('won: left control still offers 重新搶答',
  win.eval('S.phase') === 'won' &&
  !btn('btn-rush').disabled && /重新搶答/.test(btn('btn-rush').textContent));

win.eval(`S.excludedTeams=[0]; S.lastBuzzWinnerTeam=0; PartyBus.__fire('round_reset',{});`);
check('round_reset: back to idle with 開始搶答',
  win.eval('S.phase') === 'idle' &&
  !btn('btn-rush').disabled && /開始搶答/.test(btn('btn-rush').textContent) &&
  !btn('btn-rush').classList.contains('recovery'));
check('round_reset: reset controls locked again',
  btn('btn-reset-attempt').disabled && btn('btn-reset-round').disabled);
check('round_reset: eligibility restored locally',
  win.eval('S.excludedTeams.length') === 0 && win.eval('S.lastBuzzWinnerTeam') === null);

if (failures.length) { console.error(`\n${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log('\n6 passed, 0 failed');
