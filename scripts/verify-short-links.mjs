/**
 * verify-short-links.mjs — 參賽者短連結(/r/:房號、/gamer/:房號)回歸檢查。
 *
 * 背景(2026-08-20 現場事故):_redirects 的 :placeholder 只代換目的地的
 * 路徑段,不代換 query string。`/r/:code /gamer?room=:code 302` 實際會把
 * 所有人 302 到字面值 "/gamer?room=:code",全部進到同一個叫 ":code" 的
 * 幽靈房 —— 控制碼永遠錯、參賽者在助理端名單上永遠不出現。
 * 修法:改用 Pages Functions 代換 + 前端房號白名單擋垃圾值。
 * 此腳本鎖住三道防線,防止任何一道被改回去。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const redirects = readFileSync(resolve(root, 'public', '_redirects'), 'utf8');
const participant = readFileSync(resolve(root, 'public', 'participant.html'), 'utf8');
const presenter = readFileSync(resolve(root, 'public', 'presenter.html'), 'utf8');
const failures = [];
const check = (label, ok) => ok ? console.log(`✓ ${label}`) : failures.push(label);

// 1. _redirects 任何規則的目的地,query string 裡不得出現 :placeholder
//    (Cloudflare Pages 不會代換,會變成字面值)。
const badRules = redirects
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .filter((line) => {
    const dest = line.split(/\s+/)[1] || '';
    const q = dest.indexOf('?');
    return q >= 0 && dest.slice(q).includes(':');
  });
check('_redirects 沒有「query string 帶 :placeholder」的規則(不會代換,是字面值)',
  badRules.length === 0);
if (badRules.length) badRules.forEach((r) => console.error(`  壞規則: ${r}`));

// 2. 短連結改由 Pages Functions 處理,兩個 route 檔都要在、都要走共用的
//    roomRedirect(302 → /gamer?room=房號)。
const fnR = resolve(root, 'functions', 'r', '[code].ts');
const fnGamer = resolve(root, 'functions', 'gamer', '[code].ts');
check('functions/r/[code].ts 存在且使用 roomRedirect',
  existsSync(fnR) && readFileSync(fnR, 'utf8').includes('roomRedirect(context.params.code)'));
check('functions/gamer/[code].ts 存在且使用 roomRedirect',
  existsSync(fnGamer) && readFileSync(fnGamer, 'utf8').includes('roomRedirect(context.params.code)'));
check('_shared.roomRedirect 會驗房號格式並 302 到 /gamer?room=',
  (() => {
    const shared = readFileSync(resolve(root, 'functions', '_shared.ts'), 'utf8');
    return shared.includes('export function roomRedirect')
      && shared.includes('/gamer?room=${encodeURIComponent(raw)}');
  })());

// 3. participant / presenter 的房號來源(query + localStorage hint)都要過
//    _validRoom 白名單 —— 像 ":code" 這種壞值一律當「沒帶房號」。
for (const [name, html] of [['participant', participant], ['presenter', presenter]]) {
  check(`${name}.html 房號經過 _validRoom 白名單`,
    html.includes("_validRoom(_PGG_QS.get('room')) || _validRoom(_readLastRoomHint())")
    && html.includes('/^[A-Za-z0-9_-]{1,32}$/'));
}

// (曾試過明確的 public/_routes.json 與 /api/r/:code 保底繞道 —— 實測證明
//  兩者對「新路由模式的邊緣暖機延遲」都沒有幫助,已移除。新路由模式部署
//  後 ~30-45 分鐘全網生效,詳見 public/_redirects 的「坑二」註解。)

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('\nverify-short-links: all passed');
