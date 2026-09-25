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
// bridge/index.js's eager boot succeed (the 'initialize' handshake), to let
// an MCP session_create on this backend complete end to end (thread/start
// gets a thread id and a model), and to let the cross-backend /model listing
// work (model/list returns the fixture's advertised models). Everything else
// (the 'initialized' notification; turn/start and the rest, which these
// tests never send) is silently ignored.
//
// FIXTURE_CODEX_MODELS   optional comma list of "model:Label" entries
//                        model/list advertises (default the three everyday
//                        tiers). Drives what /model lists for this backend.
// FIXTURE_CODEX_LOG      if set, every client->server REQUEST is appended
//                        here as one JSON line {at, method, params} -- the
//                        record the cross-backend switch test asserts on
//                        (thread/start's params.model names the model the
//                        new codex session actually opened with).
// FIXTURE_CODEX_CLOSE_STDIN  set to a PATH: fd 0 is closed at startup (the
//                        read end of the pipe the client writes to) and the
//                        process stays alive; the path is written AFTER the
//                        close so a test can wait for it. The client's next
//                        write then hits EPIPE against a live process --
//                        the exact shape of a write racing a dead one
//                        (codexClient write-guard test).
import { writeFileSync, appendFileSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

if (process.env.FIXTURE_CODEX_MARKER) {
  writeFileSync(process.env.FIXTURE_CODEX_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
}

// Measured: process.stdin.destroy() does NOT close the fd (without a read
// the handle never opens and the parent's write just buffers) -- only
// closing fd 0 itself does. The keepalive holds the event loop: a closed
// stdin must not end this process.
if (process.env.FIXTURE_CODEX_CLOSE_STDIN) {
  closeSync(0);
  writeFileSync(process.env.FIXTURE_CODEX_CLOSE_STDIN, JSON.stringify({ closedAt: Date.now() }));
  setInterval(() => {}, 10_000);
}

let nextThreadId = 1;
const decoder = new StringDecoder('utf8');
let buf = '';
const reply = (msg, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
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
    if (msg.id === undefined || msg.method === undefined) continue; // notification, or a reply to our own (none) requests
    if (process.env.FIXTURE_CODEX_LOG) {
      appendFileSync(process.env.FIXTURE_CODEX_LOG, JSON.stringify({ at: Date.now(), method: msg.method, params: msg.params ?? {} }) + '\n');
    }
    if (msg.method === 'initialize') {
      reply(msg, {});
    } else if (msg.method === 'thread/start') {
      // CodexBackend.createConversation reads res.thread.id and res.model
      // (see bridge/backends/codexBackend.js) -- exactly what a real
      // thread/start reply carries. res.model echoes the REQUESTED model
      // (params.model) when given, the way a real server reports the
      // thread's effective model; the bridge stores what the backend says
      // it runs, so a fixture that ignored the request would misreport it.
      reply(msg, { thread: { id: `fake-thread-${nextThreadId++}` }, model: msg.params?.model ?? 'gpt-5.6-terra' });
    } else if (msg.method === 'model/list') {
      // CodexBackend.listModels maps data[].model / data[].displayName.
      const models = (process.env.FIXTURE_CODEX_MODELS || 'gpt-5.6-luna:Luna,gpt-5.6-terra:Terra,gpt-5.6-sol:Sol')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const [model, label] = entry.split(':');
          return { model, displayName: label || model };
        });
      reply(msg, { data: models });
    }
    // Everything else is silently ignored.
  }
});
process.stdin.resume();
