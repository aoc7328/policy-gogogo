#!/usr/bin/env node
/**
 * audit-check.mjs — verify that `npm audit` findings still match the
 * accepted set documented in NOTES.md ("Known Dev Dependencies CVE").
 *
 * Exit codes:
 *   0 → findings match expectation; nothing to do.
 *   1 → action required. The script prints exactly what to do.
 *
 * Run after every `npm install` that touches partykit or its tree.
 * See NOTES.md for the full maintenance protocol.
 */

import { execSync } from 'node:child_process';

// Packages whose CVEs we have explicitly accepted as dev-runtime-only.
// If `npm audit` ever reports a vulnerability outside this set, the
// script flags it. If `npm audit` reports zero vulnerabilities, the
// script tells you to delete the NOTES.md section.
const ACCEPTED_PACKAGES = new Set([
  'esbuild',    // partykit → esbuild (local bundler)
  'undici',     // partykit → miniflare → undici (Workers HTTP sim)
  'partykit',   // transitive carrier of the above
  'miniflare',  // transitive carrier of undici
]);

let raw;
try {
  raw = execSync('npm audit --json', {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
} catch (err) {
  // npm audit exits non-zero whenever any vulnerability exists. The JSON
  // payload is still on stdout in that case — capture it from the error.
  raw = err.stdout?.toString() ?? '';
  if (!raw) {
    console.error('audit:check: npm audit produced no output.');
    console.error(err.stderr?.toString() ?? err.message);
    process.exit(1);
  }
}

let audit;
try {
  audit = JSON.parse(raw);
} catch {
  console.error('audit:check: could not parse npm audit JSON output.');
  console.error(raw.slice(0, 400));
  process.exit(1);
}

const findings = audit.vulnerabilities ?? {};
const findingNames = Object.keys(findings);
const total = audit.metadata?.vulnerabilities?.total ?? findingNames.length;

if (total === 0) {
  console.log('🎉 npm audit reports 0 vulnerabilities.');
  console.log('');
  console.log('Action required:');
  console.log('  1. Delete the "Known Dev Dependencies CVE" section from NOTES.md.');
  console.log('  2. Remove the "audit:check" script from package.json.');
  console.log('  3. Delete scripts/audit-check.mjs.');
  console.log('');
  console.log('Upstream has shipped fixes; this scaffolding is no longer needed.');
  process.exit(1);
}

const unexpected = findingNames.filter((name) => !ACCEPTED_PACKAGES.has(name));
if (unexpected.length > 0) {
  console.log('🚨 npm audit reports CVEs outside the accepted dev-runtime set:');
  console.log('');
  for (const name of unexpected) {
    const f = findings[name];
    console.log(`  - ${name}  (severity: ${f.severity ?? 'unknown'})`);
  }
  console.log('');
  console.log('Action required:');
  console.log('  1. Investigate each unexpected finding.');
  console.log('  2. If it is a real production-impacting issue, fix it.');
  console.log('  3. If it is also dev-only and accepted, add the package to');
  console.log('     ACCEPTED_PACKAGES in scripts/audit-check.mjs and document');
  console.log('     it in NOTES.md → "Known Dev Dependencies CVE".');
  console.log('');
  console.log('Reminder: do NOT run "npm audit fix --force" — it will downgrade');
  console.log('partykit to 0.0.0 and brick the project.');
  process.exit(1);
}

console.log(
  `✅ npm audit findings match accepted set: ${findingNames.join(', ')} ` +
  `(${total} total).`
);
console.log('   See NOTES.md → "Known Dev Dependencies CVE" for context.');
process.exit(0);
