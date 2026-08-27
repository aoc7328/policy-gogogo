#!/usr/bin/env node
/**
 * verify-explanation-order.mjs — 情境選擇題「解析字母」與「正解」的一致性防線。
 *
 * 背景(2026-08-27 現場):地獄／煉獄的情境選擇題,解析是
 *   「優先序為 **B > C > A > D**。\n\n**B 最優**：…\n\n**C 次優**：…」
 * 這種形式。選項曾經被重新排列,correct 欄有跟著更新,但解析裡的字母沒有
 * —— 現場公佈答案是 B、投影解析卻在誇獎 C,學員直覺認為「答案有問題」。
 * 41 題中招(地獄 9、煉獄 32),已於同日修正。
 *
 * 這支腳本把該類錯誤變成 CI 可攔截的回歸:
 *   1. 「優先序」句的四個字母必須是 A/B/C/D 各一次
 *   2. 第一個字母(最優)必須等於該題的 correct 欄
 *   3. 四個名次標題(最優/次優/再次/最差)必須與優先序句的字母順序一致
 *   4. 每個字母都必須是該題真實存在的選項
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const RANKS = ['最優', '次優', '再次', '最差'];
const ORDER_RE = /優先序為\s*\*\*([A-D])\s*>\s*([A-D])\s*>\s*([A-D])\s*>\s*([A-D])\*\*/;

const banks = [
  { label: '地獄', file: 'public/data/insurance-quiz-bank-hell.json' },
  { label: '煉獄', file: 'public/data/insurance-quiz-bank-purgatory.json' },
  { label: '簡單', file: 'public/data/insurance-quiz-bank-easy.json' },
  { label: '普通', file: 'public/data/insurance-quiz-bank-medium.json' },
  { label: '困難', file: 'public/data/insurance-quiz-bank-hard.json' },
];

/** 把各種題庫結構攤平成題目陣列(不同難度的 questions 結構不一致)。 */
function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const v of node) flatten(v, out);
    return out;
  }
  if (typeof node.id === 'string' && (node.question || node.word)) {
    out.push(node);
    return out;
  }
  for (const v of Object.values(node)) flatten(v, out);
  return out;
}

const failures = [];
let checked = 0;

for (const bank of banks) {
  let data;
  try { data = read(bank.file); }
  catch (e) { failures.push(`${bank.label}題庫讀取失敗:${e.message}`); continue; }

  for (const q of flatten(data.questions)) {
    const ex = q.explanation || '';
    const m = ex.match(ORDER_RE);
    if (!m) continue;            // 非「優先序」型解析,不在本檢查範圍
    checked++;

    const letters = [m[1], m[2], m[3], m[4]];
    const where = `${bank.label} ${q.id}`;

    if (new Set(letters).size !== 4) {
      failures.push(`${where}: 優先序字母重複或缺漏(${letters.join('>')})`);
      continue;
    }
    if (q.correct && letters[0] !== q.correct) {
      failures.push(
        `${where}: 解析說「${letters[0]} 最優」,但 correct 欄是「${q.correct}」` +
        ` —— 現場會出現「公佈答案 ${q.correct}、解析卻誇獎 ${letters[0]}」`
      );
    }
    if (q.options && !Array.isArray(q.options)) {
      const keys = Object.keys(q.options);
      const ghost = letters.filter((l) => !keys.includes(l));
      if (ghost.length) failures.push(`${where}: 優先序引用了不存在的選項 ${ghost.join(',')}`);
    }
    for (let i = 0; i < 4; i++) {
      const re = new RegExp('\\*\\*' + letters[i] + '\\s*' + RANKS[i] + '\\*\\*');
      if (!re.test(ex)) {
        failures.push(`${where}: 優先序第 ${i + 1} 位是 ${letters[i]},但找不到「**${letters[i]} ${RANKS[i]}**」標題`);
      }
    }
  }
}

console.log(`檢查「優先序」型解析:${checked} 題`);
if (failures.length) {
  console.error(`\n❌ ${failures.length} 項不一致:`);
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✅ 解析字母與正解、選項、名次標題全部一致。');
