#!/usr/bin/env node
/**
 * verify-broadcast-route.mjs — open two WebSocket connections to the
 * same PartyKit room (assistant + presenter), have the assistant emit
 * a `mode_preview` privileged command, and verify that the presenter
 * receives the broadcast `mode_preview` event with matching payload.
 *
 * Phase 4 testing discipline #4. Validates the full path:
 *   client.send → server.onMessage → privileged check (controlCode) →
 *   dispatch → broadcast → other client.onmessage
 *
 * Pre-req: `npm run dev` is running on localhost:1999.
 *
 * Exit 0 on success; 1 otherwise.
 */

const HOST = process.env.PGG_HOST ?? 'localhost:1999';
const ROOM = process.env.PGG_ROOM ?? `verify-broadcast-${Date.now()}`;
const PARTY = 'main';
const TIMEOUT_MS = 5000;

const ASSIST_URL = `ws://${HOST}/parties/${PARTY}/${ROOM}?role=assistant`;
const PRES_URL = `ws://${HOST}/parties/${PARTY}/${ROOM}?role=presenter`;

const failures = [];
let assistant, presenter;
let assistantCode = null;
let timer;

function fail(msg) {
  failures.push(msg);
}

function done() {
  if (timer) clearTimeout(timer);
  try { assistant?.close(); } catch {}
  try { presenter?.close(); } catch {}
  if (failures.length === 0) {
    console.log(`✅ verify-broadcast-route: assistant→server→presenter path works (room=${ROOM})`);
    process.exit(0);
  }
  console.error(`❌ verify-broadcast-route: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

timer = setTimeout(() => {
  fail(`timeout after ${TIMEOUT_MS}ms`);
  done();
}, TIMEOUT_MS);

function newSocket(url, role, onWelcome, onMessage) {
  const ws = new WebSocket(url);
  ws.addEventListener('error', (e) => {
    fail(`${role} ws error: ${e.message ?? e}`);
    done();
  });
  ws.addEventListener('message', (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === '__welcome__') {
      onWelcome?.(frame.payload);
    }
    onMessage?.(frame);
  });
  return ws;
}

// The chosen test payload — pick something that's broadcast verbatim.
const SENT_PAYLOAD = {
  mode: 'paradise',
  customTiers: [],
  customTypes: [],
};

// Stage 1: open assistant, capture controlCode.
assistant = newSocket(
  ASSIST_URL,
  'assistant',
  (welcome) => {
    if (typeof welcome?.controlCode === 'string') {
      assistantCode = welcome.controlCode;
      // Open presenter only AFTER assistant is welcomed (same room
      // already exists so presenter joins cleanly).
      openPresenter();
    } else {
      fail('assistant welcome had no controlCode');
      done();
    }
  },
  null
);

let presenterReady = false;

function openPresenter() {
  presenter = newSocket(
    PRES_URL,
    'presenter',
    () => {
      presenterReady = true;
      // Once presenter is welcomed, send the privileged mode_preview from assistant.
      sendModePreview();
    },
    (frame) => {
      // Watch for the broadcast we expect.
      if (frame.type === 'mode_preview') {
        const p = frame.payload || {};
        if (p.mode !== SENT_PAYLOAD.mode) {
          fail(`presenter received mode_preview with wrong mode: ${p.mode} vs ${SENT_PAYLOAD.mode}`);
        }
        // Success path.
        done();
      }
    }
  );
}

function sendModePreview() {
  if (!presenterReady || !assistantCode) return;
  const envelope = {
    type: 'mode_preview',
    payload: SENT_PAYLOAD,
    controlCode: assistantCode,
  };
  assistant.send(JSON.stringify(envelope));
}
