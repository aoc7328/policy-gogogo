import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(resolve(root, 'party', 'server.ts'), 'utf8');
const presenter = readFileSync(resolve(root, 'public', 'presenter.html'), 'utf8');
const participant = readFileSync(resolve(root, 'public', 'participant.html'), 'utf8');
const failures = [];
const check = (label, ok) => ok ? console.log(`✓ ${label}`) : failures.push(label);

const exportStart = server.indexOf('private onExportResult()');
const exportEnd = server.indexOf('// ─────────────────────────────────────────────────────────────────────────────', exportStart);
const exportHandler = server.slice(exportStart, exportEnd);

check('結束本場會廣播倒數歸零',
  exportHandler.includes('this.state.timerDeadline = null;')
  && exportHandler.includes("type: 'timer_update', payload: { remainingSec: 0 }"));
check('投影端可中止已排程的警報音效',
  presenter.includes('stop() {')
  && presenter.includes('master.gain.setValueAtTime(0.0001, t);')
  && presenter.includes('PGGSound.stop();'));
check('結果提示不再提供 X 或背景關閉出口',
  !participant.includes('rm-close" onclick="closeResultModal()"')
  && !participant.includes('rm-backdrop" onclick="closeResultModal()"'));

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('\n3 passed, 0 failed');
