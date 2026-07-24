import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/assistant.html', import.meta.url), 'utf8');
if (/onclick="selectTeam\(/.test(source) || /function selectTeam\(/.test(source)) {
  throw new Error('隊伍卡仍可切換答題隊，選題中可能清掉加分判定對象');
}
const scoreButtons = source.match(/onclick="event\.stopPropagation\(\);adj\(\$\{i\},(?:1|-1)\)"/g) || [];
if (scoreButtons.length !== 2) {
  throw new Error('隊伍卡只讀時，+1 / -1 必須仍可獨立點擊');
}

console.log('計分卡鎖定通過：整張隊伍卡不可切換答題隊，+1 / -1 仍可獨立點擊。');
