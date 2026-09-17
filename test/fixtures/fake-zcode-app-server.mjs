// A minimal stand-in for `zcode app-server` (bridge/zcodeClient.js's "ZCode
// Protocol" over newline-delimited JSON on stdio), used ONLY by
// test/e2e-backend-lifecycle.mjs to prove eager-vs-lazy backend startup and
// load-bearing-on-death behavior WITHOUT needing a real zcode install or a
// real z.ai credential. Invoked exactly the way ZcodeClient invokes the real
// binary: `node fake-zcode-app-server.mjs app-server`.
//
// Controlled entirely by env vars (deliberately namespaced FIXTURE_ZCODE_* --
// a test running BOTH this fixture and fake-codex-app-server.mjs as
// children of the same bridge process shares one env block, and the two
// fixtures must not collide on a generic name) so one script covers every
// case these tests need:
//   FIXTURE_ZCODE_MARKER          if set, this file is written (with pid+
//                                 time) the INSTANT this process starts --
//                                 proof the bridge actually spawned it
//                                 (eager) vs never did (lazy).
//   FIXTURE_ZCODE_CRASH_AFTER_MS  if set, process.exit(1) after this many
//                                 ms -- simulates the app-server dying (e.g.
//                                 a genuine auth failure crashing the whole
//                                 process, not just failing one turn) so the
//                                 "load-bearing" exit-the-bridge behavior
//                                 can be observed.
//   FIXTURE_ZCODE_RP_REPLY        if set, this fixture speaks just enough of
//                                 the protocol to observe the bridge's
//                                 server-request handling: it immediately
//                                 sends `session/requestRuntimePreferences`
//                                 as a SERVER-initiated request (the exact
//                                 wire shape zcodeClient.js answers, no
//                                 "jsonrpc" key on either side) and writes
//                                 the bridge's raw reply JSON to this file.
//                                 A bridge that registers the handler answers
//                                 {id, result:{nativeSearchEnhancementsEnabled:
//                                 ...}}; one that didn't answers the blanket
//                                 {id, error:{code:-32601}} (see
//                                 zcodeClient.js's _onServerRequest). This is
//                                 the observable for "the runtime-preferences
//                                 handler is registered on EVERY zcode
//                                 instance, eager or lazy".
//                                 While this is set it also answers the four
//                                 calls createConversation()+subscribe() issue
//                                 (session/create, session/setModel,
//                                 session/setMode, session/subscribe) so an
//                                 MCP session_create on this backend
//                                 completes end to end.
// Absent all three, or once the crash timer isn't set, it just idles
// forever -- good enough for tests that only care whether it was STARTED,
// not whether a session/turn actually completes on it.
import { writeFileSync } from 'node:fs';

if (process.env.FIXTURE_ZCODE_MARKER) {
  writeFileSync(process.env.FIXTURE_ZCODE_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');

if (process.env.FIXTURE_ZCODE_RP_REPLY) {
  // A server-initiated request, sent before anything else -- if the bridge
  // answers it at all, the answer lands in the file regardless of what the
  // test does next.
  process.stdout.write(JSON.stringify({ id: 'fixture-rp-1', method: 'session/requestRuntimePreferences', params: {} }) + '\n');
}

if (process.env.FIXTURE_ZCODE_RP_REPLY) {
  const { StringDecoder } = await import('node:string_decoder');
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
      // The bridge's reply to OUR server-initiated request: an id, no method.
      if (msg.id === 'fixture-rp-1' && msg.method === undefined) {
        writeFileSync(process.env.FIXTURE_ZCODE_RP_REPLY, JSON.stringify(msg));
        continue;
      }
      // Replies to the bridge's own calls carry the call's method.
      if (msg.method === 'session/create') reply(msg.id, { session: { sessionId: 'fake-z-1' } });
      else if (msg.method === 'session/setModel' || msg.method === 'session/setMode' || msg.method === 'session/subscribe') reply(msg.id, {});
    }
  });
}

if (process.env.FIXTURE_ZCODE_CRASH_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.FIXTURE_ZCODE_CRASH_AFTER_MS));
}

// Keep stdin open (don't let EOF end the process) without doing anything
// else useful with it -- matches "spawned, alive, never touched further" for
// tests that don't need a real protocol round trip.
process.stdin.resume();
