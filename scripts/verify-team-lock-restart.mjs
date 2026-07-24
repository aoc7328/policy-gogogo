#!/usr/bin/env node
/**
 * 「重新開始」不得改組的回歸測試。
 * 覆蓋一般／自由分組，並確認重開後分數歸零、組別與 24h 裝置鎖保留。
 */
import { buildSync } from 'esbuild';

const built = buildSync({
  entryPoints: ['party/state.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const source = Buffer.from(built.outputFiles[0].contents).toString('base64');
const { createInitialState, restartGame, DEVICE_TEAM_TTL_MS } = await import(`data:text/javascript;base64,${source}`);

const state = createInitialState('TEST01', 'presenter-code', 'assistant-code');
state.groupingMode = 'random';
state.groups = [
  { idx: 0, name: '甲組', score: 80, members: ['甲小明'], leader: '甲小明' },
  { idx: 1, name: '乙組', score: 45, members: ['乙小華'], leader: '乙小華' },
];
state.participants.set('a', { connId: 'a', name: '甲小明', team: '甲組', joinedAt: Date.now(), deviceId: 'device-a' });
state.participants.set('b', { connId: 'b', name: '乙小華', team: '乙組', joinedAt: Date.now(), deviceId: 'device-b' });
state.deviceTeams.set('device-a', { name: '甲小明', team: '甲組', at: Date.now() });
state.deviceTeams.set('device-b', { name: '乙小華', team: '乙組', at: Date.now() });
state.currQ = 4;
state.askedQuestions = [{ id: 'E-SA-001', difficulty: 'easy', framework: 'F1' }];

restartGame(state);

const failures = [];
const same = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${label}: ${JSON.stringify(actual)}`);
};
same(state.groups.map((g) => ({ name: g.name, members: g.members, leader: g.leader })), [
  { name: '甲組', members: ['甲小明'], leader: '甲小明' },
  { name: '乙組', members: ['乙小華'], leader: '乙小華' },
], '重新開始後組別、成員或組長被改動');
same(state.groups.map((g) => g.score), [0, 0], '重新開始後分數未歸零');
same(state.participants.get('a')?.team, '甲組', '甲小明的連線組別被改動');
same(state.participants.get('b')?.team, '乙組', '乙小華的連線組別被改動');
same([...state.deviceTeams.entries()].map(([id, lock]) => [id, lock.team]), [
  ['device-a', '甲組'], ['device-b', '乙組'],
], '24 小時裝置鎖未保留');
if (DEVICE_TEAM_TTL_MS !== 24 * 60 * 60 * 1000) failures.push(`裝置鎖 TTL 不為 24 小時: ${DEVICE_TEAM_TTL_MS}`);

if (failures.length) {
  console.error('verify:team-lock-restart 失敗:');
  failures.forEach((f) => console.error(`- ${f}`));
  process.exit(1);
}
console.log('verify:team-lock-restart 通過：一般／自由分組重新開始後，原組、成員、組長與 24 小時裝置鎖均保留。');
