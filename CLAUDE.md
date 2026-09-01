# zcode-tg

A Telegram bridge for zcode (Z.ai's GLM coding agent): one Telegram forum
topic == one zcode session. Read `README.md` first — architecture, setup,
safety model, and the "Known scope limits" / "Restart continuity" /
"Redeploying" sections are the canonical reference. This file is the short
version for an agent picking up work here, plus operational facts README
doesn't need to restate.

## What you're looking at

`bridge/index.js` spawns `zcode app-server` as a child process and speaks
its **"ZCode Protocol"** over newline-delimited JSON on stdio — this is
*not* JSON-RPC 2.0, and it is almost entirely undocumented upstream (not in
zcode's public docs, only discoverable via `zcode --help` and by reading the
vendored runtime bundle). `bridge/zcodeClient.js`'s comments carry the
specific protocol gotchas that cost real debugging time to find — read them
before touching that file. Don't re-derive protocol behavior from scratch;
check there and in `README.md` first.

`bridge/streamer.js` owns the throttled streaming edits of a turn's
placeholder (one edit per `STREAM_EDIT_INTERVAL_MS`, ⌛-prefixed while
running). `test/e2e.mjs` and `test/e2e-file.mjs` run the whole bridge
against a local fake Telegram (`TELEGRAM_API_ROOT` seam) and a real scratch
app-server — they make real (small) model calls, so don't run them against
the live bot token or while the account is near its rate limit. The pure
modules (`format.js`, `usage.js`, `streamer.js`) have fast unit tests:
`node --test test/format.test.js test/usage.test.js test/streamer.test.js`.

## The workspace is (or mirrors) the agent's own working directory

`ZCODE_WORKSPACE_DIR` (in the bridge's config) points at this repo's root —
topics are used to work on this very bridge, which is intentional. It means:

- **Never put secrets in this repo.** Config lives outside the workspace
  (`~/.config/zcode-tg/.env` by default; pre-rename
  `~/.config/zcode-mobile-bridge/.env` still honored, override with
  `ZCODE_TG_ENV` — see `resolveEnvPath` in `bridge/env.js`) on the host
  running the bridge, specifically so an ordinary "look at your own code"
  prompt can't read and echo a live token back into Telegram.
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
  fallback rather than block on fully reverse-engineering upstream zcode
  behavior.
