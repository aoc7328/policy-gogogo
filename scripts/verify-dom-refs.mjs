#!/usr/bin/env node
/**
 * verify-dom-refs.mjs — for each HTML, extract every `id="X"` from the
 * markup and every `document.getElementById('X')` from inline scripts;
 * report any getElementById whose target id doesn't exist in the markup.
 *
 * Phase 4 testing discipline: this would have caught the
 * 'custom-enter-btn' typo (presenter.html line 1116) that abort'd the
 * whole inline script at init and broke game_start handling downstream.
 *
 * Limitations:
 *   - Only handles literal string args. Dynamic ids
 *     (`getElementById(\`gn-${i}\`)`) are skipped — see SKIP_DYNAMIC.
 *   - Doesn't catch elements created at runtime via createElement +
 *     appendChild. False positive for those is acceptable; we just
 *     allowlist them.
 *
 * Exit 0 if every literal lookup matches a markup id.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HTMLS = ['assistant.html', 'presenter.html', 'participant.html', 'testbed.html'];

// Allowlist: ids referenced by getElementById but legitimately not in
// markup. Two categories:
//   (a) created at runtime via JS (createElement + appendChild)
//   (b) demo-era leftover refs whose call sites are null-guarded; the
//       fact that they don't exist is intentional / harmless. Some day
//       these can be fully removed (along with the unused JS code paths).
const RUNTIME_CREATED_ALLOWLIST = new Set([
  // (a) runtime-created
  'buzz-cd-overlay',     // participant.html:1609 createElement
  'pgg-kicked-veil',     // participant.html __kicked__ listener createElement
  // (b) optional / demo leftover (callers null-guard)
  'btn-enter',           // presenter.html — defensive guards everywhere now
  'host-status',         // presenter.html — defensive guards everywhere now
  'reveal-btn',          // presenter.html — annotated "合併版可能不存在"
  'q-status',            // presenter.html — annotated "合併版可能不存在"
  'tm-name-input',       // participant.html — startEditTeamName guards
  'tm-name-err',         // participant.html — startEditTeamName guards
]);

let totalRefs = 0;
let totalMissing = 0;
const failures = [];

for (const file of HTMLS) {
  const path = resolve(ROOT, 'public', file);
  const html = readFileSync(path, 'utf8');

  // Collect all `id="X"` and `id='X'` from markup. Naive but adequate
  // for our static HTML — no JSX, no Vue templates.
  const markupIds = new Set();
  for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    markupIds.add(m[1]);
  }

  // Collect literal getElementById('X') / getElementById("X") calls
  // (skip template-literal / variable-arg cases).
  const refs = [];
  for (const m of html.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const id = m[1];
    // Approximate line number: count newlines before match index.
    const line = html.substring(0, m.index).split('\n').length;
    refs.push({ id, line });
  }

  totalRefs += refs.length;
  for (const r of refs) {
    if (markupIds.has(r.id)) continue;
    if (RUNTIME_CREATED_ALLOWLIST.has(r.id)) continue;
    failures.push({ file, ...r });
    totalMissing += 1;
  }
}

if (failures.length === 0) {
  console.log(
    `✅ All ${totalRefs} literal getElementById() calls across ` +
    `${HTMLS.length} HTML files reference an existing id.`
  );
  process.exit(0);
}

console.error(`❌ ${totalMissing} getElementById() reference(s) target nonexistent id:\n`);
for (const f of failures) {
  console.error(`  - ${f.file}:${f.line}  getElementById('${f.id}')`);
}
console.error(`\nIf any of these are created at runtime via JS, add them to`);
console.error(`RUNTIME_CREATED_ALLOWLIST in scripts/verify-dom-refs.mjs.`);
process.exit(1);
