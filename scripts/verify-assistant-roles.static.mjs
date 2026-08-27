#!/usr/bin/env node
/** Regression guard for the server-authoritative multi-assistant layer. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const server = read('party/server.ts');
const protocol = read('party/protocol.ts');
const testbed = read('public/testbed.html');
const required = [
  ['protocol roles', protocol, "'chief' | 'manager' | 'scorer' | 'grouper' | 'moderator' | 'projector' | 'unassigned'"],
  ['role command gate', server, 'if (!this.assistantCan(sender, cmd.type)) return;'],
  ['score restriction', server, '記分助理只能在本場進行中以 +1 / -1 調分'],
  ['prefix pin restriction', server, '分組助理只能操作「其他」或已置頂的組'],
  ['manager singleton', server, '每房只能有一位管理助理'],
  ['assistant identity persistence', server, 'this.state.assistants.set(id'],
  ['eight-end testbed', testbed, 'const eight='],
];
for (const [name, text, needle] of required) {
  if (!text.includes(needle)) throw new Error(`missing ${name}: ${needle}`);
}
for (const id of ['tb-chief', 'tb-manager', 'tb-scorer', 'tb-grouper', 'tb-moderator', 'tb-projector']) {
  if (!testbed.includes(id)) throw new Error(`TestBed missing isolated identity ${id}`);
}
console.log('✅ Multi-assistant role authority, limits, and isolated TestBed identities are present.');
