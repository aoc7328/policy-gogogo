#!/usr/bin/env node
/**
 * build-client.mjs — bundle client/partybus.ts → public/lib/partybus.js
 * as a single IIFE that assigns window.PartyBus synchronously.
 *
 * Run after editing anything under client/. The output is committed so a
 * fresh deploy doesn't need a build step.
 */

import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'public', 'lib', 'partybus.js');

mkdirSync(dirname(OUT), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(ROOT, 'client', 'partybus.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: OUT,
  minify: false,           // keep readable; PartyBus is tiny anyway
  sourcemap: 'inline',     // attached so DevTools can map errors back to TS
  legalComments: 'inline',
  logLevel: 'info',
});

console.log(`Built ${OUT}`);
