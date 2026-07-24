import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(resolve(root, 'party/server.ts'), 'utf8');
const protocol = readFileSync(resolve(root, 'party/protocol.ts'), 'utf8');
const assistant = readFileSync(resolve(root, 'public/assistant.html'), 'utf8');
const failures = [];
const check = (label, ok) => ok ? console.log(`✓ ${label}`) : failures.push(label);
const categoryStart = server.indexOf('private onCategoryConfirm');
const categoryEnd = server.indexOf('private onCategoryReset', categoryStart);
const categoryHandler = server.slice(categoryStart, categoryEnd);

check('抽題只顯示下一個回合，不消耗回合額度',
  !categoryHandler.includes('this.state.currQ = (this.state.currQ ?? 0) + 1;') &&
  categoryHandler.includes('roundQ: (this.state.currQ ?? 0) + 1'));
check('只有正式加分判定會標記本題完成',
  protocol.includes('completeRound?: boolean') &&
  assistant.includes('adj(S.pendingIdx, pts, { completeRound: true })') &&
  !assistant.includes("afterScore('pass');\n  adj"));
check('伺服器只在完成標記下推進回合',
  server.includes('payload.completeRound === true') &&
  server.includes('this.state.currQ = (this.state.currQ ?? 0) + 1;'));

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('\n3 passed, 0 failed');
