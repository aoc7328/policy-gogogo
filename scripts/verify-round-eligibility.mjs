#!/usr/bin/env node
/** Regression checks for the assistant-controlled wrong-answer flow. */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assistant = readFileSync(resolve(root, 'public/assistant.html'), 'utf8');
const server = readFileSync(resolve(root, 'party/server.ts'), 'utf8');
const protocol = readFileSync(resolve(root, 'party/protocol.ts'), 'utf8');
const countRush = readFileSync(resolve(root, 'party/rush/count.ts'), 'utf8');
const allhandsRush = readFileSync(resolve(root, 'party/rush/allhands.ts'), 'utf8');
const failures = [];
const check = (label, ok) => {
  if (ok) console.log(`✓ ${label}`);
  else failures.push(label);
};

check('Only one dynamic post-answer primary button remains',
  assistant.includes('id="btn-next"   onclick="doPrimaryAction()"') &&
  !assistant.includes('id="btn-rebuzz"') &&
  !assistant.includes('id="btn-rerush"') &&
  !assistant.includes('id="btn-skip"') &&
  !assistant.includes('id="btn-redraw"'));
check('Scored answers advance with 下一題',
  assistant.includes("afterScore('scored')") && assistant.includes("setPrimaryAction('next')"));
check('不計分 chooses re-buzz, direct category, or a fresh all-team rush from remaining eligibility',
  assistant.includes("afterScore('pass')") &&
  assistant.includes("remaining === 0 ? 'fresh_rush' : (remaining === 1 ? 'category' : 'rebuzz')") &&
  assistant.includes('enterCategoryForLastEligible') &&
  assistant.includes("PartyBus.emit('fresh_rush'") &&
  protocol.includes("type: 'fresh_rush'") &&
  server.includes('onFreshRush') &&
  server.includes("this.state.phase === 'revealed'") &&
  server.includes('Direct category selection requires exactly one eligible team'));
check('Manual re-rush preserves round lockouts',
  server.includes('if (!rerush) {') && server.includes('this.state.excludedTeams = [];'));
check('No-winner rushes have a dedicated retry state',
  protocol.includes("type: 'rush_no_winner'") && assistant.includes("PartyBus.on('rush_no_winner'") &&
  countRush.includes('if (tiedIdxs.length > 1)') && allhandsRush.includes('if (tiedTeams.length > 1)'));

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('\n5 passed, 0 failed');
