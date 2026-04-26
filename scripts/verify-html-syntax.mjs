#!/usr/bin/env node
/**
 * verify-html-syntax.mjs — extract every inline <script> from the four
 * public/*.html files and run esbuild parse on it. Catches:
 *
 *   - SyntaxError: Identifier 'X' has already been declared
 *   - Unbalanced braces / parens
 *   - Reserved-word clashes
 *   - Anything else that would kill the script at <head> parse time
 *
 * Phase 4 testing discipline: this is one of the "machine tests" that
 * runs autonomously. The PGG_ROOM_CODE duplicate-declaration bug from
 * commit 17af557's predecessor would have been caught here.
 *
 * Skips:
 *   - <script src="...">   (external; not our code)
 *   - <script type="X">    where X isn't text/javascript or application/javascript
 *
 * Exit codes:
 *   0 → all inline scripts parse
 *   1 → at least one parse failure (with file + approximate line)
 */

import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HTMLS = [
  'assistant.html',
  'presenter.html',
  'participant.html',
  'testbed.html',
];

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const TYPE_RE = /\btype=["']?([^"'\s>]+)/i;
const SRC_RE = /\bsrc=/i;

function isInlineJs(attrs) {
  if (SRC_RE.test(attrs)) return false;
  const m = attrs.match(TYPE_RE);
  if (!m) return true; // no type attr = default text/javascript
  const t = m[1].toLowerCase();
  return t === 'text/javascript' || t === 'application/javascript';
}

let totalScripts = 0;
let totalSkipped = 0;
const failures = [];

for (const file of HTMLS) {
  const path = resolve(ROOT, 'public', file);
  let html;
  try {
    html = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${path}: ${err.message}`);
    process.exit(1);
  }

  let scriptIdx = 0;
  for (const match of html.matchAll(SCRIPT_RE)) {
    scriptIdx += 1;
    const attrs = match[1];
    const body = match[2];
    if (!isInlineJs(attrs)) {
      totalSkipped += 1;
      continue;
    }
    if (!body.trim()) continue;

    totalScripts += 1;
    const startLine = html.substring(0, match.index).split('\n').length;

    try {
      await esbuild.transform(body, { loader: 'js' });
    } catch (err) {
      // esbuild errors carry a structured .errors[] array; use it to print
      // the actual identifier + line within the script body, plus the line
      // within the HTML file (startLine + script-internal offset).
      const detail = (err.errors || []).map((e) => {
        const innerLine = e.location?.line ?? 0;
        const htmlLine = startLine + innerLine;
        return `${e.text} (HTML line ${htmlLine}, script-internal line ${innerLine})`;
      }).join('\n    ');
      failures.push({
        file,
        scriptIdx,
        startLine,
        message: detail || err.message.split('\n')[0],
      });
    }
  }
}

if (failures.length === 0) {
  console.log(
    `✅ All ${totalScripts} inline <script> blocks across ` +
    `${HTMLS.length} HTML files parse cleanly` +
    (totalSkipped > 0 ? ` (${totalSkipped} non-JS skipped).` : '.')
  );
  process.exit(0);
}

console.error(`❌ ${failures.length} inline script(s) failed parse:\n`);
for (const f of failures) {
  console.error(
    `  - ${f.file} <script #${f.scriptIdx}> (HTML line ~${f.startLine})\n` +
    `    ${f.message}`
  );
}
process.exit(1);
