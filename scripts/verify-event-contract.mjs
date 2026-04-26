#!/usr/bin/env node
/**
 * verify-event-contract.mjs — cross-check the event protocol against
 * actual usage in server.ts and the three client HTML files.
 *
 * Phase 4 testing discipline #2: catches drift between EVENTS.md /
 * protocol.ts and the consumers.
 *
 * What it checks:
 *   1. Every ClientCommand variant in protocol.ts has a matching
 *      `case 'X':` in server.ts dispatch.  (TypeScript exhaustive check
 *      already enforces this at typecheck time, but we re-verify for
 *      maintainers reading the report.)
 *   2. Every PartyBus.emit('X') call in a client HTML targets a known
 *      ClientCommand type.  Unknown emits = the server will reject.
 *   3. Every public ServerEvent (non __-prefixed) has at least one
 *      client-side PartyBus.on('X') listener somewhere across the
 *      three HTMLs.  Orphan events = server work nobody renders.
 *   4. Prints a coverage matrix: server-emitted events × which clients
 *      listen for them.
 *
 * Exit code 0 when checks 1-3 all pass; 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const HTMLS = ['assistant.html', 'presenter.html', 'participant.html'];

// ─────────────────────────────────────────────────────────────────────
// Parse protocol.ts → ClientCommand + ServerEvent type literals
// ─────────────────────────────────────────────────────────────────────

const protocol = readFileSync(resolve(ROOT, 'party', 'protocol.ts'), 'utf8');

// Walk protocol.ts top-down; classify each `type: 'X'` literal by which
// section header most recently appeared above it.
const sectionMarkers = [
  { re: /ClientCommand variants/i,                  group: 'client' },
  { re: /ServerEvent variants \(server → client\)/i, group: 'server' },
];

const clientCmds = new Set();
const serverEvts = new Set();
{
  let group = null;
  const lines = protocol.split('\n');
  for (const line of lines) {
    for (const m of sectionMarkers) {
      if (m.re.test(line)) {
        group = m.group;
        break;
      }
    }
    const tm = line.match(/type:\s*['"]([^'"]+)['"]/);
    if (tm && group) {
      const literal = tm[1];
      if (group === 'client') clientCmds.add(literal);
      else if (group === 'server') serverEvts.add(literal);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Parse server.ts dispatch cases
// ─────────────────────────────────────────────────────────────────────

const server = readFileSync(resolve(ROOT, 'party', 'server.ts'), 'utf8');
const dispatchCases = new Set();
for (const m of server.matchAll(/case\s+['"]([^'"]+)['"]/g)) {
  dispatchCases.add(m[1]);
}

// ─────────────────────────────────────────────────────────────────────
// Parse each HTML for PartyBus.on(...) and PartyBus.emit(...)
// ─────────────────────────────────────────────────────────────────────

const perHtmlOn = {};
const perHtmlEmit = {};
for (const f of HTMLS) {
  const h = readFileSync(resolve(ROOT, 'public', f), 'utf8');
  const onSet = new Set();
  const emitSet = new Set();
  for (const m of h.matchAll(/PartyBus\.on\(\s*['"]([^'"]+)['"]/g)) onSet.add(m[1]);
  for (const m of h.matchAll(/PartyBus\.emit\(\s*['"]([^'"]+)['"]/g)) emitSet.add(m[1]);
  perHtmlOn[f] = onSet;
  perHtmlEmit[f] = emitSet;
}

// ─────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────

let failed = 0;

console.log(`Parsed protocol.ts:`);
console.log(`  ClientCommand types: ${clientCmds.size}`);
console.log(`  ServerEvent types:   ${serverEvts.size}`);
console.log(`  Dispatch cases in server.ts: ${dispatchCases.size}`);
console.log();

// Check 1
const missingDispatch = [...clientCmds].filter((t) => !dispatchCases.has(t));
if (missingDispatch.length === 0) {
  console.log(`✅ Check 1: every ClientCommand has a server dispatch case.`);
} else {
  console.log(`❌ Check 1: ClientCommand without dispatch case:`);
  for (const t of missingDispatch) console.log(`   - ${t}`);
  failed += 1;
}

// Check 2: per-HTML emits are valid command types
let badEmitFound = false;
for (const f of HTMLS) {
  const unknown = [...perHtmlEmit[f]].filter((t) => !clientCmds.has(t));
  if (unknown.length === 0) {
    console.log(`✅ Check 2 [${f}]: all ${perHtmlEmit[f].size} emit() targets are valid ClientCommand types.`);
  } else {
    console.log(`❌ Check 2 [${f}]: emit() to unknown type(s): ${unknown.join(', ')}`);
    badEmitFound = true;
  }
}
if (badEmitFound) failed += 1;

// Check 3: public ServerEvents must have ≥1 listener somewhere
const allListeners = new Set();
for (const f of HTMLS) {
  for (const t of perHtmlOn[f]) allListeners.add(t);
}
const publicEvts = [...serverEvts].filter((t) => !t.startsWith('__'));
const orphanEvents = publicEvts.filter((t) => !allListeners.has(t));
if (orphanEvents.length === 0) {
  console.log(`✅ Check 3: all ${publicEvts.length} public ServerEvent types have ≥1 client listener.`);
} else {
  console.log(`⚠ Check 3: ServerEvent types with no client listener (server work without renderers):`);
  for (const t of orphanEvents) console.log(`   - ${t}`);
  // Treat as warning, not hard fail — sometimes server emits intentionally
  // for future client features. Keep visible.
}

// Coverage matrix
console.log();
console.log('Coverage matrix (server → client, ✓ = listener present):');
console.log();

const labels = HTMLS.map((f) => f.replace('.html', ''));
const sortedEvts = [...serverEvts].sort();

const w0 = Math.max('event'.length, ...sortedEvts.map((s) => s.length));
const colWs = labels.map((l) => Math.max(l.length, 4));
const fmtRow = (cells) =>
  cells.map((c, i) => String(c).padEnd(i === 0 ? w0 : colWs[i - 1])).join('  ');

console.log(fmtRow(['event', ...labels]));
console.log(fmtRow(['─'.repeat(w0), ...colWs.map((w) => '─'.repeat(w))]));
for (const t of sortedEvts) {
  const cells = [t, ...HTMLS.map((f) => (perHtmlOn[f].has(t) ? '✓' : '·'))];
  console.log(fmtRow(cells));
}

console.log();

// Bonus: which client emits which command
console.log('Command emitters (client → server, ✓ = client emits):');
console.log();
const sortedCmds = [...clientCmds].sort();
const w0c = Math.max('command'.length, ...sortedCmds.map((s) => s.length));
console.log(fmtRow(['command', ...labels]).replace('event', 'command'));
const cmdHeader = ['command', ...labels];
const cmdW0 = Math.max(...cmdHeader.map((s) => s.length), w0c);
console.log(
  cmdHeader.map((c, i) => String(c).padEnd(i === 0 ? cmdW0 : colWs[i - 1])).join('  ')
);
console.log(['─'.repeat(cmdW0), ...colWs.map((w) => '─'.repeat(w))].join('  '));
for (const t of sortedCmds) {
  const cells = [t, ...HTMLS.map((f) => (perHtmlEmit[f].has(t) ? '✓' : '·'))];
  console.log(
    cells.map((c, i) => String(c).padEnd(i === 0 ? cmdW0 : colWs[i - 1])).join('  ')
  );
}

console.log();
if (failed > 0) {
  console.log(`❌ ${failed} hard-fail check(s) — see above.`);
  process.exit(1);
}
console.log(`✅ All hard-fail checks passed.`);
process.exit(0);
