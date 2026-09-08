#!/usr/bin/env node
// A minimal stand-in for `codex app-server --listen stdio://` (real JSON-RPC
// 2.0 over stdio, bridge/codexClient.js), used ONLY by
// test/e2e-backend-lifecycle.mjs so a test deployment can have a WORKING
// default backend (Codex) without a real ChatGPT-Plus login, while the test
// actually exercises zcode's lazy-start / bounded-failure behavior.
//
// Must be directly executable (CodexClient spawns codexBin itself, with no
// interposed `node` -- see codexClient.js's start()); marked +x via the
// harness's set_exec repair, not by this script.
//
// Answers exactly enough of the protocol to let CodexBackend.start() and
// bridge/index.js's eager boot succeed: the 'initialize' handshake. Ignores
// everything else (the 'initialized' notification needs no reply; nothing
// in these tests ever calls thread/start).
import { writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

if (process.env.FIXTURE_CODEX_MARKER) {
  writeFileSync(process.env.FIXTURE_CODEX_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
}

const decoder = new StringDecoder('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += decoder.write(chunk);
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
    }
    // Everything else (the 'initialized' notification, and anything these
    // tests never send -- thread/start, turn/start) is silently ignored.
  }
});
process.stdin.resume();
