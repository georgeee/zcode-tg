# zcode-mobile

A Telegram bridge for [zcode](https://zcode.z.ai) (Z.ai's GLM coding agent):
**one Telegram forum topic == one zcode session.** Send a message in a
topic, get a reply; each topic keeps its own independent conversation.

Long-term goal is a native Android chat client talking to `zcode app-server`
directly over WebSocket/TLS. This bridge is the minimal version of that same
idea, using Telegram as the UI so there's something usable immediately with
no app to build or install.

## Why this exists / how it works

`zcode`'s official product is a GUI desktop app; there is no official
headless server or self-hosted web UI. But the desktop app itself is just a
client of a documented (in `--help`, not the public docs) headless
subcommand: `zcode app-server`. It speaks a protocol it calls "**ZCode
Protocol**" over newline-delimited JSON on stdio — *not* JSON-RPC 2.0 (it
explicitly rejects a `jsonrpc` key). Messages are plain `{id, method,
params}` / `{id, result|error}`; the server also sends *server-initiated*
requests (id like `"server-1"`) that the client must answer, e.g. asking
permission before a risky tool call.

This was almost entirely undocumented and had to be reverse-engineered by
running the actual process and reading the vendored runtime bundle
(`vendor/zcode.cjs` in the `zcode-app-cli` npm package) — see
`bridge/zcodeClient.js`'s comments for the specific gotchas (message
framing, the exact permission-request schema, etc.).

```
Telegram (long-poll, no inbound port)
   │
   ▼
bridge/index.js  ──spawns──▶  zcode app-server  ──▶  Z.AI Coding Plan API
   │  (one process, many multiplexed sessions,
   │   one per Telegram topic)
   ▼
bridge/store.js (data/sessions.json: topic -> session, update offset)
```

## Setup

### 1. zcode runtime

There's no npm-published build with a working `npm install` in this
environment (arborist bug against the vendor tree — see git history /
ask if this changed), so the runtime was fetched and prepared by hand from
the `zcode-app-cli` npm tarball. `ZCODE_BIN` in `.env` points at
`bin/zcode.js` inside that extracted package; `ZCODE_NODE_BIN` points at a
plain Node 22.19+ (no other toolchain needed).

Login is **not** re-derivable from this repo — it's a stateful one-time
step against zcode's own TUI (`/login zai-coding-plan-api-key <key>`, since
Z.ai OAuth requires macOS). The resulting credential lives in
`~/.zcode/cli/config.json` under `provider.zai.options.apiKey` on whatever
host runs the bridge. If you need to re-run it: the API-key field name is
NOT `provider.zai.apiKey` (that's a decoy — matches a *different* provider
shape in the schema) — it's nested one level deeper, under `.options`.

### 2. Telegram bot

1. [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. `/setprivacy` on that bot → **Disable** (otherwise it only sees
   @-mentions, not every message in a topic).
3. Create a group, enable **Topics** in group settings, add the bot as a
   normal member (no admin needed — topics are created by hand in the
   Telegram UI, not by the bot).
4. Send one message in any topic, then hit
   `https://api.telegram.org/bot<token>/getUpdates` to read off the
   group's `chat_id` (negative number) and your own `user_id`.

### 3. Configure and run

Config lives at `~/.config/zcode-mobile-bridge/.env`, **not** `.env` in this
repo. That's deliberate: this repo *is* the workspace the zcode agent
itself operates in (topics are used to work on this very bridge), and a
secret sitting in the workspace root can get read and echoed back into
Telegram by completely ordinary "look at your own code" work under
auto-approve — no adversarial intent required. Override the path with
`ZCODE_MOBILE_ENV=/some/other/path` if you'd rather put it elsewhere.

```
mkdir -p ~/.config/zcode-mobile-bridge
cp .env.example ~/.config/zcode-mobile-bridge/.env   # fill in the values above
chmod 600 ~/.config/zcode-mobile-bridge/.env
npm install             # only real deps: none at runtime beyond Node itself
node bridge/index.js    # foreground, for testing
```

For a persistent service, see `deploy/zcode-bridge.service` (a `systemd
--user` unit — no root needed since the bridge binds no privileged port and
only long-polls Telegram outbound):

```
mkdir -p ~/.config/systemd/user
cp deploy/zcode-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zcode-bridge.service
```

`systemctl --user` needs `XDG_RUNTIME_DIR=/run/user/<uid>` set if your
shell doesn't already have it (e.g. a bare SSH session vs. a full login).
Requires lingering enabled for the account (`loginctl show-user <user>` —
look for `State=lingering`) so the service survives logout/reboot without
an active session; enabling it if it's not already on needs root
(`loginctl enable-linger <user>`).

The shipped unit only enables prctl/seccomp-based hardening
(`NoNewPrivileges`, `RestrictSUIDSGID`, `RestrictRealtime`). The
mount-namespace-based directives (`PrivateTmp`, `ProtectClock`,
`ProtectHostname`, `ProtectKernelLogs`, `ProtectKernelModules`,
`ProtectKernelTunables`, `ProtectControlGroups`) were tried and removed:
under `systemctl --user` on this host they fail the whole service with
`status=218/CAPABILITIES` — creating those namespaces needs privileges an
unprivileged user session manager doesn't have here. Confirmed empirically;
don't re-add without testing on the target host first.

Only one instance may run against a given store path at a time — `store.js`
takes an exclusive lock file (`data/sessions.json.lock`) at startup and
fails fast with a clear error if another process already holds it (stale
locks from a killed process are detected and reclaimed automatically). This
matters because the natural way to test a change (`node bridge/index.js` in
the foreground) targets the exact same default store path as the systemd
service — without the lock, two processes would silently clobber each
other's topic/session mappings and Telegram update offset.

Logs: `data/bridge.log` (also picked up by `journalctl --user -u
zcode-bridge`).

## Permissions / safety model

Sessions run in **`yolo` mode** by default (`ZCODE_DEFAULT_MODE=yolo`) —
zcode auto-approves its own tool calls, no round-trip needed. As a second,
independent safety net, if an `interaction/requestPermission` request still
arrives despite that (untested edge case — unclear whether yolo suppresses
*every* risk level), the bridge auto-approves it too and posts a
non-blocking `🔓 auto-approved: …` notice to the topic so there's still a
visible audit trail. Set `AUTO_APPROVE_PERMISSIONS=false` to fall back to
interactive Approve/Deny inline-keyboard prompts instead (this path is
implemented and was verified working before the auto-approve default was
added — see git history).

**This means messages in an allowed topic can run arbitrary tool calls
(shell commands, file edits) with no human approval step**, on a host with
no sandbox. The only gate is the `chat_id` + `user_id` allowlist in
`.env` — anyone who can author a message as that Telegram user has the same
authority zcode itself has on this box.

**The bridge (and the zcode subprocess it spawns) runs as whatever OS
account starts it — currently the same low-privilege "executor" account
that runs ordinary shell commands on this machine, not a dedicated account
of its own.** `~/.zcode/cli/config.json` (the Z.ai API key) and
`~/.config/zcode-mobile-bridge/.env` (the Telegram bot token) are therefore
both readable by that account. Relocating `.env` out of the workspace (see
above) closes the specific *in-band* leak path (an agent session reading
its own bridge's secrets during ordinary work); it does **not** provide
account-level isolation from anything else already running as that same
account on the host. A dedicated OS account with its own `$HOME` (and its
own `systemctl --user` instance, which needs root to enable lingering for a
new account) would close that gap properly; this hasn't been done because
it needs root access this bridge's own deployment doesn't have. Worth
doing if that's available.

## Turn lifecycle from Telegram

- **`/stop` or `/cancel`** in a topic with a turn in progress calls
  `session/stop` and clears the busy state immediately, instead of waiting
  for it to finish or time out.
- **A turn that never emits completion** (dropped event, an upstream hang
  that doesn't crash the app-server process outright) is force-cleared by a
  background sweep after `TURN_TIMEOUT_MS` (default 20 minutes) — without
  this, a single missed event would wedge that topic on the busy
  placeholder for the rest of the process's life.

## Known scope limits (intentional, not oversights)

- **No file upload/download.** Telegram messages without `text` (photos,
  documents, stickers, voice) are ignored. Not needed for the current use
  case.
- **One turn at a time per topic**, no queueing — a message sent while a
  topic's session is still processing the previous one gets a "still
  working" reply (or use `/stop` to cancel first) rather than being queued
  or interleaved.
- **No Goal Mode, subagents, MCP management, or model/mode switching
  commands from Telegram** — the zcode Protocol exposes RPCs for all of
  these (`session/goal`, `session/subagents`, `session/setMode`,
  `plugins/*`, `mcp/*`, ...) but the bridge doesn't surface them. Not
  needed for the minimal interface; would be straightforward to add per
  method if wanted later.
- **Replay after a restart is best-effort.** Subscriptions use
  `deliveryKind: "web-remote-replayable"`, but the bridge always
  re-subscribes fresh rather than tracking `eventSeq` to request a precise
  replay window — a turn that was in flight exactly when the process died
  may not have its tail end delivered on restart.

## Known issue: resumed sessions can still fail to send

Every bridge restart spawns a brand-new `zcode app-server` process (there's
no reconnection to a lingering daemon), so a topic used before the restart
calls `session/resume` to reload its session before doing anything else —
without this, that topic would be **permanently** broken after every
restart (confirmed: `session/subscribe`/`session/send` reject with `-32004
Session is not active` on a session the fresh process has never heard of,
forever, since the store keeps returning the same dead id). `session/resume`
fixes that for topics with real prior activity.

However: a resumed session can still report `session/resume` as successful
and then reject `session/send` with a zcode-internal error to the effect of
"the historical task's model is no longer available" — its model adapter
stays deferred/unmaterialized. Confirmed by direct testing that none of
`session/setModel`, switching models away and back, or passing `workspace`
on the `resume` call itself unstick it; this looks like a genuine zcode
limitation, not something wrong on the bridge's side, but it wasn't fully
reverse-engineered. The bridge's fallback: if `session/send` fails on a
resumed session, it automatically retries **once** with a brand-new session
(conversation history for that topic is lost, but the topic keeps working
instead of staying dead). You'll see this as a topic's next reply after a
restart occasionally starting a fresh conversation rather than continuing
the old one.
