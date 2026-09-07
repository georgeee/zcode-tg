# zcode-tg

A Telegram bridge for coding agents: one Telegram forum topic == one agent
session. Started as zcode-only (Z.ai's GLM coding agent); now runs either
zcode or Codex (OpenAI's CLI, signed in with a ChatGPT plan) per topic,
behind a shared backend abstraction (`bridge/backend.js`). Read `README.md`
first — architecture, setup, safety model, the MCP gateway section, and the
"Known scope limits" / "Restart continuity" / "Redeploying" sections are
the canonical reference. This file is the short version for an agent
picking up work here, plus operational facts README doesn't need to
restate.

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

`bridge/streamer.js` owns the throttled streaming edits of a turn's
placeholder (one edit per `STREAM_EDIT_INTERVAL_MS`, ⌛-prefixed while
running). `test/e2e.mjs` and `test/e2e-file.mjs` run the whole bridge
against a local fake Telegram (`TELEGRAM_API_ROOT` seam) and a real scratch
app-server — they make real (small) model calls, so don't run them against
the live bot token or while the account is near its rate limit. The pure
modules (`format.js`, `usage.js`, `streamer.js`, `mcp.js`) have fast unit
tests: `node --test test/format.test.js test/usage.test.js
test/streamer.test.js test/mcp.test.js test/mcp-unix.test.js`.

## Model policy differs by backend — read this before changing either

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
including Astra) unless the deployment sets `CODEX_DISALLOW_ASTRA`. If you
add a third backend, decide its MCP model policy deliberately and write
down why here and in `README.md`'s MCP section — don't default it to
"whatever zcode does" or "whatever Codex does" without thinking about it.

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
