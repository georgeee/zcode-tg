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

## Known scope limits (intentional, not oversights)

- **No file upload/download.** Telegram messages without `text` (photos,
  documents, stickers, voice) are ignored. Not needed for the current use
  case.
- **One turn at a time per topic.** A message sent while a topic's session
  is still processing the previous one gets a "still working" reply instead
  of being queued or interleaved.
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
