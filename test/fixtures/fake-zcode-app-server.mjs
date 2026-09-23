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
//   FIXTURE_ZCODE_TURN_SCRIPT     if set, a path to a JSON file describing a
//                                 STREAMED turn to emit on every session/send:
//                                 { "deltas": ["…", "…"], "deltaDelayMs": N,
//                                 "terminalDelayMs": M } -- delta i goes out as
//                                 a session/event text_delta at (i+1)*N ms, a
//                                 final 'result' session/event and the
//                                 turn.terminal telemetry land at M ms. This
//                                 is what lets a test race a mid-stream
//                                 preview flush against the terminal render
//                                 (the terminal-edit invariant e2e) without a
//                                 real model: the bridge sees genuine wire
//                                 notifications, on a schedule it doesn't
//                                 control.
// With any of LOG/RP_REPLY set it answers the calls the bridge actually
// issues (session/create, session/setModel, session/setMode, session/subscribe,
// session/close, session/stop, session/send, workspace/readState) so a topic
// can really be created on it, listed, and switched away from.
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';

if (process.env.FIXTURE_ZCODE_MARKER) {
  writeFileSync(process.env.FIXTURE_ZCODE_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
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
    else if (msg.method === 'session/send') {
      reply(msg.id, {});
      emitScriptedTurn(msg.params.sessionId);
    } else reply(msg.id, {}); // setModel, setMode, subscribe, close, stop: acknowledged, nothing to say
  }
});

if (process.env.FIXTURE_ZCODE_CRASH_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.FIXTURE_ZCODE_CRASH_AFTER_MS));
}

// The scripted streamed turn (FIXTURE_ZCODE_TURN_SCRIPT, documented above).
// Emits the exact wire shapes bridge/zcodeClient.js passes through as backend
// events -- notifications with a method, no id -- mirroring the vocabulary
// bridge/backends/mockBackend.js synthesizes in-process: turn.started
// telemetry, session/event text_delta payloads, a final 'result' session
// event (the authoritative reply text), then turn.terminal. Deltas are
// scheduled on REAL timers so the bridge's own view machinery (streamer or
// milestone reporter) runs at its natural pace against them.
let scriptedTurnSeq = 0;
function emitScriptedTurn(sessionId) {
  if (!process.env.FIXTURE_ZCODE_TURN_SCRIPT) return;
  let script;
  try {
    script = JSON.parse(readFileSync(process.env.FIXTURE_ZCODE_TURN_SCRIPT, 'utf8'));
  } catch (e) {
    process.stderr.write(`fixture: bad FIXTURE_ZCODE_TURN_SCRIPT: ${e.message}\n`);
    return;
  }
  const turnId = `fixture-turn-${++scriptedTurnSeq}`;
  const deltas = Array.isArray(script.deltas) ? script.deltas : [];
  const step = Number(script.deltaDelayMs) || 300;
  const notify = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  notify({ method: 'v4/telemetry/event', params: { sessionId, turnId, kind: 'turn.started' } });
  deltas.forEach((delta, i) => {
    setTimeout(() => notify({ method: 'session/event', params: { sessionId, turnId, payload: { kind: 'text_delta', delta } } }), step * (i + 1));
  });
  setTimeout(() => {
    const content = script.result ?? deltas.join('');
    if (content) notify({ method: 'session/event', params: { sessionId, turnId, payload: { kind: 'result', content } } });
    notify({
      method: 'v4/telemetry/event',
      params: { sessionId, turnId, kind: 'turn.terminal', status: 'success', durationMs: Number(script.terminalDelayMs) || 0, tokenCount: 1, toolCallCount: 0 },
    });
  }, Number(script.terminalDelayMs) || step * (deltas.length + 1));
}

// Keep stdin open (don't let EOF end the process).
process.stdin.resume();
