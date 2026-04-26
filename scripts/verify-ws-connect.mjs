#!/usr/bin/env node
/**
 * verify-ws-connect.mjs — open one WebSocket to a running PartyKit dev
 * server, verify the protocol's welcome handshake works.
 *
 * Phase 4 testing discipline #3.
 *
 * Pre-req: `npm run dev` is running on localhost:1999.
 *
 * Checks:
 *   - WebSocket OPEN within timeout
 *   - first server frame is __welcome__
 *   - role echoed back matches the requested role
 *   - controlCode present in welcome (because role=assistant)
 *   - second frame is __room_state__ with snapshot fields populated
 *
 * Exit 0 on full pass; 1 otherwise.
 */

const HOST = process.env.PGG_HOST ?? 'localhost:1999';
const ROOM = process.env.PGG_ROOM ?? 'verify-ws-connect-test';
const PARTY = 'main';
const URL = `ws://${HOST}/parties/${PARTY}/${ROOM}?role=assistant`;
const TIMEOUT_MS = 5000;

let ws;
let timer;
const failures = [];
const seen = [];

function fail(msg) {
  failures.push(msg);
}

function done(exitCode) {
  if (timer) clearTimeout(timer);
  try { ws?.close(); } catch {}
  if (failures.length === 0) {
    console.log(`✅ verify-ws-connect: handshake OK against ${URL}`);
    console.log(`   frames received: ${seen.map((f) => f.type).join(', ')}`);
    process.exit(0);
  }
  console.error(`❌ verify-ws-connect: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`   - ${f}`);
  console.error(`   frames received before exit: ${seen.map((f) => f.type).join(', ') || '(none)'}`);
  process.exit(exitCode);
}

ws = new WebSocket(URL);

timer = setTimeout(() => {
  fail(`timeout after ${TIMEOUT_MS}ms; only got [${seen.map((f) => f.type).join(', ') || '(nothing)'}]`);
  done(1);
}, TIMEOUT_MS);

ws.addEventListener('open', () => {
  // No need to send anything; server pushes welcome + room_state on open.
});

ws.addEventListener('error', (e) => {
  fail(`ws error: ${e.message ?? e}`);
  done(1);
});

ws.addEventListener('message', (event) => {
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    fail(`non-JSON frame: ${String(event.data).slice(0, 80)}`);
    done(1);
    return;
  }
  seen.push(frame);

  if (seen.length === 1) {
    if (frame.type !== '__welcome__') {
      fail(`first frame should be __welcome__, got ${frame.type}`);
    } else {
      const p = frame.payload || {};
      if (p.role !== 'assistant') fail(`welcome.role expected 'assistant', got ${p.role}`);
      if (p.roomId !== ROOM) fail(`welcome.roomId expected '${ROOM}', got '${p.roomId}'`);
      if (typeof p.controlCode !== 'string' || p.controlCode.length !== 6) {
        fail(`welcome.controlCode should be 6-char string, got ${JSON.stringify(p.controlCode)}`);
      }
      if (typeof p.serverTime !== 'number') {
        fail(`welcome.serverTime should be number, got ${typeof p.serverTime}`);
      }
    }
  } else if (seen.length === 2) {
    if (frame.type !== '__room_state__') {
      fail(`second frame should be __room_state__, got ${frame.type}`);
    } else {
      const p = frame.payload || {};
      const required = ['phase', 'groups', 'currQ', 'rushMode', 'participants'];
      for (const k of required) {
        if (!(k in p)) fail(`room_state missing field '${k}'`);
      }
      if (p.phase !== 'lobby') fail(`fresh room phase expected 'lobby', got '${p.phase}'`);
    }
    // Got both frames; we're done.
    done(failures.length === 0 ? 0 : 1);
  }
});
