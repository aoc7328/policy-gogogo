#!/usr/bin/env node
/**
 * scan-html-load-errors.mjs — load each public/*.html in jsdom with
 * minimal stubs (PartyBus, PGGBankLoader, QRCode), capture every error
 * raised during initial script execution.
 *
 * Catches load-time fatal errors that abort inline script init —
 * the same family as the PGG_ROOM_CODE SyntaxError + custom-enter-btn
 * TypeError we hit before. Won't catch runtime errors that only fire
 * during user interaction (those need a real browser DevTools).
 *
 * Output format (stdout):
 *   FILE | error level | message (one per line)
 * Exit code: 0 if no errors, 1 otherwise.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';

const HTMLS = ['assistant.html', 'presenter.html', 'participant.html'];

const STUB_PARTYBUS_BANK = `
<script>
window.PartyBus = {
  _ev: {},
  init() {},
  emit(t, p) {},
  on(t, cb) { (this._ev[t] = this._ev[t] || []).push(cb); },
  onStatus(cb) { try { cb('connected'); } catch {} },
  getControlCode: () => null,
  getStatus: () => 'connected',
  forgetControlCode() {},
};
window.PGGBankLoader = {
  autoLoad: () => Promise.resolve({ ok: true, banks: {}, errors: [] }),
  difficultyForId: (id) => null,
};
</script>`;

const STUB_QRCODE = `
<script>
function QRCode() {}
QRCode.CorrectLevel = { H: 0, Q: 1, M: 2, L: 3 };
window.QRCode = QRCode;
</script>`;

let totalErrors = 0;
const allFindings = [];

for (const file of HTMLS) {
  const raw = readFileSync(`public/${file}`, 'utf8')
    .replace(/<script src="lib\/partybus\.js"><\/script>/, STUB_PARTYBUS_BANK)
    .replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/qrcodejs[^"]+"><\/script>/, STUB_QRCODE);

  const findings = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => findings.push({ level: 'jsdomError', msg: (e.message || String(e)).split('\n')[0] }));
  vc.on('error', (...args) => findings.push({ level: 'console.error', msg: args.map(String).join(' ').split('\n')[0] }));
  vc.on('warn', (...args) => findings.push({ level: 'console.warn', msg: args.map(String).join(' ').split('\n')[0] }));

  try {
    const dom = new JSDOM(raw, {
      runScripts: 'dangerously',
      url: `http://localhost:3000/${file}`,
      virtualConsole: vc,
      pretendToBeVisual: true,
    });
    // Let microtasks + a few timers flush
    await new Promise((r) => setTimeout(r, 300));
    dom.window.close();
  } catch (e) {
    findings.push({ level: 'jsdom-construct-throw', msg: e.message.split('\n')[0] });
  }

  if (findings.length === 0) {
    console.log(`✅ ${file}: no load-time errors / warnings detected`);
  } else {
    console.log(`\n=== ${file} (${findings.length} issue${findings.length > 1 ? 's' : ''}) ===`);
    for (const f of findings) {
      console.log(`  [${f.level}] ${f.msg}`);
      totalErrors += 1;
      allFindings.push({ file, ...f });
    }
  }
}

console.log();
if (totalErrors === 0) {
  console.log('🎯 All three HTMLs init cleanly under jsdom (load-time clean).');
  process.exit(0);
}
console.log(`❌ ${totalErrors} load-time issue(s) total across ${HTMLS.length} files.`);
process.exit(1);
