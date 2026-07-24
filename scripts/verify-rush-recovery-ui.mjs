#!/usr/bin/env node
/** Regression: a no-winner rush must enable only the recovery control. */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(resolve(root, 'public/assistant.html'), 'utf8');
html = html.replace(/<script src="lib\/partybus\.js"><\/script>/, `<script>
window.__emits=[]; window.PartyBus={_ev:{},init(){},emit(t,p){window.__emits.push({t,p})},on(t,cb){(this._ev[t]=this._ev[t]||[]).push(cb)},onStatus(){},getControlCode(){return'STUB'},__fire(t,p){(this._ev[t]||[]).forEach(cb=>cb(p))}};
window.PGGBankLoader={autoLoad(){return Promise.resolve({ok:true,banks:{},errors:[]})},difficultyForId(){return null}};
</script>`);
html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=()=>{}</script>');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/, '<script>window.QRCode=function(){};QRCode.CorrectLevel={H:0}</script>');
const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/assistant.html?room=RECOVERY01', virtualConsole:new VirtualConsole() });
const win = dom.window;
const doc = win.document;
await new Promise((resolve) => setTimeout(resolve, 250));
win.eval(`S.groups=[{name:'A',score:0,members:[]},{name:'B',score:0,members:[]}]; PartyBus.__fire('rush_no_winner',{reason:'timeout',rushMode:'speed'});`);
const left = doc.getElementById('btn-rush');
const right = doc.getElementById('btn-next');
const failures = [];
function check(label, ok) { if (ok) console.log(`✓ ${label}`); else failures.push(label); }
check('Recovery control is the only enabled control', left && !left.disabled && right && right.disabled);
check('Recovery control uses retry wording', /重新搶答/.test(left?.textContent || ''));
check('Recovery control has its own visual class', left?.classList.contains('recovery'));
if (failures.length) { console.error(`\n${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log('\n3 passed, 0 failed');
