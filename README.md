# zcode-tg

A Telegram bridge for [zcode](https://zcode.z.ai) (Z.ai's GLM coding agent):
**one Telegram forum topic == one zcode session.** Send a message in a
topic, get a reply; each topic keeps its own independent conversation.

- **Streaming replies** — the answer is edited into one placeholder message
  as it's generated, with a `⌛` status line (elapsed time, current tool)
  while the turn runs, and a usage footer (`⏱ duration · tokens · tool
  calls`) on completion.
- **Questions actually round-trip** — the agent's AskUserQuestion prompts
  appear as inline buttons and are answered from Telegram.
- **Files both ways** — send a document to the topic and the agent reads it
  (saved under `inbox/`); the agent can attach workspace files to replies,
  and `/file <path>` pulls one on demand.
- **Per-topic model & mode** — `/model`, `/mode` list and switch, persisted
  per topic.
- **Queueing, background-task notices, reply-to-quote, a pinned topic
  status line with plan-usage percentages, and graceful redeploys** that
  let in-flight turns finish instead of cutting them off.

## Status & disclaimer

Unofficial, community software. **Not affiliated with, endorsed by, or
supported by Z.ai** — "zcode" and Z.ai product names belong to their
respective owners. This project talks to `zcode app-server`, an interface
that is undocumented upstream; the findings in this repo were established
by observation and may break with any upstream release. Use of the Z.ai
API is governed by your own account's terms.

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

The protocol is minimally documented upstream (`zcode app-server --help`);
every behavior recorded in this repo was established by direct observation
of a running app-server. See `bridge/zcodeClient.js`'s comments for the
specific gotchas learned that way (message framing, the exact
permission-request schema, etc.).

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

Two install paths, equally supported: **Nix** (one command, brings its own
Node and the pinned zcode runtime) and **manual** (your own Node 22.19+ and
the runtime fetched by hand). Steps 1–2 are the same for both; pick your
path in step 3.

### 1. Telegram bot

1. [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. `/setprivacy` on that bot → **Disable** (otherwise it only sees
   @-mentions, not every message in a topic).
3. Create a group, enable **Topics** in group settings, add the bot as a
   normal member (no admin needed — topics are created by hand in the
   Telegram UI, not by the bot; promote it with pin rights later if you
   want the per-topic status message pinned).
4. Send one message in any topic, then hit
   `https://api.telegram.org/bot<token>/getUpdates` to read off the
   group's `chat_id` (negative number) and your own `user_id`.

### 2. Config file, and the one-time zcode login

Config lives at `~/.config/zcode-tg/.env`, **not** `.env` in this
repo. That's deliberate: this repo *is* the workspace the zcode agent
itself operates in (topics are used to work on this very bridge), and a
secret sitting in the workspace root can get read and echoed back into
Telegram by completely ordinary "look at your own code" work under
auto-approve — no adversarial intent required. Override the path with
`ZCODE_TG_ENV=/some/other/path` if you'd rather put it elsewhere
(`ZCODE_MOBILE_ENV` from before the repo rename still works, as does a
config file at the old `~/.config/zcode-mobile-bridge/` path if that's
what's already on your machine).

```
mkdir -p ~/.config/zcode-tg
cp .env.example ~/.config/zcode-tg/.env   # fill in the values from step 1
chmod 600 ~/.config/zcode-tg/.env
```

The zcode login is **not** re-derivable from this repo — it's a stateful
one-time step against zcode's own TUI (`/login zai-coding-plan-api-key
<key>`, since Z.ai OAuth requires macOS), run once on whatever host
operates the bridge (`nix run github:georgeee/zcode-tg#zcode` gives you
the CLI on the Nix path). The resulting credential lives in
`~/.zcode/cli/config.json` under `provider.zai.options.apiKey`. If you
ever need to re-run it: the API-key field name is NOT
`provider.zai.apiKey` (that's a decoy — matches a *different* provider
shape in the schema) — it's nested one level deeper, under `.options`.

### 3. Install and run

#### Option A — Nix

The flake packages **both halves**: `zcode` (the CLI runtime, pinned to a
specific npm tarball — the bridge is written against that runtime's
observed protocol behavior, so versions are bumped deliberately, not
automatically) and `zcode-tg` (this bridge, wired so its defaults point at
the packaged runtime and Node, and its state lives in
`~/.local/state/zcode-tg/`, outside the read-only store). Telegram
credentials are never baked in — same `~/.config/zcode-tg/.env` as above.

```
nix run github:georgeee/zcode-tg              # the bridge
nix run github:georgeee/zcode-tg#zcode        # the runtime CLI
nix profile install github:georgeee/zcode-tg  # both on PATH
```

As a flake input (this is how [agent-cage](https://github.com/georgeee/agent-cage)
consumes it — mirror of how it consumes claude-code-nix):

```nix
inputs.zcode-tg-flake = {
  url = "github:georgeee/zcode-tg";
  inputs.nixpkgs.follows = "nixpkgs";
};
# overlays = [ zcode-tg-flake.overlays.default ];  ->  pkgs.zcode, pkgs.zcode-tg
```

Bumping the pinned runtime = change `version` + `hash` in `nix/zcode.nix`
(hash via `nix store prefetch-file <tarball-url>`) and re-verify the bridge
against the new runtime before deploying.

#### Option B — manual

There's no npm-published zcode build with a working `npm install` at the
time of writing (arborist bug against the vendor tree), so the runtime has
to be fetched and prepared by hand from the `zcode-app-cli` npm tarball.
`ZCODE_BIN` in `.env` points at `bin/zcode.js` inside that extracted
package; `ZCODE_NODE_BIN` points at a plain Node 22.19+ (no other
toolchain needed). The bridge itself has zero npm dependencies:

```
node bridge/index.js    # foreground, for testing
```

### 4. Persistent service (either path)

`deploy/zcode-bridge.service` is a `systemd --user` unit template — no
root needed since the bridge binds no privileged port and only long-polls
Telegram outbound. Adjust `WorkingDirectory` and `ExecStart` to your
install:

```
# Nix: point straight at the built wrapper (the repo checkout is not needed)
ExecStart=$(nix build --no-link --print-out-paths github:georgeee/zcode-tg)/bin/zcode-tg

# Manual: repo checkout + your node
ExecStart=/usr/bin/env node bridge/index.js
```

```
mkdir -p ~/.config/systemd/user
cp deploy/zcode-bridge.service ~/.config/systemd/user/   # edit as above
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
under an unprivileged `systemctl --user` manager they can fail the whole
service with `status=218/CAPABILITIES` — creating those namespaces needs
privileges a user session manager may not have. Confirmed empirically on
at least one host; don't re-add without testing on the target host first.

Only one bridge instance may run against a given store path at a time —
`store.js` takes an exclusive lock file at startup and fails fast with a
clear error if another process already holds it (stale locks from a
killed process are detected and reclaimed automatically). This matters
because the natural way to test a change (running the bridge in the
foreground) can target the exact same default store path as the systemd
service — without the lock, two processes would silently clobber each
other's topic/session mappings and Telegram update offset.

Logs: `data/bridge.log` when run from a checkout (the unit template
appends there; `journalctl --user -u zcode-bridge` picks it up), or your
journal directly under the Nix wrapper.

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
account starts it — pick that account deliberately.** `~/.zcode/cli/config.json`
(the Z.ai API key) and the bridge's `.env` (the Telegram
bot token) are both readable by that account, as is everything else it can
reach. Relocating `.env` out of the workspace (see above) closes the
specific *in-band* leak path (an agent session reading its own bridge's
secrets during ordinary work); it does **not** provide account-level
isolation from anything else running as that same account. For real
isolation, give the bridge a dedicated OS account with its own `$HOME`
(and its own `systemctl --user` instance; enabling lingering for a new
account needs root).

## Commands & turn lifecycle from Telegram

The bridge intercepts its own commands before anything reaches the model
(registered for `/` autocomplete via `setMyCommands` on every boot; anything
else starting with `/` — e.g. zcode's own `/init`, `/memo` — is passed
through to the model as ordinary input):

| | |
|---|---|
| `/usage` | Z.ai plan quota, from the account's own monitoring endpoint (`/api/monitor/usage/quota/limit`); key read point-of-use from zcode's config |
| `/stop`, `/cancel` | cancel the topic's running turn (`session/stop`) |
| `/queue` | list this topic's queued messages |
| `/clearqueue` | drop this topic's queued messages (their "Queued" notices are edited to "Dropped") |
| `/model [name]` | list this topic's available models (current one marked `▶`) / switch (`session/setModel`, persisted per topic) |
| `/mode [name]` | list session modes (current marked) / switch (`session/setMode`, persisted per topic) |
| `/file <path>` | send a file from the workspace into the topic as a document (realpath-restricted to the workspace subtree, `MAX_FILE_MB` cap) |
| `/help` | the list above |

- **Replies stream**: the turn's placeholder message is edited in place as
  the model works — prefixed `⌛` with an elapsed-time/current-tool status
  line while running (so the last message in the topic always shows the
  turn is in progress), and the text itself as `text_delta` events arrive,
  at most one edit per `STREAM_EDIT_INTERVAL_MS` (default 5s; anything
  produced inside the window folds into the next edit). On completion the
  preview is replaced by the authoritative full render plus a small usage
  footer (`⏱ duration · tokens in/out · tool calls`). `bridge/streamer.js`
  owns the throttling.
- **The elapsed-time counter has its own heartbeat, separate from real
  content.** `update()` — and so a fresh render of "elapsed" — only ever
  fires from an actual protocol event; a turn stuck inside ONE long tool
  call (a VM boot, a slow test run, ...) can go many minutes with none.
  Without a heartbeat the displayed `· 117s` freezes at whatever it was on
  the last event, and a turn that's genuinely still working looks
  abandoned from the chat. Found live (2026-09-01): a task 130+ minutes and
  28 tool-call iterations in — confirmed still active via a fresh
  `tool.call.started` in zcode's own structured log — looked dead from a
  placeholder whose counter hadn't moved in a long while. `STREAM_HEARTBEAT_MS`
  (default 60s) nudges a re-render on a timer independent of real events;
  0 disables it and restores the old behavior.
- **The model can ask questions**: `interaction/requestUserInput` (the
  AskUserQuestion tool) is posted to the topic as inline-button prompts and
  genuinely answered from Telegram (one tap per question; multi-select
  questions are single-pick — a Telegram-buttons limitation). No answer
  within `USER_INPUT_TIMEOUT_MS` (default 10 min) → auto-declined so the
  turn keeps moving.
- **Each topic gets a status message** — one compact line:
  `📌 idle · no queued · 11% session / 5% week` (one-word
  state, queue depth as `N queued`/`no queued`, Z.ai plan usage as
  percentages only: short-term "session" window and weekly window). Created
  at topic creation (the topic's first message, so it never occupies
  conversational space near the latest messages) and edited in place on
  every state change after that (including queue-depth changes: queueing
  or dropping messages updates the line immediately). The usage figures come from the same quota
  endpoint as `/usage`, cached for 5 minutes (status writes fire per turn
  and the monitor endpoint is rate-limit-sensitive) and omitted while
  unavailable. It's pinned when the bot has admin `can_pin_messages` rights
  — promote the bot if you want the pin; until then the bridge retries
  quietly on every state change. Deleting the message disables it for that
  topic; past Telegram's 48-hour edit window it's replaced (old deleted,
  new posted + pinned) so exactly one exists.
- **The model can attach files**: a `[file: <path>]` marker in a reply is
  stripped by the bridge and the path is sent as a document (workspace
  subtree only, `MAX_FILE_MB` cap, max 5 per reply) — the protocol has no
  native file-emit mechanism, so this convention (documented to the agent in
  its instructions file) is the mechanism. `/file` does the same thing on
  the user's initiative.
- **Background tasks**: a task the agent left running that completes while
  the session is idle gets a `🌀` notice, and the turn the runtime
  auto-starts for the `<task-notification>` input is adopted (fresh ⌛
  placeholder, normal delivery) — without adoption its reply would be
  generated, persisted, and never delivered.
- **Replying to an earlier Telegram message** quotes it (up to 600 chars)
  into the prompt sent to the model, so follow-ups can point at a specific
  earlier message.
- **A message sent while a turn is still running is queued**, not rejected:
  the bridge posts a `📥 Queued (position N)` notice, and that notice becomes
  the turn's placeholder when the message is dequeued — the reply lands on
  the message the user saw accepted. Queues are persisted
  (`data/sessions.json`) and drained in order when the current turn ends,
  fails, or is cancelled; they're also restored and drained on
  startup after a restart. Capped at `MAX_QUEUE_PER_TOPIC` (default 20).
- **`/stop` or `/cancel`** in a topic with a turn in progress calls
  `session/stop` and clears the busy state immediately, instead of waiting
  for it to finish — then the next queued message (if any) runs.
- **The turn-timeout watchdog is off by default** (`TURN_TIMEOUT_MS=0` —
  the old 20-minute default killed real, merely-slow turns, and long turns
  are normal for agentic work). `/stop` is the
  designated escape hatch for a wedged topic. Setting `TURN_TIMEOUT_MS`
  re-arms the automatic sweep (which stops the turn server-side first, so a
  timeout behaves like `/stop`).
- **Model replies are rendered to Telegram HTML** (`bridge/format.js`):
  fenced/inline code, bold/italic/strike, links, headings, lists and quotes;
  everything else passes through escaped. Replies longer than one message
  are split at safe boundaries (an interrupted code block is reopened in the
  next chunk). If Telegram ever rejects the rendered entities, the chunk
  falls back to tag-stripped plain text rather than being lost.

## Known scope limits (intentional, not oversights)

- **Inbound files: documents only.** Sending a document (any file up to
  `MAX_INBOUND_FILE_MB`, default 20 — Telegram's hard bot download cap)
  saves it to `inbox/telegram/<timestamp>-<name>` in the workspace and
  starts a turn whose prompt tells the agent where it landed; your caption,
  if any, rides along as the instruction. Photos, stickers and voice are
  still ignored. Outbound (`/file` and the model's `[file: …]` markers)
  is deliberately restricted to the workspace subtree — the bridge account
  can read files (e.g. `~/.zcode` credentials) that must not become one tap
  away from chat.
- **No Goal Mode, subagents, or MCP management from Telegram** — the zcode
  Protocol exposes RPCs for these (`session/goal`, `session/subagents`,
  `plugins/*`, `mcp/*`, ...) but the bridge doesn't surface them. Model and
  mode switching ARE exposed (`/model`, `/mode`).
- **Replay after an UNplanned death is best-effort.** Subscriptions use
  `deliveryKind: "web-remote-replayable"`, but the bridge always
  re-subscribes fresh rather than tracking `eventSeq` to request a precise
  replay window — a turn that was in flight exactly when the process died
  may not have its tail end delivered on restart. Concretely: a message
  whose turn was killed mid-flight by a crash, OOM, or `SIGKILL` is in no
  queue and is gone; its `⌛` placeholder stays as-is (only messages *queued
  behind* a running turn are persisted and drained on startup). This does
  **not** apply to an ordinary redeploy (`SIGTERM`/`SIGINT`) — see
  "Redeploying" below, which drains in-flight turns first specifically to
  avoid this.

## Restart continuity: resume + catalog warm-up

Every bridge restart spawns a brand-new `zcode app-server` process (there's
no reconnection to a lingering daemon), so a topic used before the restart
calls `session/resume` to reload its session before doing anything else —
without this, that topic would be **permanently** broken after every
restart (confirmed: `session/subscribe`/`session/send` reject with `-32004
Session is not active` on a session the fresh process has never heard of,
forever, since the store keeps returning the same dead id).

Resuming alone used not to be enough: a cold process also has an **empty
model catalog for every workspace key** (only `workspace/updateProviderRegistry`
— part of the desktop app's workspace-open flow — fills it), so a plain
resume took zcode's "deferred model adapter" path: `session/resume` reports
success, then every `session/send` rejects with `ZCODE_RUNTIME_MODEL_UNAVAILABLE`
("历史任务使用的模型已不可用"). `session/setModel` does not clear it. The bridge now
**warms the catalog before every resume** (`warmWorkspaceCatalog()` in
`bridge/index.js`): `workspace/readState` for the model list, then a registry
push of the `zai` provider as `source:"user"` with the `baseURL`/`apiKey`
from `~/.zcode/cli/config.json` (builtin-source pushes are filtered out by
the runtime, and user-source providers must state what builtins resolve
internally). Verified live: a scratch session killed and resumed this way
keeps its conversation context across the restart.

The one-shot fresh-session retry on send failure remains as a fallback for
whatever else can go wrong — if it ever fires now, that's a new bug worth
looking at, not the known deferred-adapter one.

## Redeploying: graceful drain, not an interrupt

A real blue-green deploy (old and new processes overlapping) isn't
available here: Telegram's `getUpdates` long-poll tolerates exactly one
consumer, `data/sessions.json`'s lock is exclusive to one process, and each
process owns its own `zcode app-server` child holding all session state.
So `shutdown()` (`bridge/index.js`, on `SIGTERM`/`SIGINT`) does the version
of zero-downtime that IS available in a single process:

1. Immediately stop admitting new work — messages arriving during a drain
   get an instant "queued, deploying" notice instead of starting a turn, so
   the bridge stays visibly responsive the whole time (no radio silence).
2. Wait, bounded by `SHUTDOWN_DRAIN_MS` (default 25 min — agentic turns
   regularly run 10–30+ minutes, see the watchdog note above), for every
   turn already in flight to finish **naturally** through the ordinary
   delivery path. A turn that finishes during this window is delivered
   exactly as if nothing were happening; nothing about it is interrupted.
3. Whatever's still running once that window elapses gets the
   interrupt-and-notify treatment (placeholder edited to say the turn was
   cut off by a restart) — the previous, unconditional behavior — before the
   process actually exits.

`deploy/zcode-bridge.service` sets `TimeoutStopSec=1800` so systemd's own
stop timeout can't SIGKILL the process out from under a drain that's
legitimately still waiting. Set `SHUTDOWN_DRAIN_MS=0` to skip draining and
go back to interrupting immediately (e.g. for a deploy you know must land
fast, at the cost of whatever's running).
