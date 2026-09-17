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
// bridge/index.js's eager boot succeed (the 'initialize' handshake) and to
// let an MCP session_create on this backend complete end to end: thread/start
// gets a thread id (a fresh one per call, the way the real server behaves)
// and a model. Everything else (the 'initialized' notification; turn/start
// and the rest, which these tests never send) is silently ignored.
import { writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

if (process.env.FIXTURE_CODEX_MARKER) {
  writeFileSync(process.env.FIXTURE_CODEX_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
}

let nextThreadId = 1;
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
    if (msg.id !== undefined && msg.method === 'thread/start') {
      // CodexBackend.createConversation reads res.thread.id and res.model
      // (see bridge/backends/codexBackend.js) -- exactly what a real
      // thread/start reply carries.
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: `fake-thread-${nextThreadId++}` }, model: 'gpt-5.6-terra' } }) + '\n',
      );
    }
    // Everything else (the 'initialized' notification, and anything these
    // tests never send -- turn/start, model/list) is silently ignored.
  }
});
process.stdin.resume();
