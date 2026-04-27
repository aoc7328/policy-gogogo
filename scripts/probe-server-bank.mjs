#!/usr/bin/env node
/**
 * probe-server-bank.mjs — figure out whether the running PartyKit dev
 * server has the real BANK or the fixture, by emitting category_confirm
 * commands across all 9 frameworks (F1–F9) and recording for each:
 *   - succeeded with question_pick     → server has questions for that fwk
 *   - failed with framework_not_in_bank → server has 0 questions for that fwk
 *   - failed with pool_empty           → has but exhausted (irrelevant fresh)
 *   - timeout                          → server didn't respond (broken)
 *
 * Compares to the JSON files in /public/data/ to compute expected counts,
 * then prints a discrepancy report.
 *
 * Pre-req: dev server running. Pass PGG_HOST=localhost:9988 if needed.
 */
import { readFileSync } from 'node:fs';

const HOST = process.env.PGG_HOST ?? 'localhost:1999';
const PARTY = 'main';

// 1) Parse local JSON to compute expected per-framework counts (any tier).
const DIFFS = ['easy', 'medium', 'hard', 'hell', 'purgatory'];
const TYPES_A = ['short_answer', 'multiple_choice', 'essay', 'calculation', 'word_game'];
const FW_BY_SHORT = {
  F1: 'f1_insurance_basics', F2: 'f2_contract_terms', F3: 'f3_underwriting',
  F4: 'f4_claims', F5: 'f5_product_planning', F6: 'f6_actuarial',
  F7: 'f7_wealth_tax', F8: 'f8_ethics_compliance', F9: 'f9_premium_calc',
  L1: 'l1_cross_dept', L2: 'l2_customer', L3: 'l3_ethics', L4: 'l4_time_scale',
};

const localCount = {};   // fwId → count across ALL difficulties
for (const d of DIFFS) {
  const path = `public/data/insurance-quiz-bank-${d}.json`;
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { console.error(`Cannot read ${path}: ${e.message}`); continue; }
  const buckets = d === 'purgatory'
    ? [data.questions || []]
    : TYPES_A.map((t) => data.questions?.[d]?.[t] || []);
  for (const arr of buckets) {
    for (const q of arr) {
      if (!q?.topic) continue;
      localCount[q.topic] = (localCount[q.topic] || 0) + 1;
    }
  }
}

// 2) Connect to server, drive game flow, probe each F1-F9 + L1-L4.
const ROOM = `bank-probe-${Date.now()}`;
const URL_BASE = `ws://${HOST}/parties/${PARTY}/${ROOM}`;

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('open timeout')), 3000);
    ws.addEventListener('error', (e) => reject(e));
    ws.addEventListener('message', (event) => {
      const f = JSON.parse(event.data);
      if (f.type === '__welcome__') {
        clearTimeout(t);
        resolve({ ws, code: f.payload.controlCode });
      }
    });
  });
}
function send(ws, type, payload, code) {
  const env = { type, payload };
  if (code) env.controlCode = code;
  ws.send(JSON.stringify(env));
}
function waitForOneOf(ws, types, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${types.join('|')}`)), timeoutMs);
    function listener(event) {
      const f = JSON.parse(event.data);
      if (types.includes(f.type)) {
        clearTimeout(t);
        ws.removeEventListener('message', listener);
        resolve(f);
      }
    }
    ws.addEventListener('message', listener);
  });
}

const a = await open(`${URL_BASE}?role=assistant`);
const p = await open(`${URL_BASE}?role=participant&name=Bot&team=T1`);
await new Promise((r) => setTimeout(r, 200));

// Use 'paradise' mode so tier pool covers all 5 difficulties (max coverage).
send(a.ws, 'game_start', {
  mode: 'paradise', customTiers: [], customTypes: [],
  totalQ: 50, spq: 5,
  groups: [{ name: 'T1' }, { name: 'T2' }],
  rushMode: 'speed',
}, a.code);
await waitForOneOf(a.ws, ['game_start']);

// For each F* + L*, do a fresh round: start_rush → buzz → enter_category → category_confirm
const probeFws = ['F1','F2','F3','F4','F5','F6','F7','F8','F9','L1','L2','L3','L4'];
const serverResults = {};

for (const shortId of probeFws) {
  // Fresh round
  send(a.ws, 'start_rush', {}, a.code);
  await waitForOneOf(a.ws, ['start_rush']);
  await new Promise((r) => setTimeout(r, 3300));
  send(p.ws, 'buzz_press', { name: 'Bot', team: 'T1', ts: Date.now() });
  await waitForOneOf(a.ws, ['rush_winner']);
  send(a.ws, 'enter_category', {}, a.code);
  await waitForOneOf(a.ws, ['enter_category']);
  send(a.ws, 'category_confirm', { fid: shortId }, a.code);
  try {
    const result = await waitForOneOf(a.ws, ['question_pick', '__error__'], 1500);
    if (result.type === 'question_pick') {
      serverResults[shortId] = { ok: true, id: result.payload.id, framework: result.payload.framework };
      // skip to next: emit reveal + next so we're back to idle
      send(a.ws, 'reveal_answer', {}, a.code);
      await waitForOneOf(a.ws, ['reveal_answer']);
      send(a.ws, 'next_question', {}, a.code);
      await waitForOneOf(a.ws, ['next_question']);
    } else {
      serverResults[shortId] = {
        ok: false,
        code: result.payload?.code,
        message: result.payload?.message,
      };
      // Server didn't lock anything; reset cat picker for next round
      send(a.ws, 'category_reset', {}, a.code);
      await waitForOneOf(a.ws, ['category_reset']);
    }
  } catch (e) {
    serverResults[shortId] = { ok: false, code: 'TIMEOUT', message: e.message };
    break; // server stuck — don't keep probing
  }
}

a.ws.close(); p.ws.close();

// 3) Print discrepancy report.
console.log(`\nServer host: ${HOST}, room: ${ROOM}`);
console.log(`\n${'fwId'.padEnd(5)}  ${'localJSON'.padEnd(10)}  serverProbeResult`);
console.log('─────  ──────────  ─────────────────────────────────────');
let mismatches = 0;
for (const fid of probeFws) {
  const fwFull = FW_BY_SHORT[fid];
  const local = localCount[fwFull] ?? 0;
  const r = serverResults[fid];
  let line;
  if (!r) {
    line = `(probe skipped)`;
  } else if (r.ok) {
    line = `OK — picked ${r.id} (${r.framework})`;
  } else {
    line = `FAIL [${r.code}] ${r.message?.slice(0, 60) || ''}`;
  }
  const flag = (local > 0 && r && !r.ok) ? '  ← MISMATCH' : '';
  if (flag) mismatches += 1;
  console.log(`${fid.padEnd(5)}  ${String(local).padEnd(10)}  ${line}${flag}`);
}

if (mismatches === 0) {
  console.log(`\n✅ Server BANK aligned with /public/data/ (no MISMATCH rows).`);
  process.exit(0);
}
console.log(`\n❌ ${mismatches} framework(s) where /public/data/ has questions but server says it doesn't.`);
console.log(`   → server's bundled BANK is stale. Restart partykit dev process (not just hot-reload)`);
console.log(`   to re-bundle the JSON imports.`);
process.exit(1);
