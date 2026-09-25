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
//   FIXTURE_ZCODE_LOG             if set, EVERY client->server REQUEST is
//                                 appended to this file as one JSON line
//                                 {at, method, params} -- the record tests
//                                 assert on: which session was created when,
//                                 and (the cross-backend /model case) which
//                                 model a session/setModel actually carried.
//   FIXTURE_ZCODE_MODELS          if set, a comma list "provider/model:Label"
//                                 entries this fixture's workspace/readState
//                                 advertises (default two GLM models). Drives
//                                 listModels() -- and so what /model shows.
//   FIXTURE_ZCODE_CLOSE_STDIN     set to a PATH: fd 0 is closed at startup
//                                 (the read end of the pipe the client
//                                 writes to) and the process stays alive;
//                                 the path is written AFTER the close so a
//                                 test can wait for it. The client's next
//                                 write then hits EPIPE against a live
//                                 process -- the exact shape of a write
//                                 racing a dead one (zcodeClient
//                                 write-guard test).
// With any of LOG/RP_REPLY set it answers the calls the bridge actually
// issues (session/create, session/setModel, session/setMode, session/subscribe,
// session/close, session/stop, session/send, workspace/readState) so a topic
// can really be created on it, listed, and switched away from.
import { writeFileSync, appendFileSync, closeSync } from 'node:fs';

if (process.env.FIXTURE_ZCODE_MARKER) {
  writeFileSync(process.env.FIXTURE_ZCODE_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
}

// Measured: process.stdin.destroy() does NOT close the fd (without a read
// the handle never opens and the parent's write just buffers) -- only
// closing fd 0 itself does. The keepalive holds the event loop: a closed
// stdin must not end this process.
if (process.env.FIXTURE_ZCODE_CLOSE_STDIN) {
  closeSync(0);
  writeFileSync(process.env.FIXTURE_ZCODE_CLOSE_STDIN, JSON.stringify({ closedAt: Date.now() }));
  setInterval(() => {}, 10_000);
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
let nextSessionId = 1;

// The model catalog listModels() reads (zcodeBackend.js maps
// modelCatalog.available's {ref:{providerId, modelId}, label, contextWindow});
// providers[].models is included so the resume-path catalog warm-up would
// also find zai models if a test resumes a session.
const FIXTURE_MODELS = (process.env.FIXTURE_ZCODE_MODELS || 'zai/glm-5.3-flash:GLM-5.3 Flash:204800,zai/glm-4.6-air:GLM-4.6 Air:131072')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [ref, label, ctx] = entry.split(':');
    const [providerId, modelId] = ref.split('/');
    return { providerId, modelId, label: label || modelId, contextWindow: ctx ? Number(ctx) : undefined };
  });
const readState = {
  modelCatalog: {
    available: FIXTURE_MODELS.map(({ providerId, modelId, label, contextWindow }) => ({ ref: { providerId, modelId }, label, contextWindow })),
    providers: [{ providerId: 'zai', models: FIXTURE_MODELS.map(({ modelId, contextWindow }) => ({ modelId, contextWindow })) }],
  },
};

const logRequest = (msg) => {
  if (!process.env.FIXTURE_ZCODE_LOG) return;
  appendFileSync(process.env.FIXTURE_ZCODE_LOG, JSON.stringify({ at: Date.now(), method: msg.method, params: msg.params ?? {} }) + '\n');
};

if (process.env.FIXTURE_ZCODE_RP_REPLY) {
  // A server-initiated request, sent before anything else -- if the bridge
  // answers it at all, the answer lands in the file regardless of what the
  // test does next.
  process.stdout.write(JSON.stringify({ id: 'fixture-rp-1', method: 'session/requestRuntimePreferences', params: {} }) + '\n');
}

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
      if (process.env.FIXTURE_ZCODE_RP_REPLY) writeFileSync(process.env.FIXTURE_ZCODE_RP_REPLY, JSON.stringify(msg));
      continue;
    }
    if (msg.method === undefined || msg.id === undefined) continue; // not a request
    logRequest(msg);
    // This protocol carries no "jsonrpc" key in either direction (the client
    // rejects one) -- reply mirrors the request's {id, result} shape.
    if (msg.method === 'session/create') reply(msg.id, { session: { sessionId: `fake-z-${nextSessionId++}` } });
    else if (msg.method === 'workspace/readState') reply(msg.id, readState);
    else reply(msg.id, {}); // setModel, setMode, subscribe, close, stop, send: acknowledged, nothing to say
  }
});

if (process.env.FIXTURE_ZCODE_CRASH_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.FIXTURE_ZCODE_CRASH_AFTER_MS));
}

// Keep stdin open (don't let EOF end the process).
process.stdin.resume();
