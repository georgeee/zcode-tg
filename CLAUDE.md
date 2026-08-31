# zcode-mobile

A Telegram bridge for zcode (Z.ai's GLM coding agent): one Telegram forum
topic == one zcode session. Read `README.md` first — architecture, setup,
safety model, and the "Known scope limits" / "Known issue" sections are the
canonical reference. This file is the short version for an agent picking up
work here, plus operational facts README doesn't need to restate.

## What you're looking at

`bridge/index.js` spawns `zcode app-server` as a child process and speaks
its **"ZCode Protocol"** over newline-delimited JSON on stdio — this is
*not* JSON-RPC 2.0, and it is almost entirely undocumented upstream (not in
zcode's public docs, only discoverable via `zcode --help` and by reading the
vendored runtime bundle). `bridge/zcodeClient.js`'s comments carry the
specific protocol gotchas that cost real debugging time to find — read them
before touching that file. Don't re-derive protocol behavior from scratch;
check there and in `README.md` first.

## This repo IS the zcode agent's own workspace

`ZCODE_WORKSPACE_DIR` (in the bridge's config) points at this repo's root.
Any topic's zcode session can read and edit files here — including this
file. That's intentional (the `zcode-mobile` topic is used to work on this
very bridge), but it means:

- **Never put secrets in this repo.** Config lives at
  `~/.config/zcode-mobile-bridge/.env` on the host running the bridge, well
  outside this directory, specifically so an ordinary "look at your own
  code" prompt can't read and echo a live token back into Telegram.
- Sessions run in **yolo / auto-approve mode by default** — a message in an
  authorized topic can run arbitrary shell commands and file edits with no
  human approval step. See README's "Permissions / safety model" before
  changing that default.

## Where this actually runs (as of 2026-08-31)

- Host: this same machine, `systemd --user` service `zcode-bridge.service`
  (unit file: `deploy/zcode-bridge.service`), `Restart=always`, enabled for
  boot. `systemctl --user` commands need `XDG_RUNTIME_DIR=/run/user/<uid>`
  set if not already present in the shell.
- Logs: `data/bridge.log`.
- Session store: `data/sessions.json` (topic↔session map + Telegram update
  offset), guarded by an exclusive lock file (`data/sessions.json.lock`) —
  **don't run a second `node bridge/index.js` against the same store while
  the service is up; it will fail fast with a clear "another instance
  already has this open" error rather than corrupt the store.** That's the
  point of the lock, not a bug.
- zcode login (the Z.ai credential) is a *host-level* one-time setup, not
  something this repo can re-derive — see README §1 if it's ever missing.

## Conventions for changes here

- `node -c bridge/*.js` (syntax check) before restarting the service — this
  is a live bridge with real users on the other end of Telegram, not a repo
  with a test suite.
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
