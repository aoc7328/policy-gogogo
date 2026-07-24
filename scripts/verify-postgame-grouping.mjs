import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'public', 'assistant.html'), 'utf8');
const failures = [];
const check = (label, ok) => ok ? console.log(`✓ ${label}`) : failures.push(label);

check('賽後分組方式不會被進行中鎖定',
  html.includes("const locked = !!S.gameStarted && S.phase !== 'ended';"));
check('賽後切換分組方式會先安全重置回 lobby',
  html.includes("if (S.gameStarted && S.phase !== 'ended') {")
  && html.includes("if (S.phase === 'ended') _doRestartImpl(true);"));
check('再加一題按鈕不含加號', html.includes("altText: '再加一題'"));
check('助理分頁順序為計分表後接分組表',
  html.indexOf('id="tb-score"') < html.indexOf('id="tb-group"'));

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('\n4 passed, 0 failed');
