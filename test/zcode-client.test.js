// Unit test for bridge/zcodeClient.js's stdin write-guard: a write that
// loses the race against the app-server's death (EPIPE against a process
// whose stdin read end is already gone) must fail the pending call FAST
// with a clear message -- never surface as an uncaughtException, which in
// the bridge would take down the whole process, every session with it
// (the antigravity client's measured failure; same treatment). Runs against
// test/fixtures/fake-zcode-app-server.mjs with FIXTURE_ZCODE_CLOSE_STDIN,
// which closes fd 0 -- the real kernel-level shape -- at startup and writes
// a marker afterwards, so the test waits for the CLOSED state itself rather
// than racing the fixture's boot.
//
// Run: node --test test/zcode-client.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZcodeClient } from '../bridge/zcodeClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-zcode-app-server.mjs');

async function waitFor(fn, what, ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Catches the async face of a stdin error without letting it fail the run:
// node:test only crashes the test on an uncaughtException when NO listener
// exists, so this trap plus the assertion at the end is what turns "the
// spawn-time stdin 'error' listener was removed" red.
function trapUncaught(t) {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  return uncaught;
}

test('a write the dead app-server can never read fails the call fast -- never an uncaughtException', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zcode-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uncaught = trapUncaught(t);
  const closedMarker = path.join(dir, 'stdin-closed.json');
  const client = new ZcodeClient({
    nodeBin: process.execPath,
    zcodeBin: FIXTURE,
    cwd: dir,
    env: { FIXTURE_ZCODE_CLOSE_STDIN: closedMarker }, // the fixture closes its stdin read end at startup
  });
  client.start();
  try {
    await waitFor(() => existsSync(closedMarker), 'the fixture to close its stdin');
    // The EPIPE face: the process is alive but its stdin read end is GONE --
    // the exact shape of a write racing a dead child. The call must fail
    // fast with the refusal message (not at its 120s timeout), and the
    // kernel's EPIPE must be swallowed by the spawn-time listener.
    let settled = false;
    const call = client.call('session/create', {}).then(
      () => { settled = true; return null; },
      (e) => { settled = true; return e; },
    );
    const outcome = await Promise.race([call, new Promise((r) => setTimeout(() => r('slow'), 5_000))]);
    assert.equal(settled, true, 'the call settled fast, not at its timeout');
    assert.ok(outcome instanceof Error, `the call rejected: ${String(outcome)}`);
    assert.match(outcome.message, /refused a write/);
    // A write issued directly after the process is gone: same fast, clear
    // rejection via the death path (no uncaught exception either way).
    client.proc.kill('SIGKILL');
    await once(client, 'exit'); // _deadError is set synchronously in that handler
    await assert.rejects(client.call('workspace/readState', {}), /exited .* before responding/);
    await new Promise((r) => setTimeout(r, 100)); // any async face would have surfaced by now
  } finally {
    client.stop();
  }
  assert.deepEqual(uncaught, []);
});
