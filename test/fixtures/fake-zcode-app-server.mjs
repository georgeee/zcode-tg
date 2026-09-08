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
// Absent both, or once the crash timer isn't set, it just idles forever,
// acknowledging nothing -- good enough for tests that only care whether it
// was STARTED, not whether a session/turn actually completes on it.
import { writeFileSync } from 'node:fs';

if (process.env.FIXTURE_ZCODE_MARKER) {
  writeFileSync(process.env.FIXTURE_ZCODE_MARKER, JSON.stringify({ pid: process.pid, at: Date.now(), argv: process.argv.slice(2) }));
}

if (process.env.FIXTURE_ZCODE_CRASH_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.FIXTURE_ZCODE_CRASH_AFTER_MS));
}

// Keep stdin open (don't let EOF end the process) without doing anything
// useful with it -- matches "spawned, alive, never touched further" for
// tests that don't need a real protocol round trip.
process.stdin.resume();
