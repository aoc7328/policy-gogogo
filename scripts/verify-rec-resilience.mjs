#!/usr/bin/env node
/**
 * Regression(JSDOM): 賽後紀錄(REC)韌性 — 2026-08-27 第二場報告全空的修正。
 *   1. game_start 廣播 → REC key 採 server 時間戳 + localStorage 檢查點 +
 *      排除題種進 usedIds。
 *   2. 「重整後」(全新頁面 + 預置檢查點)收到快照 → REC 原地接回。
 *   3. REC 中斷時收到 export_result → 自動補建降級報告上傳(degraded:true)。
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawHtml = readFileSync(resolve(root, 'public/assistant.html'), 'utf8');

const failures = [];
const check = (label, ok) => { if (ok) console.log(`✓ ${label}`); else failures.push(label); };

function makeDom(preScript = '') {
  let html = rawHtml.replace(/<script src="lib\/partybus\.js"><\/script>/, `<script>
window.__fetches=[]; window.fetch=(url,opts)=>{window.__fetches.push({url:String(url),body:opts&&opts.body?String(opts.body):null});return Promise.resolve({json:()=>Promise.resolve({ok:true,sessions:[]})})};
window.PartyBus={_ev:{},init(){},emit(t,p){return true},on(t,cb){(this._ev[t]=this._ev[t]||[]).push(cb)},onStatus(){},onUndelivered(){},getControlCode(){return'STUB'},__fire(t,p){(this._ev[t]||[]).forEach(cb=>cb(p))}};
window.PGGBankLoader={autoLoad(){return Promise.resolve({ok:true,banks:{},errors:[]})},difficultyForId(){return null}};
${preScript}
</script>`);
  html = html.replace(/<script[^>]*clarity[^>]*>[\s\S]*?<\/script>/i, '<script>window.clarity=()=>{}</script>');
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/, '<script>window.QRCode=function(){};QRCode.CorrectLevel={H:0}</script>');
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/assistant.html?room=RECTEST01', virtualConsole: new VirtualConsole() });
}

const TS = 1787800000000;

// ── 1. 開賽 rekey + 檢查點 + 排除鏡射 ─────────────────────────
{
  const dom = makeDom();
  const win = dom.window;
  await new Promise((r) => setTimeout(r, 250));
  win.eval(`
    S.groups=[{name:'A',score:0,members:['a1']},{name:'B',score:0,members:['b1']}];
    recStart();
    PartyBus.__fire('game_start',{mode:'ordinary',customTiers:[],customTypes:[],totalQ:5,spq:5,
      groups:[{name:'A'},{name:'B'}],rushMode:'speed',startedAt:${TS},excludedIds:['E-MC-001','E-MC-002']});
  `);
  check('REC key 採 server 權威時間戳', win.eval('PGGRec.key') === `RECTEST01-${TS}`);
  check('localStorage 檢查點已寫入',
    (() => { try { return JSON.parse(win.localStorage.getItem('pgg_rec_v1_RECTEST01') || 'null')?.key === `RECTEST01-${TS}`; } catch { return false; } })());
  check('排除題已種進本機 usedIds(九宮格會扣掉)',
    win.eval(`S.usedIds.has('E-MC-001') && S.usedIds.has('E-MC-002') && S.usedIds.size === 2`));
  check('gameStartedAt 已同步', win.eval('S.gameStartedAt') === TS);
}

// ── 2. 重整後接回 ────────────────────────────────────────────
{
  const stored = JSON.stringify({
    key: `RECTEST01-${TS}`, startedAt: TS,
    rounds: [{ n: 1, rushMode: 'speed', rushLabel: '電光石火', groupIdx: 0, groupName: 'A', personName: 'a1', detail: '0.5 秒', elapsedMs: 500, rebuzz: false }],
    questions: [{ n: 1, id: 'E-MC-001', question: 'Q?', score: 5, scoreLabel: '100%' }],
    pendingRound: null, savedAt: Date.now(),
  });
  const dom = makeDom(`try{localStorage.setItem('pgg_rec_v1_RECTEST01', ${JSON.stringify(stored)})}catch(e){}`);
  const win = dom.window;
  await new Promise((r) => setTimeout(r, 250));
  win.eval(`PartyBus.__fire('__room_state__',{phase:'idle',gameStartedAt:${TS},game:{mode:'ordinary',customTiers:[],customTypes:[],totalQ:5,spq:5,groups:[{name:'A'},{name:'B'}],rushMode:'speed'},groups:[],participants:[],askedIds:[]});`);
  check('重整後 REC 憑 gameStartedAt 接回同一場',
    win.eval('PGGRec.key') === `RECTEST01-${TS}` &&
    win.eval('PGGRec.rounds.length') === 1 && win.eval('PGGRec.questions.length') === 1);
}

// ── 3. 檢查點不是這一場 → 不接(防誤接舊場次) ─────────────────
{
  const stored = JSON.stringify({ key: `RECTEST01-${TS - 999999}`, startedAt: TS - 999999, rounds: [], questions: [], pendingRound: null, savedAt: Date.now() });
  const dom = makeDom(`try{localStorage.setItem('pgg_rec_v1_RECTEST01', ${JSON.stringify(stored)})}catch(e){}`);
  const win = dom.window;
  await new Promise((r) => setTimeout(r, 250));
  win.eval(`PartyBus.__fire('__room_state__',{phase:'idle',gameStartedAt:${TS},game:{mode:'ordinary',customTiers:[],customTypes:[],totalQ:5,spq:5,groups:[{name:'A'}],rushMode:'speed'},groups:[],participants:[],askedIds:[]});`);
  check('檢查點時間戳對不上 → 不誤接舊場次', win.eval('PGGRec.key') === null);
}

// ── 4. 結算補建(REC 中斷 → 降級報告) ─────────────────────────
{
  const dom = makeDom();
  const win = dom.window;
  await new Promise((r) => setTimeout(r, 250));
  win.eval(`
    PartyBus.__fire('__room_state__',{phase:'idle',gameStartedAt:${TS},game:{mode:'hell',customTiers:[],customTypes:[],totalQ:3,spq:10,groups:[{name:'A'},{name:'B'}],rushMode:'speed'},groups:[],participants:[],askedIds:[]});
    window.__fetches.length = 0;
    PartyBus.__fire('export_result',{mode:'hell',modeLabel:'地獄',totalQ:3,spq:10,
      groups:[{name:'A',score:20,members:['a1'],leader:'a1',mvp:null},{name:'B',score:10,members:['b1'],leader:'b1',mvp:null}],
      sortedGroups:[],askedQuestions:[{id:'X-MC-003',difficulty:'hell',framework:'F3'},{id:'H-SA-014',difficulty:'hard',framework:'F4',replaced:true}],
      exportTime:'now'});
  `);
  await new Promise((r) => setTimeout(r, 100));
  const call = win.eval(`window.__fetches.find(f => f.url.includes('/api/game'))`);
  let body = null;
  try { body = call ? JSON.parse(call.body) : null; } catch { /* ignore */ }
  check('REC 中斷時自動補建降級報告上傳', !!body);
  check('補建報告帶 degraded 標記 + server 權威 key',
    body?.degraded === true && body?.game_key === `RECTEST01-${TS}` && body?.payload?.degraded === true);
  check('補建報告帶完整題目清單與最終分數',
    body?.payload?.questions?.length === 2 &&
    body?.payload?.questions?.[1]?.replaced === true &&
    body?.payload?.groups?.[0]?.score === 20 && body?.finished === true);
}

if (failures.length) { console.error(`\n${failures.length} failed: ${failures.join('; ')}`); process.exit(1); }
console.log('\n9 passed, 0 failed');
