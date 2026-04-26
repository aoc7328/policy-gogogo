#!/usr/bin/env node
/**
 * verify-bug-fixes.mjs — targeted regression for the two Phase 4 bugs:
 *   Bug 1: participant team_rename in lobby (before game_start) gets
 *          silently dropped because state.groups is empty.
 *   Bug 2: assistant game_start command needs to broadcast game_start
 *          payload to presenter so the standby screen activates.
 *
 * Pre-req: dev server running on localhost:1999.
 *
 * Exit 0 only if BOTH bugs are gone.
 */

const HOST = 'localhost:1999';
const ROOM = `bug-fix-test-${Date.now()}`;
const URL_BASE = `ws://${HOST}/parties/main/${ROOM}`;

const failures = [];
function fail(msg) { failures.push(msg); }

// Helper: open a ws and resolve when __welcome__ arrives, returning code + ws.
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

// Helper: wait for a specific event type on a ws within timeout.
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

const assistant = await open(`${URL_BASE}?role=assistant`);
const presenter = await open(`${URL_BASE}?role=presenter`);
const participantA = await open(`${URL_BASE}?role=participant&name=Alice&team=Team1`);
const participantB = await open(`${URL_BASE}?role=participant&name=Bob&team=Team2`);

// Drain any initial __room_state__ frames so they don't shadow real events.
await new Promise((r) => setTimeout(r, 200));

// ─────────────────────────────────────────────────────────────────────
// Bug 1: rename Team1 → MyTeam BEFORE game_start
// Expectation: server broadcasts team_rename to all (incl. participantA)
// ─────────────────────────────────────────────────────────────────────
const renameAck = waitFor(participantA.ws, 'team_rename', 2000);
participantA.ws.send(JSON.stringify({
  type: 'team_rename',
  payload: { oldName: 'Team1', newName: 'MyTeam', by: 'Alice' },
}));
try {
  const echo = await renameAck;
  if (echo.payload?.newName !== 'MyTeam' || echo.payload?.oldName !== 'Team1') {
    fail(`Bug 1: team_rename echo had wrong payload: ${JSON.stringify(echo.payload)}`);
  } else {
    console.log('✅ Bug 1: pre-game team_rename echoes back to participant.');
  }
} catch (e) {
  fail(`Bug 1: team_rename never echoed back (${e.message}) — server still drops pre-game renames`);
}

// ─────────────────────────────────────────────────────────────────────
// Bug 2: assistant sends game_start; presenter must receive game_start
// ─────────────────────────────────────────────────────────────────────
const gameStartReceived = waitFor(presenter.ws, 'game_start', 2000);
assistant.ws.send(JSON.stringify({
  type: 'game_start',
  controlCode: assistant.controlCode,
  payload: {
    mode: 'ordinary',
    customTiers: [],
    customTypes: [],
    totalQ: 5,
    spq: 5,
    groups: [{ name: 'MyTeam' }, { name: 'Team2' }],
    rushMode: 'speed',
  },
}));
try {
  const evt = await gameStartReceived;
  if (evt.payload?.mode !== 'ordinary') {
    fail(`Bug 2: game_start echo had wrong mode: ${evt.payload?.mode}`);
  } else if (!Array.isArray(evt.payload?.groups) || evt.payload.groups.length !== 2) {
    fail(`Bug 2: game_start echo missing groups`);
  } else {
    console.log('✅ Bug 2: presenter receives game_start broadcast after assistant emits.');
  }
} catch (e) {
  fail(`Bug 2: presenter never received game_start (${e.message})`);
}

// Cleanup.
[assistant.ws, presenter.ws, participantA.ws, participantB.ws].forEach((s) => {
  try { s.close(); } catch {}
});

if (failures.length === 0) {
  console.log(`\n🎯 Both bug fixes verified.`);
  process.exit(0);
}
console.error(`\n❌ ${failures.length} regression(s) still present:`);
for (const f of failures) console.error(`   - ${f}`);
process.exit(1);
