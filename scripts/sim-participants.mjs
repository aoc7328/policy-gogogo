#!/usr/bin/env node
/**
 * sim-participants.mjs — 掛 N 個「真的參賽者」進指定房間,並在每次搶答
 * 開始時自動按下搶答鈕。給「用真瀏覽器開助理端做 UI 驗收」時當陪練用:
 * 助理端畫面是真的,對面也是真的連線與真的 buzz,不是假資料。
 *
 * 用法: node scripts/sim-participants.mjs <room> [host] [人數]
 *   node scripts/sim-participants.mjs uitest1234 policy-gogogo-party.aoc7328.workers.dev 2
 *
 * 收到 rush_reveal(倒數結束、開放按鈕)後才按,模擬真人反應時間。
 * Ctrl+C 或關掉行程即離開房間。
 */

const ROOM = process.argv[2];
const HOST = process.argv[3] || 'policy-gogogo-party.aoc7328.workers.dev';
const N = Number(process.argv[4] || 2);
if (!ROOM) { console.error('用法: node scripts/sim-participants.mjs <room> [host] [人數]'); process.exit(1); }
const WS = /^(127\.|localhost|\[::1\])/.test(HOST) ? 'ws' : 'wss';
const NAMES = ['模擬甲', '模擬乙', '模擬丙', '模擬丁', '模擬戊', '模擬己'];
// 與 party/rush/types.ts 的 ARM_COUNTDOWN_MS 對齊(3000 倒數 + 800 GO)
const ARM_COUNTDOWN_MS = 3800;

for (let i = 0; i < N; i++) {
  const name = NAMES[i] || `模擬${i + 1}`;
  const deviceId = `sim-${i}-${Math.floor(Math.random() * 1e6)}`;
  const ws = new WebSocket(
    `${WS}://${HOST}/parties/main/${ROOM}?${new URLSearchParams({ role: 'participant', deviceId })}`
  );
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'player_join', payload: { name } }));
    console.log(`[${name}] 已進場 (room=${ROOM})`);
  });
  ws.addEventListener('message', (e) => {
    let f; try { f = JSON.parse(e.data); } catch { return; }
    if (f.type === 'start_rush') {
      // 一定要等倒數結束(ARM_COUNTDOWN_MS = 3800:3-2-1 + GO)才按。
      // 提早按 = 搶跑,server 會「靜默作廢」(speed.ts: ts < armedAt 直接 return),
      // 沒人有效按到就會逾時判「無有效勝者」—— 這是設計行為,不是壞掉。
      const delay = ARM_COUNTDOWN_MS + 400 + i * 250 + Math.floor(Math.random() * 300);
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({ type: 'buzz_press', payload: { ts: Date.now() } }));
          console.log(`[${name}] 按下搶答 (+${delay}ms)`);
        } catch {}
      }, delay);
    }
    if (f.type === 'rush_winner') console.log(`   → 勝方: ${f.payload?.groupName} / ${f.payload?.personName || ''}`);
    if (f.type === 'question_pick') console.log(`   → 抽到題: ${f.payload?.difficulty} / ${f.payload?.framework}`);
    if (f.type === 'export_result') console.log('   → 收到結算');
  });
  ws.addEventListener('close', () => console.log(`[${name}] 離線`));
  ws.addEventListener('error', (err) => console.error(`[${name}] 錯誤`, err?.message || err));
}

console.log(`模擬 ${N} 位參賽者連線中… (Ctrl+C 結束)`);
setInterval(() => {}, 1 << 30);   // 保持行程存活
