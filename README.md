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
`ZCODE_TG_ENV=/some/other/path` if you'd rather put it elsewhere.

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

### `NATIVE_SEARCH_ENHANCEMENTS` — for split-privilege deployments

The zcode runtime asks the bridge, over `session/requestRuntimePreferences`,
whether to enable its "native search enhancements". When enabled — which is
what the runtime falls back to if nobody answers — it writes a per-session
bash prelude (`bash-startup/<session>/embedded-search-startup-<hash>.sh`,
shadowing `find`/`grep` with `bfs`/`ugrep`) at mode `0600`, and `source`s it
at the head of every bash tool call.

That is fine when the agent and its shell are the same OS account. It is not
fine when they are deliberately different — as in a privilege-split
deployment where the model's commands run as an unprivileged executor: the
prelude belongs to the agent, `source` needs read permission, and every
single command prints

```
/bin/bash: line 1: .../embedded-search-startup-<hash>.sh: Permission denied
```

before its real output. The file's mode cannot be widened from outside (the
runtime passes `0600` to `writeFileSync` *and* re-asserts it with
`chmodSync`; a POSIX ACL does not survive that chmod, because chmod rewrites
the ACL mask from the group bits and `0600`'s are zero).

Set `NATIVE_SEARCH_ENHANCEMENTS=false` on such a deployment. The prelude is
then never generated, the noise disappears, and nothing is lost — the
shadowing was never in effect there anyway, since the `source` always failed.
Default is on, for the single-account case that genuinely benefits from it.

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

## MCP gateway: a second model driving the same conversations

`MCP_UNIX_SOCKET` turns on a small **MCP (Model Context Protocol) server
inside the bridge process** (JSON-RPC 2.0, one request per line — the
stdio-MCP wire format, served over a **per-fleet unix domain socket**).
Its purpose: let another model — a junior agent — drive the very same
conversations the Telegram frontend serves. Every prompt sent through MCP
is mirrored into the topic **from the bot's identity**, and every reply is
both delivered to the topic and returned to the MCP caller, so the Telegram
chat stays the shared log no matter which frontend typed.

Seven tools:

| tool | what it does |
|---|---|
| `session_create` | Create a named session: a new forum topic + a fresh agent session; returns the conversation `key` and the `model` it runs. Takes an optional `backend` (`zcode`, `codex`, or `mock`) and, for `codex` only, an optional `model` — see below. Without `chat_id` the target is **auto-picked**: the forum-enabled groups the bot knows (Topics enabled, bot-admin preferred, most recently used first) — see below. |
| `message_send` | Send a prompt to a session and (by default, `wait: true`) block until the final reply — a real turn, streamed into the topic meanwhile. `wait: false` queues and returns at once. |
| `replies_get` | Catch-up read: replies already collected for a conversation since a sequence number (the in-memory log keeps the last 200 per conversation). |
| `session_close` | Close the session and its Telegram topic; further `message_send` to the key names the error. |
| `model_get` | The backend and model a session runs, and whether `model_set` can change it (`true` for `codex`, always `false` for `zcode` and `mock`). |
| `model_set` | Switch an existing session's model. `codex` only, among the same three tiers `session_create` offers — `zcode` and `mock` sessions refuse with a clear error, not a silent no-op. |
| `usage_get` | Read-only: this account's Z.ai plan usage per quota window (used, cap, remaining, reset time) — the same data `/usage` renders as Telegram HTML, as plain fields. Lets a supervisor model track spend across the sessions it delegates. Cached up to 5 minutes, shared with the topic status line's own refresh, to protect the account's rate-limited monitoring endpoint — except on the very first call this bridge has ever made, which awaits one real fetch rather than answering an error. |

**Model policy differs by backend, on purpose.** zcode sessions always run
the bridge default (`zai/glm-5.3-flash`) — there is deliberately no way to
switch it over MCP, unchanged from before Codex existed. Codex sessions may
choose among exactly three of its four everyday tiers: `gpt-5.6-luna`
(fastest/cheapest, ~Haiku), `gpt-5.6-terra` (balanced, ~Sonnet — **the
strong default** if `model` is omitted), or `gpt-5.6-sol` (Codex's
flagship, ~Opus). `gpt-6-astra` — Codex's newest and most expensive model,
and confirmed to be Codex's own *server-side* default absent an override —
is never offered here: neither `session_create`'s `model` argument nor
`model_set` will accept it, by an exact-match allowlist rather than a
pattern check, so a future Codex model name is refused by default rather
than silently admitted for resembling one of these. Telegram's own
`/model` command is unrestricted (a human may pick any model including
Astra) unless the deployment sets `CODEX_DISALLOW_ASTRA`. `mock` sessions
have exactly one model (`mock-1`) and, like zcode, refuse a `model`
argument outright — see "The mock backend" below for why that's the right
policy for a single-model backend, not just zcode's rule reused by default.

The three-tier allowlist is a default, not a constant: `CODEX_MCP_MODELS`
(env, comma list) replaces it wholesale — name one model and the bridge's
MCP surface is pinned to exactly that one (refusals name the configured
set), so a deployment that must spend only Terra sets
`CODEX_MCP_MODELS=gpt-5.6-terra` alongside `CODEX_DEFAULT_MODEL`.
Unset/empty restores the three tiers. Telegram's `/model` is not narrowed
by this knob.

**Telegram's `/model` spans every backend.** With no argument it lists the
models of every configured backend, grouped by backend and marking the
topic's current backend+model; a backend that cannot be constructed (no
`CODEX_HOME`, say) or cannot answer is a one-line note — the rest still
lists. Picking a model resolves it against ALL the backends' lists, and the
resolution always carries the backend it was found in: same backend as the
topic, the ordinary in-session switch; a model only another backend offers,
a fresh session on THAT backend opened with the picked model (history does
not carry over — the reply says so). A name two backends both offer is
refused with both named; the qualified form `/model backend:name` (e.g.
`/model codex:gpt-5.6-terra`) always resolves exactly. zcode's bare-name
shorthand (`glm-5.3` → `zai/glm-5.3`) still works, and only when the bare
name resolves nowhere on its own.

The span is configurable: `MODEL_BACKENDS` (env, comma list) names exactly
the backends `/model` lists and resolves against. Unset, it is every
backend **except mock** — the zero-credential test double must not appear
in a production bridge's `/model`, be constructed by it, or answer a
`mock:` qualified ref (the refusal is "unknown backend", and the backend is
never touched). A bridge whose `DEFAULT_BACKEND` is mock — or which eagerly
starts mock via `EAGER_BACKENDS` — is itself a test bridge and sees mock
unless the operator names a list without it. Unknown `MODEL_BACKENDS` names
refuse to boot; `/backend` is unaffected and can still switch a topic to
mock by hand.

Backends start EAGERLY or lazily by configuration: whichever backend
`DEFAULT_BACKEND` names is constructed and started at boot and is
load-bearing (its death takes the bridge down for the service manager to
restart); every other backend starts lazily, the first time a topic or MCP
call asks for it. A deployment that wants additional backends constructed
at boot names them in `EAGER_BACKENDS` (comma list) — unknown names refuse
to boot, and unset keeps the default-backend-only behavior, so a
codex-default bridge never spawns `zcode app-server` unless asked.

### The mock backend: zero credentials, zero subprocesses, zero cost

`backend: 'mock'` (Telegram: `/backend mock`) is a third backend that needs
**no configuration at all** — no credential file, no CLI binary, no
subprocess. It exists purely to exercise this MCP machinery (and the
Telegram `/backend`/`/model` commands) for real, end to end, without
spending anyone's z.ai or Codex quota — useful for CI, for a from-scratch
smoke test of a fresh deployment, or as `DEFAULT_BACKEND=mock` for a
deployment that wants zero external dependencies.

A mock session's `sendMessage` resolves immediately (no I/O at all) and its
reply is always a synthetic echo, obviously labeled so it's never mistaken
for a real model's output: `[mock echo] <your prompt>`. `listModels()`
reports exactly one model (`mock-1`); `model_get`/`model_set` report
`switchable: false` — not because MCP can't support switching (Codex proves
it can) but because a single-model backend has nothing to switch to or
from, and a fake "switch" that reports success would be a worse contract
than refusing outright. See `bridge/backends/mockBackend.js` for the
implementation (modeled on `zcodeBackend.js`/`codexBackend.js`'s shape —
the `Backend` contract in `bridge/backend.js` — but trivial in substance).

Configuration (in the bridge's env, off by default):

  The bridge creates the socket's parent directory, unlinks a stale socket
  before binding, and chmods the socket `0600` after binding — with the
  permissions being the authentication, a chmod failure kills the listener
  loudly rather than serving a group/world-reachable socket. Framing is one
  JSON-RPC message per line (stdio-style, no HTTP), safe against multibyte
  characters split across reads.
- `MCP_UNIX_SOCKET` — the per-fleet unix socket to listen on. **Off unless
  set.** The socket file is created 0600 inside the bridge's own state
  directory, and those permissions ARE the authentication: only the account
  running the bridge can connect, there is no wire to encrypt (the
  conversation never leaves the kernel), and per-fleet paths cannot collide
  the way a fixed loopback port does across fleets. A loopback TCP port
  would hand the junior agent to every local account — including an
  executor running model-authored commands — which is why the TCP listener
  (`MCP_HTTP_PORT`) is a test/dev convenience only.

- `MCP_HTTP_PORT` — loopback HTTP POST `/mcp`, for tests and curl. Off
  unless set; never used in production.

The senior model's side is a stdio MCP server that pipes to the socket:
`cage zcode-mcp <socket>` (part of agent-cage). On a cage fleet it is
seeded automatically — claude's MCP config gains a `cage-zcode` stdio
server whose command is the fleet's own `cage` binary, pre-approved, with
the socket path pointing at this bridge.

The reply wait is bounded (10 minutes per `message_send`); a turn still
running past that returns a timeout error pointing at `replies_get`. A
session-creation failure surfaces to the MCP caller as the same failure
notice the Telegram user would see. `message_send` rides the ordinary
dispatch pipeline: queueing behind a running turn, deploy-drain semantics,
and the reply footer are all shared with the Telegram path.

**When the reply cannot come, the caller is told, and told what is not
known.** Two events make a reply impossible: the zcode runtime exiting
underneath the turn, and the bridge itself restarting. Both used to leave the
caller parked for the full ten minutes and then hand it "the turn may still be
running", which by then was false — and usually not even that, because the
process exited first and the caller simply saw its connection drop, which
reads exactly like a network hiccup. Every parked `message_send` is now failed
first, with a sentence that states the cause is NOT established:

> the zcode runtime exited while this turn was running (code=null
> signal=SIGKILL). The bridge does not know why: a process killed by a signal
> cannot report anything on its way out. SIGKILL here is most often the kernel
> out-of-memory killer — this host, or this pod, ran out of memory. The turn is
> lost and no partial answer was delivered. The bridge restarts automatically;
> retry in a few seconds […]

The point of the wording is that a supervising model can act on it: "the
junior agent is broken and I do not know why" is a different decision from
"the junior agent is thinking", and the two used to be indistinguishable. A
redeploy gets the corresponding sentence, matching the notice the Telegram
side has always had in its topic.

**The same applies to a turn that dies without the bridge dying.** Three
paths post an apology to the topic and then return normally — the session
could not be created, `session/send` was rejected or timed out, the queue was
full and the message was dropped. For a Telegram user those notices are the
whole story; an MCP caller used to get nothing from them and sat out the full
ten minutes. Each now fails the parked caller for THAT conversation only,
with the same information at the same moment, and leaves every other topic
waiting.

What is still a genuine wait: a runtime that HANGS rather than dies. Nothing
resolves, nothing rejects, and the ten-minute timeout is the honest answer —
"no reply within 600s, the turn may still be running; use `replies_get`" is
true in that case, which is the one case it was ever meant for.

**Auto-picked `session_create` targets.** The Bot API has no "list the chats
this bot is in", so the bridge remembers every group it has served (owner
message seen, topic created, bot added — persisted in the store, throttled to
one touch per minute per chat) and, when `session_create` arrives with no
`chat_id`, re-validates those candidates live: `getChat` must say Topics are
enabled *right now*, `getChatMember` whether the bot is an administrator.
Ranking: forums only, admin-run forums over member forums, then most
recently served first. The configured `TELEGRAM_CHAT_ID` is just one more
candidate — ranked by its own real activity, never privileged — so a stale
value can no longer break the default (the 2026-09-10 cage-pod failure:
`createForumTopic` against a non-forum home chat, Telegram's "the chat is
not a forum"). With nothing eligible the tool fails with a line per rejected
candidate saying why; an explicit `chat_id` always wins.

### The antigravity backend: Google's Antigravity CLI (`agy`), MCP-only by design

The fourth backend runs **Google's Antigravity CLI** (`agy`, the gemini-cli
successor on a Google AI Pro subscription) in its headless **stream-json**
mode, exactly one model — `gemini-3.8-flash`, per owner decision (2026-09-24)
— with reasoning effort as the only knob (`--effort low|medium|high`, default
`medium`). Where codex multiplexes every thread over one `codex app-server`
process, agy's protocol has no multiplexing: this backend keeps **one `agy`
process per conversation**, writing user turns to its stdin and reading
`init` / `step_update` / `result` NDJSON events from its stdout. Resume is a
respawn with `--conversation <id>` (conversations persist as SQLite under
the agy HOME, so history survives both process and bridge restarts); cancel
is SIGTERM (agy answers with a structured interrupted result, and the
conversation survives).

Two properties are deliberate and owner-mandated:

- **Auto mode, twice over.** Every session spawns with
  `--dangerously-skip-permissions` AND the account settings get
  `toolPermission: "always-proceed"` (plus telemetry/tips/survey off,
  terminal color scheme — seeded as a MERGE into
  `$AGY_HOME/.gemini/antigravity-cli/settings.json` on first start, never
  clobbering agy's own keys). The real safety boundary is not agy's
  permission prompts but the same executor-shim arrangement the other
  backends sit behind. There is no approval relay on this surface: with
  `AUTO_APPROVE_PERMISSIONS=false` the flag is withheld, but the backend is
  not otherwise usable that way yet (a mid-turn prompt would just stall the
  turn inside agy).
- **`--remote-control` on every session.** Each session registers itself
  with the antigravity.google Remote Control dashboard, so the same
  conversation is visible and drivable from the owner's phone. This is
  agy's own session-scoped feature — the tunnel lives and dies with the
  session process, no OS service is installed, and it has nothing to do
  with the Claude `remote-control --session-id` capacity trap described in
  the workspace AGENTS.md.

**Telegram is not needed.** A deployment can run this backend MCP-only: set
`MCP_UNIX_SOCKET` (or `MCP_HTTP_PORT`) and the antigravity config below but
no `TELEGRAM_*` at all, and the bridge boots with a stub Telegram client —
`session_create` / `message_send` / `replies_get` / `usage_get` /
`model_get` / `model_set` all work; every Telegram call is a no-op. A
missing bot token WITHOUT any MCP listener still refuses to boot with the
usual config-file pointer. The Telegram path is unchanged when configured.

**Model policy over MCP** (written up with the others in CLAUDE.md):
`model_get` reports `switchable: true`, and `model_set` / `session_create`'s
`model` argument accept the bare ref (keeps the current effort) or an
effort variant — `gemini-3.8-flash:low|medium|high`. Effort is a spawn-time
flag, so a switch stops the session's process and the next turn resumes the
SAME conversation with the new `--effort`; anything else is refused with a
clear error, never silently ignored. `listModels()` offers exactly the one
ref.

**`usage_get` on an antigravity-default bridge is local accounting only.**
There is no remaining-quota number headless (agy's `/usage` with its
progress bars is TUI-only): the answer is the token total summed from every
turn envelope since bridge start (plus input/output split and turn count),
and a `quotaError` field when a RESOURCE_EXHAUSTED-family error has been
seen. The window carries `cap`/`remaining`/`percentage` as null — never an
invented figure.

Configuration (off unless `AGY_HOME` is set, same lazily-started pattern as
codex):

- `AGY_HOME` — the agy credential HOME (the `CODEX_HOME` analogue): holds
  `.gemini/antigravity-cli/antigravity-oauth-token` (0600, the Linux
  keyring-fallback file). One login per bridge model account, done out of
  band with `agy`'s paste-code flow; never a path under the workspace, and
  never anything the executor account can read. Required — the backend
  refuses to construct without it.
- `AGY_BIN` — the `agy` binary (default `agy` on PATH; the nixpkgs package
  is `antigravity-cli`, unfree). Note `agy install` (shell-profile
  mutation) and `agy update` (self-update outside nix) must never be run.
- `AGY_EFFORT` — the default effort for new sessions: `low`, `medium`
  (default) or `high`.

Process GC (2026-09-24). agy's stream-json mode has no multiplexing: every
session IS a process, an idle one costs 93–181 MB of anonymous RSS, and
before the GC the children of finished sessions were never reaped. Now:

- `AGY_IDLE_CLOSE_MIN` — close a session's process after this many idle
  minutes (default 20; `0` disables). The idle clock runs from the end of
  the last turn (the `result` event) or from the spawn; a session with a
  turn in flight is **never** reaped. Closing a process never loses a
  conversation: agy persists it under `AGY_HOME`, and the next message
  respawn-resumes with `--conversation` (the session's stored effort comes
  back with it). Every reap is logged:
  `reap key=<key> idle=<m>m reason=idle`.
- `AGY_MAX_PROCS` — live agy processes per bridge (default 4). A new
  process at the cap first evicts the least-recently-used **idle** child
  (`reason=cap` in the log) and waits for it to exit — the cap holds at the
  process level, not just in the bridge's registry. With every live child
  mid-turn there is nothing evictable and the request is refused with an
  actionable error listing the busy keys and their turn ages:
  `antigravity: 4 sessions busy (cap 4): <key> 3m12s, ...; retry or
  session_close one`.
- **MCP creator tie** — the MCP connection that created a session
  (`session_create`) is recorded; when that connection closes, its idle
  sessions close immediately and its busy ones right after their turn ends
  (`reason=creator-gone`). Sessions created from Telegram are unaffected,
  and a session picked up later by another connection just respawn-resumes
  — the conversation was never lost.
- **Shutdown & orphans** — on bridge stop every child gets stdin EOF, then
  `SIGTERM`, then `SIGKILL`, all inside 15 s. Every child also carries a
  `CAGE_AGY_BRIDGE` marker in its environment (a hash of the bridge's state
  path); at boot the bridge sweeps its own uid's `/proc` for
  marker-carrying processes whose parent is not itself — the leftovers of a
  SIGKILLed or crashed predecessor — and TERM/KILLs them. The sweep skips
  unreadable entries, so `hidepid`/`ProtectProc` mounts are safe.
- **Visibility** — the pinned per-topic status line shows
  `<n> agy · <rss> MB` while children are live, and the antigravity
  `usage_get` answer carries an `agyProcs` block (`live`, `totalRssBytes`).

Known scope limits (intentional): no per-tool hard kill (`/stop` SIGTERMs
the session process; agy auto-backgrounds long shell commands internally
and they are not addressable from the stream); the model's `ask_question`
tool has no Telegram relay on this surface and blocks the turn inside agy
until its own timeout; first runs are slow (5–15 s cold skill unpack per
HOME); and the nix-built binary is unfree and closed-source — protocol
drift shows up as a broken backend, which is what the fake-`agy` test
fixture pins.

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
| `/model [name]` | list the models of EVERY configured backend (grouped by backend, current one marked `▶`; a backend that cannot be constructed or answer is a one-line note, the rest still lists) / switch. Same backend as the topic: in-session switch, history kept. A model only ANOTHER backend offers: a FRESH session on that backend, opened with the picked model — history does not carry over. A model name two backends both offer is refused until qualified: `/model backend:name` (e.g. `/model codex:gpt-5.6-terra`) always works |
| `/mode [name]` | list session modes (current marked) / switch (`session/setMode`, persisted per topic) |
| `/backend [name]` | list / switch this topic's backend (`zcode`/`codex`/`mock`) — starts a FRESH session on the new backend; history does not carry over |
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
- **`/stop` or `/cancel`** in a topic with a turn in progress is a HARD
  interrupt. It calls `session/stop` (aborting the model stream and future
  steps), kills the session's in-flight tool processes — found via `/proc`
  by the session id on their command lines, as a full process tree so
  nothing is orphaned — and cancels its known background tasks
  (`session/cancelBackgroundTask`). Without the kill, a tool that's
  executing right now (a blocking `TaskOutput`, a long bash) holds the turn
  until it returns on its own: the runtime's abort only lands at the next
  boundary. Then the busy state clears and the next queued message (if any)
  runs.
- **Blocking TaskOutput waits have a circuit breaker**: a turn whose current tool has been `TaskOutput(block=true)` for longer than `TASK_BLOCK_LIMIT_MS` (default 15 min) is auto-interrupted with an explanatory notice, while its background tasks keep running — their completion notifications are the mechanism the model should have waited for instead of blocking. Ends the multi-hour TaskOutput camps observed live; 0 disables.
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
