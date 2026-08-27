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

// 2026-08-27 現場事故:count/allhands 在平手/無人按時,lockWinner 先設
// winnerLocked 才呼叫 noWinner() —— noWinner 的防重入檢查直接 return,
// rush_no_winner 永遠發不出去,房間卡死在 rushing。修正後 winnerLocked
// 必須出現在 noWinner 呼叫「之後」(只有真的選出勝者才鎖)。
const lockAfterNoWinner = (src, label) => {
  const noWinnerIdx = src.indexOf('noWinner(ctx.state');
  const lockIdx = src.indexOf('session.winnerLocked = true');
  check(`${label}: winnerLocked set only after no-winner branches`,
    noWinnerIdx > 0 && lockIdx > noWinnerIdx);
};
lockAfterNoWinner(countRush, 'count');
lockAfterNoWinner(allhandsRush, 'allhands');
check('Presenter and participant render rush_no_winner (no more frozen buzz screen)',
  readFileSync(resolve(root, 'public/presenter.html'), 'utf8').includes("PartyBus.on('rush_no_winner'") &&
  readFileSync(resolve(root, 'public/participant.html'), 'utf8').includes("PartyBus.on('rush_no_winner'"));

// 不計分後的重新搶答改為「換新題」:server 必須棄置原題(答案已公佈),
// 助理端不得再走 resume_question 回到同一題。
check('rebuzz_same discards the revealed question server-side',
  /onRebuzzSame[\s\S]*?discardCurrentQuestion[\s\S]*?rushStart/.test(server) &&
  !server.includes('rebuzzPending = true'));
check('Assistant no longer resumes the old question after a re-buzz win',
  !assistant.includes("PartyBus.emit('resume_question'") &&
  !protocol.includes("type: 'resume_question'"));

// 回合恢復控制:rushing/won/picking 左鈕可按(搶答卡住的逃生口),
// 「重新這一次」「重新這一輪」存在且接上 server 指令。
check('Left round control stays usable during rushing/won/picking',
  /rushing:\s*\{\s*rush:1/.test(assistant) &&
  /won:\s*\{\s*rush:1/.test(assistant) &&
  /picking:\s*\{\s*rush:1/.test(assistant) &&
  assistant.includes('function doRoundControl'));
check('重新這一次 / 重新這一輪 controls exist and reach the server',
  assistant.includes('id="btn-reset-attempt"') &&
  assistant.includes('id="btn-reset-round"') &&
  assistant.includes("emitOrWarn('round_reset'") &&
  protocol.includes("type: 'round_reset'") &&
  server.includes('onRoundReset'));
check('start_rush rerush is accepted from answering/revealed (attempt reset)',
  server.includes("['idle', 'rushing', 'won', 'picking', 'answering', 'revealed']"));
check('round_reset listeners reset all three clients without advancing the round',
  assistant.includes("PartyBus.on('round_reset'") &&
  readFileSync(resolve(root, 'public/presenter.html'), 'utf8').includes("PartyBus.on('round_reset'") &&
  readFileSync(resolve(root, 'public/participant.html'), 'utf8').includes("PartyBus.on('round_reset'"));

if (failures.length) {
  console.error(`\n${failures.length} regression check(s) failed:`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('\n13 passed, 0 failed');
