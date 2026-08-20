#!/usr/bin/env node
/**
 * verify-bank-coverage.mjs — 題庫覆蓋檢查(離線、不需連線)。
 *
 * 現場最怕的狀況:助理在九宮格點下某個分類,系統卻回「此分類已無可抽題目」,
 * 全場停在那裡等。這支在賽前就把所有組合算一遍:
 *   每個遊戲模式(普通/地獄/極樂)× 每個分類(F1–F9)× 一字千金設定,
 * 只要有任何一格是 0 題就報錯。
 *
 * server 的題庫是 build 時 bundle 進去的同一批 JSON(party/bank.ts 直接
 * import ../public/data/*.json),所以離線算等同於線上結果。
 *
 * 用法: node scripts/verify-bank-coverage.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(resolve(root, 'public', 'data', f), 'utf8'));

const FILES = {
  easy: 'insurance-quiz-bank-easy.json',
  medium: 'insurance-quiz-bank-medium.json',
  hard: 'insurance-quiz-bank-hard.json',
  hell: 'insurance-quiz-bank-hell.json',
  purgatory: 'insurance-quiz-bank-purgatory.json',
};
// 與 party/bank.ts 的 MODE_TIER_POOL 對齊
const MODE_TIER_POOL = {
  ordinary: ['easy', 'medium', 'hard'],
  hell: ['hard', 'hell', 'purgatory'],
  paradise: ['easy', 'medium', 'hard', 'hell', 'purgatory'],
};
const MODE_LABEL = { ordinary: '普通', hell: '地獄', paradise: '極樂' };

const config = read('quiz-app-config.json');
const frameworks = config.topic_frameworks.system_A_standard_9.frameworks
  .map((f, i) => ({ short: `F${i + 1}`, label: f.label }));

// 攤平成 { difficulty, type, topic } 清單。
// 兩種檔案格式,與 party/bank.ts 的 flattenSystemA / flattenSystemB 對齊:
//   system A(easy/medium/hard/hell):questions[難度][題型] = 題目陣列
//   system B(purgatory):questions = 扁平陣列,type 缺省為 'unknown'
const all = [];
for (const [diff, file] of Object.entries(FILES)) {
  const qs = read(file).questions;
  if (diff === 'purgatory') {
    if (!Array.isArray(qs)) { console.error(`❌ ${file} 的 questions 必須是扁平陣列`); process.exit(1); }
    for (const q of qs) all.push({ difficulty: diff, type: q.type ?? 'unknown', topic: q.topic });
    continue;
  }
  const byType = qs?.[diff];
  if (!byType || typeof byType !== 'object') {
    console.error(`❌ ${file} 缺少 questions.${diff}.<題型>`); process.exit(1);
  }
  for (const [type, arr] of Object.entries(byType)) {
    if (!Array.isArray(arr)) continue;
    for (const q of arr) all.push({ difficulty: diff, type, topic: q.topic });
  }
}

// 重複 id 會讓 bank.ts 在 server 啟動時直接 throw(整個後端起不來)
{
  const ids = [];
  for (const [diff, file] of Object.entries(FILES)) {
    const qs = read(file).questions;
    const list = diff === 'purgatory' ? qs : Object.values(qs?.[diff] || {}).flat();
    for (const q of list) if (q && q.id) ids.push(q.id);
  }
  const seen = new Set(), dup = new Set();
  for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); }
  if (dup.size) {
    console.error(`❌ 題庫有重複 id(server 啟動就會 throw): ${[...dup].slice(0, 5).join(', ')}`);
    process.exit(1);
  }
}
console.log(`題庫合計 ${all.length} 題\n`);

const fails = [];
const warns = [];

for (const mode of ['ordinary', 'hell', 'paradise']) {
  const pool = MODE_TIER_POOL[mode];
  // 現場預設「一字千金 = 關閉」(wordGameCap 0) → 排除 word_game 後仍要有題
  const rows = frameworks.map((fw) => {
    const inPool = all.filter((q) => pool.includes(q.difficulty) && q.topic === fw.label);
    const noWordGame = inPool.filter((q) => q.type !== 'word_game');
    return { fw, total: inPool.length, usable: noWordGame.length };
  });
  const line = rows.map((r) => `${r.fw.short}:${r.usable}`).join('  ');
  console.log(`【${MODE_LABEL[mode]}模式】${line}`);
  for (const r of rows) {
    if (r.total === 0) fails.push(`${MODE_LABEL[mode]}模式 · ${r.fw.short}(${r.fw.label}) 完全沒有題目`);
    else if (r.usable === 0) fails.push(`${MODE_LABEL[mode]}模式 · ${r.fw.short}(${r.fw.label}) 只剩一字千金題,預設關閉一字千金時抽不出來`);
    else if (r.usable < 3) warns.push(`${MODE_LABEL[mode]}模式 · ${r.fw.short}(${r.fw.label}) 只有 ${r.usable} 題,同一場多次點這格會抽完`);
  }
}

// 題目的 topic 有沒有打錯字(對不到任何一個框架 → server 永遠抽不到它)
// 煉獄題(purgatory)刻意使用另一組 framework(system_B),不在九宮格 F1–F9 裡:
// 它只能由助理按「確定煉獄」(arm_purgatory 秘技)強制觸發,正常選格不會抽到。
// 這是設計,不是缺題 —— 但若「非煉獄」的題目 topic 對不到九宮格,那就是打錯字。
const labels = new Set(frameworks.map((f) => f.label));
const purgLabels = new Set(all.filter((q) => q.difficulty === 'purgatory').map((q) => q.topic));
const orphanTopics = [...new Set(
  all.filter((q) => q.difficulty !== 'purgatory').map((q) => q.topic).filter((t) => t && !labels.has(t))
)];
const purgCount = all.filter((q) => q.difficulty === 'purgatory').length;
console.log(`\n煉獄題 ${purgCount} 題,分類為 ${[...purgLabels].join('／')}(不在九宮格內,需按「確定煉獄」才會出現)`);
if (orphanTopics.length) {
  fails.push(`有 ${orphanTopics.length} 種非煉獄題的 topic 對不到九宮格分類(這些題永遠抽不到,可能是打錯字): ${orphanTopics.slice(0, 6).join(' / ')}`);
}

if (warns.length) {
  console.log('⚠ 提醒:');
  warns.forEach((w) => console.log('  - ' + w));
  console.log('');
}
if (fails.length) {
  console.error(`❌ ${fails.length} 項會在現場卡住:`);
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('✅ 題庫覆蓋通過:三個模式的 F1–F9 都抽得出題(且不依賴一字千金)。');
