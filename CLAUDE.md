# zcode-tg

A Telegram bridge for coding agents: one Telegram forum topic == one agent
session. Started as zcode-only (Z.ai's GLM coding agent); now runs zcode,
Codex (OpenAI's CLI, signed in with a ChatGPT plan), or Mock (a zero-
credential, zero-subprocess echo backend for testing) per topic, behind a
shared backend abstraction (`bridge/backend.js`). Read `README.md` first —
architecture, setup, safety model, the MCP gateway section (including "The
mock backend"), and the "Known scope limits" / "Restart continuity" /
"Redeploying" sections are the canonical reference. This file is the short
version for an agent picking up work here, plus operational facts README
doesn't need to restate.

## What you're looking at

`bridge/backend.js` is the contract: what `bridge/index.js` needs from "a
thing that runs agentic turns," extracted from what zcode's own client and
`index.js` already did implicitly before a second backend existed — read
its module comment before touching either backend, it documents the shared
event vocabulary (`session/event`, `v4/telemetry/event`) both backends
speak so `index.js`'s streaming/watchdog/breaker logic works unchanged
regardless of which one a topic runs on.

- `bridge/backends/zcodeBackend.js` + `bridge/zcodeClient.js`: zcode's
  **"ZCode Protocol"** over newline-delimited JSON on stdio (`zcode
  app-server`) — *not* JSON-RPC 2.0, minimally documented upstream (`zcode
  --help`), the rest knowable only by observing a running instance.
  `zcodeClient.js`'s comments carry the specific protocol gotchas that cost
  real debugging time to find. Don't re-derive protocol behavior from
  scratch; check there and in `README.md` first.
- `bridge/backends/codexBackend.js` + `bridge/codexClient.js`: Codex's real
  JSON-RPC 2.0 `app-server` protocol (threads and turns, not zcode's
  sessions) over stdio. Every protocol fact in `codexBackend.js`'s comments
  is tagged by evidence tier (verified live / from the schema dump / from
  source / inferred) — trust that tagging, and when extending this file,
  add the same tagging rather than blending confirmed and guessed shapes.
  `codex app-server generate-json-schema --experimental` and
  `generate-ts --experimental --out <dir>` dump the authoritative protocol
  definition straight from the binary; prefer that over reading Rust source
  when a question can be answered either way.
- `bridge/backends/mockBackend.js`: no client, no subprocess, no protocol —
  pure JS. `createConversation`/`sendMessage` are synchronous in substance
  (a `queueMicrotask` defers the event emission just enough that a caller
  registering turn state right after calling `sendMessage()` — as
  `bridge/index.js`'s `startTurn()` does — sees it before any event
  arrives). Exists so the multi-backend machinery (this file, `mcp.js`, the
  `/backend`/`/model` Telegram commands) can be exercised for real with zero
  credentials, zero external processes, and zero API cost — see README's
  "The mock backend".

## THE EAGER/LAZY BACKEND SPLIT IS BY `cfg.defaultBackend`, NOT BY NAME

`bridge/index.js` starts exactly one backend EAGERLY, at module load, before
`main()` ever runs: whichever one `cfg.defaultBackend` (`DEFAULT_BACKEND`,
default `'zcode'`) actually names. That one is also LOAD-BEARING — its
`exit` event (`wireBackend()`'s handler) takes the whole process down so the
service manager restarts it. Every OTHER backend is lazy, built and started
only the first time `getBackend()` is called for it, and its death only
takes down topics running on it. **This used to be hardcoded as "zcode is
eager and load-bearing, everything else is lazy and optional"** — silently
wrong the moment a deployment sets `DEFAULT_BACKEND=codex`: it would still
eagerly spawn a `zcode app-server` with no z.ai credential configured, and
(see the next paragraph) that could crash-loop the whole bridge before the
Codex MCP socket ever bound. Fixed 2026-09-08 ("bug #3"): the split is now
by `cfg.defaultBackend`, via `BACKEND_FACTORIES` and a single generic
eager-start block. **A zcode-default deployment (the live one) is
byte-for-byte unchanged** — same construction args, same synchronous
`start()` call, same point in module evaluation. Regression-tested in
`test/e2e-backend-lifecycle.mjs`.

**`zcodeClient.js`/`codexClient.js` didn't handle child_process's `'error'`
event** (spawn-time failures — ENOENT/EACCES — fire `'error'`, never
`'exit'`, since the OS process never existed). With no listener, Node
throws it as an uncaught exception — for zcode specifically, that happened
at MODULE LOAD time, before `main()` and the Codex MCP socket bind, and
under the live systemd unit's `Restart=always`/`RestartSec=3` repeated
forever. Fixed alongside the eager/lazy split: both clients now convert a
spawn `'error'` into the same `'exit'`-shaped event a real subprocess death
produces (so it flows through the existing bounded/fatal-only-if-default
handling), AND track a `_deadError` so a call issued AFTER the process is
already known dead fails immediately instead of waiting out
`DEFAULT_TIMEOUT_MS` (120s) — found by `test/e2e-backend-lifecycle.mjs`
itself, which caught the first version of this fix only making the FIRST
post-failure call fast. A caller not configuring a credential for a backend
it never uses now costs nothing; a caller that DOES try to use a
misconfigured backend gets a clear, fast error on every attempt, not a hang
or a crash loop.

`bridge/streamer.js` owns the throttled streaming edits of a turn's
placeholder (one edit per `STREAM_EDIT_INTERVAL_MS`, ⌛-prefixed while
running). `test/e2e.mjs` and `test/e2e-file.mjs` run the whole bridge
against a local fake Telegram (`TELEGRAM_API_ROOT` seam) and a real scratch
app-server — they make real (small) model calls, so don't run them against
the live bot token or while the account is near its rate limit.
`test/e2e-backend-lifecycle.mjs` does the same against fake zcode/Codex CLI
stand-ins (`test/fixtures/`) instead, specifically to cover eager-vs-lazy
startup and misconfigured-backend failure modes without real credentials.
`test/e2e-codex-bug3-smoke.mjs` is the real-credential counterpart: a REAL
`codex app-server` (real ChatGPT-Plus login), `DEFAULT_BACKEND=codex`, and
an isolated `$HOME` (so no zcode credential can exist) — the exact
deployment shape bug #3 was reported against — proving live that it boots,
binds the MCP socket, and completes one real, cheap `gpt-5.6-luna` turn.
This is the test that actually caught the `refreshUsagePercentages()` crash
above; it's a real-spend script (one short Codex turn), not part of the
fast suite. The pure modules (`format.js`, `usage.js`, `streamer.js`, `mcp.js`,
`backends/mockBackend.js`) have fast unit tests: `node --test
test/format.test.js test/usage.test.js test/streamer.test.js
test/mcp.test.js test/mcp-unix.test.js test/mock-backend.test.js`.

## Model policy differs by backend — read this before changing any of them

zcode's MCP gateway has never offered a way to switch models: sessions
always run the bridge default (`zai/glm-5.3-flash`), and `session_create`/
`model_set` both refuse a `model` argument outright for `backend: 'zcode'`
rather than silently ignoring it. **Codex is different, and the difference
is deliberate, not an oversight to reconcile.** Codex exposes four
everyday-to-flagship tiers; `CODEX_MCP_MODELS` in `bridge/index.js` allows
exactly three of them (`gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`) over
MCP, with Terra the strong default. `gpt-6-astra` — Codex's newest and most
expensive model, and confirmed live to be Codex's own *server-side*
default absent an override — is never reachable over MCP, by an
exact-match allowlist (`validateMcpModel`) rather than a prefix/pattern
check, so a future Codex model name is refused until someone deliberately
adds it, not silently admitted for resembling an already-allowed one.
Telegram's `/model` command stays unrestricted for a human (any model,
including Astra) unless the deployment sets `CODEX_DISALLOW_ASTRA`. **Mock
sits with zcode**: exactly one model (`mock-1`), `model_set` refused
outright — not zcode's policy reused by default, but the same conclusion
for a different reason (a single-model backend has nothing to switch to or
from; see `mockBackend.js`'s "Model-switching policy" comment). If you add
a FOURTH backend, decide its MCP model policy deliberately and write down
why here and in `README.md`'s MCP section — don't default it to "whatever
the nearest existing backend does" without thinking about it.

## The workspace is (or mirrors) the agent's own working directory

`ZCODE_WORKSPACE_DIR` (in the bridge's config) points at this repo's root —
topics are used to work on this very bridge, which is intentional. It means:

- **Never put secrets in this repo.** Config lives outside the workspace
  (`~/.config/zcode-tg/.env` by default, override with `ZCODE_TG_ENV` —
  see `resolveEnvPath` in `bridge/env.js`) on the host running the bridge,
  specifically so an ordinary "look at your own code" prompt can't read
  and echo a live token back into Telegram. The same applies to `CODEX_HOME`
  — it holds `auth.json`, a real ChatGPT-plan credential; it must never be a
  path under `ZCODE_WORKSPACE_DIR`, for the identical reason.
- Sessions typically run in **yolo / auto-approve mode** — a message in an
  authorized topic can run arbitrary shell commands and file edits with no
  human approval step. See README's "Permissions / safety model" before
  changing that default.
- `/file` and the model's `[file: …]` markers are restricted to the
  workspace subtree for the same reason.

## Running & operations

- The bridge runs as a `systemctl --user` unit; `deploy/zcode-bridge.service`
  is the template — the live copy lives in `~/.config/systemd/user/` and is
  what systemd actually reads (repo changes to the unit must be copied there
  + `daemon-reload`d to take effect). `systemctl --user` needs
  `XDG_RUNTIME_DIR=/run/user/<uid>` if your shell doesn't set it.
- Logs: `data/bridge.log`. Session store: `data/sessions.json`, guarded by
  an exclusive lock file — **don't run a second `node bridge/index.js`
  against the same store while the service is up**; it fails fast with a
  clear error rather than corrupt the store. That's the point of the lock.
- Redeploys drain in-flight turns instead of interrupting them (README,
  "Redeploying") — but prefer fixing forward to restarting when both are
  options.
- zcode login (the Z.ai credential) is a host-level one-time setup, not
  something this repo can re-derive — see README §1 if it's ever missing.

## Conventions for changes here

- `node --check bridge/*.js` (syntax check) before restarting the service —
  this is a live bridge with real users on the other end of Telegram, not a
  repo with a test suite for index.js.
- After editing, redeploy with:
  ```
  systemctl --user restart zcode-bridge.service   # (XDG_RUNTIME_DIR set)
  tail -f data/bridge.log
  ```
- Match the existing comment density in `bridge/*.js` — comments there
  record *why*, especially protocol gotchas and past bugs, not just *what*.
  Several were added specifically because a past mistake was expensive to
  track down (e.g. the stateless-UTF-8-decode bug, the offset-persisted-once-
  per-batch bug) — that context is deliberate, not clutter.
- Prefer fixing a root cause over adding a workaround, but when a root
  cause turns out to be outside this codebase (see the "deferred model
  adapter" issue in README) it's fine to ship an honest, documented
  fallback rather than block on fully understanding upstream zcode
  behavior.
