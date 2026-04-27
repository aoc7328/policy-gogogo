#!/usr/bin/env node
/**
 * verify-rush-flow.mjs — regression for the Phase 4 round-2 bugs:
 *   Bug 1a: re-rush from picking phase must succeed (server previously
 *           rejected it — only allowed idle/won).
 *   Bug 1c: game_restart command must broadcast game_restart event to
 *           ALL clients (presenter + participant), not just assistant.
 *
 * Pre-req: dev server on localhost:1999 (or override via PGG_HOST).
 */

const HOST = process.env.PGG_HOST ?? 'localhost:1999';
const ROOM = `verify-rush-flow-${Date.now()}`;
const URL_BASE = `ws://${HOST}/parties/main/${ROOM}`;
const failures = [];
function fail(msg) { failures.push(msg); }

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('open timeout')), 3000);
    ws.addEventListener('error', (e) => reject(e));
    ws.addEventListener('message', (event) => {
      const f = JSON.parse(event.data);
      if (f.type === '__welcome__') {
        clearTimeout(t);
        resolve({ ws, controlCode: f.payload.controlCode ?? null });
      }
    });
  });
}
function waitFor(ws, type, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    function listener(event) {
      const f = JSON.parse(event.data);
      if (f.type === type) {
        clearTimeout(t);
        ws.removeEventListener('message', listener);
        resolve(f);
      }
    }
    ws.addEventListener('message', listener);
  });
}
function send(ws, type, payload, controlCode) {
  const env = { type, payload };
  if (controlCode) env.controlCode = controlCode;
  ws.send(JSON.stringify(env));
}

const assistant = await open(`${URL_BASE}?role=assistant`);
const presenter = await open(`${URL_BASE}?role=presenter`);
const participant = await open(`${URL_BASE}?role=participant&name=Alice&team=Team1`);
await new Promise((r) => setTimeout(r, 200));

// Setup: start game so phase becomes 'idle' (not 'lobby')
const gameStartEcho = waitFor(presenter.ws, 'game_start', 2000);
send(assistant.ws, 'game_start', {
  mode: 'ordinary',
  customTiers: [],
  customTypes: [],
  totalQ: 5,
  spq: 5,
  groups: [{ name: 'Team1' }, { name: 'Team2' }],
  rushMode: 'speed',
}, assistant.controlCode);
await gameStartEcho;

// ─── Bug 1a: re-rush from picking phase ───────────────────────────
// 1. start_rush → phase becomes 'rushing'
const startRushEcho = waitFor(presenter.ws, 'start_rush', 2000);
send(assistant.ws, 'start_rush', {}, assistant.controlCode);
await startRushEcho;

// 2. participant buzzes → server emits rush_winner → phase 'won'
const winnerEcho = waitFor(presenter.ws, 'rush_winner', 5000);
// wait past 3s armed window then buzz
await new Promise((r) => setTimeout(r, 3300));
send(participant.ws, 'buzz_press', { name: 'Alice', team: 'Team1', ts: Date.now() });
await winnerEcho;

// 3. assistant transitions to picking
const enterCatEcho = waitFor(presenter.ws, 'enter_category', 2000);
send(assistant.ws, 'enter_category', {}, assistant.controlCode);
await enterCatEcho;
// Now phase = 'picking'

// 4. assistant tries re-rush from picking phase. Server should accept.
try {
  const rerushEcho = waitFor(presenter.ws, 'start_rush', 1500);
  send(assistant.ws, 'start_rush', { rerush: true }, assistant.controlCode);
  const evt = await rerushEcho;
  if (evt.payload?.rerush !== true) {
    fail(`Bug 1a: re-rush echo missing rerush:true flag: ${JSON.stringify(evt.payload)}`);
  } else {
    console.log('✅ Bug 1a: re-rush from picking phase accepted by server.');
  }
} catch (e) {
  fail(`Bug 1a: re-rush from picking silently rejected (${e.message}) — server still ` +
       `restricts onStartRush to idle/won only`);
}

// ─── Bug 1c: game_restart broadcast to all clients ─────────────────
const restartPresenter = waitFor(presenter.ws, 'game_restart', 1500);
const restartParticipant = waitFor(participant.ws, 'game_restart', 1500);
const restartAssistant = waitFor(assistant.ws, 'game_restart', 1500);
send(assistant.ws, 'game_restart', {}, assistant.controlCode);
const results = await Promise.allSettled([restartPresenter, restartParticipant, restartAssistant]);
const labels = ['presenter', 'participant', 'assistant'];
const missing = results.map((r, i) => r.status === 'rejected' ? labels[i] : null).filter(Boolean);
if (missing.length === 0) {
  console.log('✅ Bug 1c: game_restart broadcast received by all 3 client roles.');
} else {
  fail(`Bug 1c: game_restart NOT received by: ${missing.join(', ')}`);
}

// Cleanup
[assistant.ws, presenter.ws, participant.ws].forEach((s) => { try { s.close(); } catch {} });

if (failures.length === 0) {
  console.log('\n🎯 Round-2 rush-flow regressions all pass.');
  process.exit(0);
}
console.error(`\n❌ ${failures.length} failure(s):`);
for (const f of failures) console.error(`   - ${f}`);
process.exit(1);
