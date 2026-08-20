#!/usr/bin/env node
/**
 * verify-no-undefined-globals.mjs — 抓「用了沒宣告的變數」。
 *
 * 背景(2026-08-20):presenter.html 的 hydratePresenterFromSnapshot() 用了
 * 一個從來沒宣告的 inQuestion,整個函式一執行就丟 ReferenceError。因為它
 * 只在「投影機中途開機/重整,而且房間正在進行中」才會跑到,平常完全看不
 * 出來 —— 直到現場投影機重整後卡在待機頁,題目再也出不來。
 *
 * verify:html 只做語法解析(esbuild),語法沒錯就過,抓不到這種。這支改用
 * TypeScript 的 --checkJs 做名稱解析,把每一頁的 inline <script> 抽出來
 * 檢查有沒有解析不到的識別字。外部 <script src> 提供的全域(PartyBus 等)
 * 列在 ALLOWED 白名單裡;要新增白名單成員前,先確認它真的由某個外部檔
 * 提供,而不是打錯字。
 *
 * 用法: node scripts/verify-no-undefined-globals.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['assistant', 'presenter', 'participant', 'admin', 'report', 'testbed', 'manual'];

/** 由外部 <script src> 載入的全域,不是打錯字。 */
const ALLOWED = new Set([
  'PartyBus',        // public/lib/partybus.js
  'PGGBankLoader',   // public/lib/bankloader.js
  'QRCode',          // public/lib/qrcode.min.js
]);

const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
const work = mkdtempSync(join(tmpdir(), 'pgg-undef-'));
const failures = [];

try {
  for (const page of PAGES) {
    let html;
    try { html = readFileSync(resolve(root, 'public', `${page}.html`), 'utf8'); }
    catch { continue; }   // 頁面不存在就跳過(檔案清單有增減時不會硬壞)

    // 只取 inline、且是 JavaScript 的 <script>
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
    const chunks = [];
    let m;
    while ((m = re.exec(html))) {
      const attrs = m[1] || '';
      const type = /type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (type && !/^(text|application)\/javascript$/i.test(type) && type !== 'module') continue;
      chunks.push(m[2]);
    }
    if (!chunks.length) continue;

    const file = join(work, `${page}.js`);
    writeFileSync(file, chunks.join('\n;\n'), 'utf8');

    let out = '';
    try {
      execFileSync(process.execPath,
        [tsc, '--allowJs', '--checkJs', '--noEmit', '--target', 'es2022', '--lib', 'es2022,dom', file],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out = `${err.stdout || ''}${err.stderr || ''}`;   // tsc 有發現問題就是非 0 結束
    }

    const names = new Map();   // 名稱 → 第一次出現的行號
    for (const line of out.split('\n')) {
      const hit = /Cannot find name '([^']+)'/.exec(line);
      if (!hit) continue;
      const name = hit[1];
      if (ALLOWED.has(name)) continue;
      const at = /\((\d+),\d+\)/.exec(line)?.[1];
      if (!names.has(name)) names.set(name, at || '?');
    }

    if (names.size) {
      for (const [name, at] of names) {
        failures.push(`${page}.html — 用到沒有宣告的 ${name}(抽出後第 ${at} 行);若它由外部 script 提供,請加進 ALLOWED`);
      }
      console.log(`  ✗ ${page}.html — ${[...names.keys()].join(', ')}`);
    } else {
      console.log(`  ✓ ${page}.html`);
    }
  }
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 暫存目錄清不掉不影響判定 */ }
}

if (failures.length) {
  console.error(`\n❌ ${failures.length} 個未宣告的識別字(執行到就會丟 ReferenceError):`);
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('\n✅ 每一頁的 inline script 都沒有用到未宣告的變數。');
