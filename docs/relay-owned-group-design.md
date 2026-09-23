# One bot, one group: the relay-owned shared-group design

How every fleet's bridge comes to share ONE Telegram group served by ONE bot —
the relay's — without the bridge's Bot API client changing in any way that
matters, by putting a Bot-API-compatible proxy where today only a test fake
lives.

Written against `zcode-tg` @ `usage-onto-pin` (`1b980d1`) and `agent-cage` @
`main` (`0d99fe1`, v0.6.0). Line references are to those trees and will drift;
the function names are the durable half.

> **Supersedes `docs/shared-group-design.md` (2026-09-23) on the owner's
> decision.** The older doc's topology — one *managed bot* per `<fleet, model>`
> pairing, provisioned through the relay — is dropped as too tedious: every
> managed bot needed two human taps, and no Bot API call adds a bot to a group,
> so the per-pairing cost was paid by a person, for every pairing, for ever.
> Its sections 1–4 remain the factual base this design builds on — the bridge's
> owner gate (`bridge/index.js:2328` `handleMessage`, "THE OWNER GATE IS THE
> ONLY GATE"), the relay's topic-blind transport
> (`internal/chat/telegram/receive.go:17-47` decodes no `message_thread_id`),
> the single-consumer `getUpdates` rule, `/use-group` discovery through
> `my_chat_member` (`membershipVerdict`, `receive.go:376`), and the status-line
> shape — and its bot-per-pairing premise is discarded. What replaces it: only
> the relay holds a bot token; the relay fully controls one topics-enabled
> supergroup; and a bidirectional stream (this document's proxy) carries
> messages, edits, and pins between the relay and every fleet's agent.
> The bridge keeps today's `.env`-driven boot modes byte for byte; another
> session is landing the MCP-only boot in `bridge/` and this document plans
> around it, not over it.
>
> **Amended 2026-09-23, on the owner's clarification, two things now explicit
> rather than implied.** (a) THE BINDING IS MANY-TO-ONE: one agent may own
> ANY NUMBER of topics, each topic stays an independent session inside the
> bridge exactly as today, the agent's single proxy stream carries all its
> bound topics, and per-topic `/model` may differ within the agent's
> provider (section 3). (b) THE PICK IS TELEGRAM'S SELECT MENUS, POSTED AT
> CREATION: when the user creates a topic the relay immediately posts the
> fleet menu there, keyed off the `forum_topic_created` service message (the
> first owner message is only the fallback for topics predating the relay's
> presence in the group); the exact two menus, the typed-before-the-second-
> tap rule, and the owner-only `/rebind`//`/close` verbs are spelled in
> section 4.

---

## 0. The target, restated

- ONE topics-enabled supergroup; the relay bot is a member with admin (pin +
  topic rights). The relay's `getUpdates` is the ONLY real consumer of the
  ONLY real token.
- Every `<fleet, model>` agent keeps a bridge that believes it is talking to
  Telegram. It is talking to a per-agent proxy endpoint the relay serves over a
  local transport, with a per-agent VIRTUAL token the relay issued. The real
  token never leaves the relay.
- The relay multiplexes: topics are bound to agents, inbound updates are
  demultiplexed per topic, outbound calls are scoped to the caller's own
  topics, and every outbound byte from every fleet crosses one rate-limit
  scheduler the relay owns.
- Everything keeps working without `/use-group`: MCP-only bridges (commit in
  flight) and legacy one-bot-per-group bridges (`TELEGRAM_API_ROOT` at its
  default) are untouched. The mode is per bridge, chosen by what its `.env`
  says.
- Testing stays on the Bot API fakes both repos already run. No real accounts.

---

## 1. Components and data flow

```
Telegram ⇄  relay (one real getUpdates loop, one real token — receive.go:106 poll)
              ├─ its own driver verbs, as today (/status, /auth, … in the relay's DM)
              ├─ the pick arbitration for unbound topics (section 4)
              └─ per-agent proxy endpoints (Bot-API-compatible HTTP over a local transport)
                   ⇄ each agent's bridge (unchanged client — bridge/telegram.js TelegramClient)
```

The proxy is not a new idea in this system — it is the e2e fake promoted to
production. `internal/e2e/steps_zcode.go:1431` `fakeTelegram` and the JS fake
in `test/e2e.mjs` are already Bot-API-shaped HTTP servers over a local
transport that the whole real bridge runs against (`TELEGRAM_API_ROOT`, the
seam named at `bridge/telegram.js:1-14`). The relay serves exactly such a
server per agent; the difference is that it multiplexes to the real API
upstream, holds the token, and enforces scoping. The bridge's transport code
changes only where `fetch` must learn to dial a unix socket (section 2).

**The method surface.** Grepping every `tg.` call across `bridge/*.js` at
`1b980d1` yields exactly this list, and this list IS the proxy's method
surface — anything not on it can answer `{"ok":false,"error_code":404}` the
way the real API does for an unknown method:

| method | where the bridge calls it | what the relay does |
|---|---|---|
| `getUpdates` | poll loop, `bridge/index.js:3075` | per-agent view: only updates in topics bound to this agent, with a per-agent offset (section 3) |
| `sendMessage` | ~40 sites in `index.js`; `progress.js:150` | scope-check `(chat_id, message_thread_id)`; forward through the scheduler (section 6) |
| `editMessageText` | streamer `bridge/streamer.js:105`, status `index.js:1569` region, `progress.js:170,198`, prompts, callbacks | scope-check; coalesce per message, latest text wins (section 6) |
| `deleteMessage` | status replacement, `index.js:1583` region (`telegram.js:149-154` — the 48h edit-window dance) | scope-check by chat + message id the relay minted |
| `pinChatMessage` | `tryPinTopicStatus` → `index.js:1532` region | scope-check: the topic's own status message only; the relay holds the group admin pin right |
| `createForumTopic` | `session_create`, `index.js:2918` | allowed; auto-binds the new topic to the creating agent (section 4) |
| `closeForumTopic` | `index.js:2866` (MCP session close) | allowed for the agent's own topics |
| `getChat` | `pickDefaultForumChat`, `index.js:2282` | answered for the shared group from relay state; refused elsewhere |
| `getChatMember` | admin probe beside `getChat` | answered with the agent's synthetic identity as administrator |
| `getMe` | `ensureBotUserId`, `index.js:2157` region | answered with a synthetic per-agent identity (section 3) |
| `setMyCommands` | boot, `index.js:3048-3049` | answered `ok` without forwarding; the real bot's list is set once by the relay at `/use-group` |
| `answerCallbackQuery` | permission prompts, `index.js:2754-2806` | routed by the topic of the message the query belongs to; forwarded |
| `sendDocument` | `/file` upload, `index.js:1918` | scope-check; multipart forwarded (files stay on the local transport) |
| `getFile` + `downloadFile` | inbound `/file`, `index.js:1956-1957` | served by the relay from the bytes Telegram gave it; same `/file/bot<token>/<path>` route shape |
| `leaveChat` | owner-gate rejection, `index.js:2235-2237` | refused in the shared group — membership is the relay's decision, not an agent's |

Notably absent from the real call sites: `unpinChatMessage`,
`deleteForumTopic`, `sendChatAction` — no bridge code calls them today, so the
proxy does not implement them. `getUpdates`, `sendDocument`, `downloadFile`
are the three methods that do NOT go through `_call`
(`telegram.js:23-43`): the last two are raw `fetch` calls
(`telegram.js:126-141`, `:172-176`), which matters for the transport change
below.

---

## 2. Transport: how each agent reaches its proxy endpoint

The endpoint is a unix-domain socket carrying plain HTTP; the bridge speaks
the same `/bot<token>/<method>` URLs it speaks today, with the VIRTUAL token
in the path — so the client's URL-building, caching, and error paths are
untouched, and the relay keys the connection to its agent by the token alone.

**Bare fleets.** The relay (the manager account — `CAGE_SECRETS` is its
0600 home, `internal/config/config.go:119-123`, `docs/relay.md:21-24,53`)
listens at one socket per agent under the manager's state directory, the
socket owned by the manager and group-readable by the agent account — mode
0660 with the agent account in the group, or the agent-named directory trick
`hostlayout` already plays. The shape to copy is the MCP socket's:
`claude.JuniorMCPSocketIn` (`internal/claude/claude.go:33-44`) places
`<state>/<model>-tg/mcp.sock` and the comment says the rule out loud — "the
socket file's permissions are the authentication". The new socket inverts the
ownership (manager listens, agent connects) but keeps the principle: no wire
to encrypt, the account split is the auth, and a second listener under a
second directory is one function. The bridge side of this shape is already
field-proven: `bridge/mcp.js:474-489` chmods its own socket 0600 and REFUSES
TO SERVE if the chmod fails, and `internal/launcher/bare.go:304-341`
records the cost of the one variable that decides reachability being wrong.

**Pod fleets.** The pod already gets a persistent bind mount
(`podlayout.StateMount` = `/state`, `internal/podlayout/podlayout.go:16-19`)
and starts each junior bridge with `MCP_UNIX_SOCKET` inside it
(`internal/boot/boot.go:705`). A manager-owned socket cannot live in the
agent's 0700 state mount — the exact lesson `podlayout.go:46-49` already
records for the one file that couldn't ("a separate bind mount solves it
exactly") — so the relay's socket directory is its own small bind mount into
the container, and the pod's bridge env (`internal/setup/provision.go:911`
is where `MCP_UNIX_SOCKET` is set for pods today) gains
`TELEGRAM_API_ROOT=unix:<mounted path>`. The commit's gate includes one
uid-mapping check: the agent account inside the container must be able to
`connect(2)` on the mounted socket, which is a property of the mount's
uid/gid options, not of the socket mode alone.

**Hub/spoke remote fleets.** The spoke already holds no chat credentials and
dials the hub over SSH (`internal/spoke/spoke.go:9-13` — "IT HOLDS NO CHAT
CREDENTIALS AT ALL"; reconnection is the normal case, `:39-41`). The hub side
is the forced command `cage attach <agent>` pinned in `authorized_keys`, the
agent name coming from the relay account's own config, under `restrict`
(`internal/hub/hub.go:15-31`, `internal/hub/attach.go:20-60` — "It is the
FORCED COMMAND behind every manager's SSH key"). The proxy rides that same
authenticated pipe: the spoke-side manager listens on the per-agent unix
socket, accepts the bridge's HTTP bytes, and carries them over the existing
`wire.Conn` (`internal/wire/wire.go` — newline-delimited JSON, "EVERY LIMIT
IS ENFORCED BY THE RECEIVER") as a new streaming frame type modeled on
`wire/file.go`'s chunking — request in, response out, one frame stream per
in-flight call, sized like a file chunk because a 20 MB download is the same
base64 problem file.go already solved. The forced command stays byte-identical;
`restrict` continues to forbid raw forwarding, which is why the tunnel is an
application frame and not `ssh -L`.

**The bridge change (small, one file).** Node's global `fetch` cannot dial a
unix socket; `node`'s `http.request` can, via `socketPath`. So
`TELEGRAM_API_ROOT` gains a `unix:` form:

- `TELEGRAM_API_ROOT=unix:/path/to/sock` — every request goes to the socket,
  path unchanged (`/bot<token>/<method>`), `Host:` header sent (some servers
  require one; the relay ignores it).
- The default `https://api.telegram.org` (`telegram.js:10`) is byte-for-byte
  today's behavior.

Three call sites swap `fetch` for a tiny shared helper over
`http.request({ socketPath, path, method, headers })`: `_call`
(`telegram.js:23-43`), `sendDocument` (`:126-141`, multipart body passed
through as bytes), and `downloadFile` (`:172-176`, whose URL is built from
`API_ROOT` + `/file/bot<token>/` + `file_path` — under `unix:` it becomes a
path on the same socket). The 429 parsing (`:32-38`) and the bounded retry
(`:74-81`) are transport-independent and do not change. No other file in the
bridge changes for transport.

---

## 3. Demultiplexing and scoping in the relay

**The binding table.** Relay state gains `shared-group.json` beside
`relay.json` in the `CAGE_SECRETS` directory — a separate file for the same
reason the old doc gave: `docs/relay.md` defines a manager's *role* by which
sections `relay.json` fills in, and a topic table must not perturb that. It
holds the chosen group (chat id, title — discovered exactly as the old
section 4 says, via `my_chat_member`/`membershipVerdict`, `receive.go:344-413`)
and the bindings:

```json
{ "group": { "chat_id": -100…, "title": "…" },
  "bindings": { "<message_thread_id>": { "fleet": "builder-1", "model": "zcode" } } }
```

A binding names an AGENT (the provisioned `<fleet, model>` account), not a
model string — that is what makes `/model`-within-a-provider invisible to the
relay (section 4).

**THE BINDING IS MANY-TO-ONE: one agent may own ANY NUMBER of topics.**
Many topics may map onto the same agent (two bound to `builder-1`/`zcode`
above); no topic ever maps onto two. The consequences, stated plainly
because they are the shape and not an accident of it:

- **Each topic stays an independent session inside the bridge, exactly as
  today.** The bridge's store is already keyed per topic — "topic (Telegram
  message_thread_id) -> zcode session" (`bridge/store.js:1-2`;
  `getTopic`/`setTopic` at `store.js:140-146`, per-topic queues at
  `:194-201`), and `getOrCreateSession` (`bridge/index.js:1387`) mints one
  session per key. A second topic on the same agent is a second session, a
  second queue, a second pinned status line — byte-for-byte today's
  multi-topic behavior; the relay adds nothing to it and must not collapse
  it.
- **One stream per agent, carrying ALL its topics.** The agent's proxy
  `getUpdates` interleaves updates from every topic bound to it, in arrival
  order — the demuxer is many-to-one fan-in. The offset-as-ack (below) is
  per AGENT, never per topic: one offset advances past an update of any of
  the agent's topics, because that is the Bot API's own semantics the bridge
  already speaks.
- **Per-topic `/model` within the agent's provider.** The binding's `model`
  field names the provisioned account — WHICH provider serves the topic. The
  runtime model — WHAT the session runs — is the bridge's per-topic store
  entry (`model` + `backend`, persisted by `getOrCreateSession`), and two
  topics on one agent may run different models of that provider. The relay
  never sees the choice and has no opinion: it routes by topic, and the
  topic is bound to the agent, not to a model string.

In the demux, owner-typed relay-scoped commands (`/rebind`, `/close` —
section 4) are answered by the relay itself and never fanned out, bound or
unbound.

**Inbound.** `receive.go`'s `update`/`message` structs grow a decoded
`message_thread_id` — parse-only, the same fix the old doc scoped, now needed
only in the relay. The single real poll loop (`receive.go:106`) hands each
update to a demuxer BEFORE `chat.Handlers`: in the shared group it fans out to
the bound agent's queue; anywhere else it goes to the driver as today. Service
messages follow their topic: `forum_topic_created` for a bound agent's topic
is delivered to that agent (it seeds its store entry from it — the old doc,
section 1); `my_chat_member` is never delivered to any agent — membership is
the relay's own affair.

**Per-agent `getUpdates` is its own ACK.** Each agent long-polls its endpoint
exactly as it polls Telegram today (`timeout: 30`, `bridge/index.js:3075`;
the relay holds the connection up to that timeout — the proxy can do what a
test fake does, `fakeTelegram` parks polls up to its own cap,
`steps_zcode.go:1527` region). The offset the agent passes is the relay's
delivery state: an agent's `getUpdates(offset=N)` acknowledges everything
below N, the relay persists the per-agent offset, and only then drops the
pending update. This is the Bot API's own offset semantics applied inside the
relay, which is why the bridge needs no new protocol and crash recovery is
"resume at the last acknowledged offset" (section 9).

**Outbound.** Every method call is checked against the binding before it
reaches the scheduler: `chat_id` must be the shared group, and the
topic-derived scope — `message_thread_id` where the call carries one, the
message id the relay minted where it doesn't — must resolve to the caller's
agent. A refusal is Bot-API-shaped, because the bridge already has error
handling shaped for the real API:

```json
{ "ok": false, "error_code": 403,
  "description": "Forbidden: topic not bound to this agent" }
```

Non-429 failures are not retried anywhere in the bridge (`telegram.js:62-64`
— "a 400 will fail identically forever"), so a scoping refusal is terminal at
the caller, which is exactly what a bug here deserves.

**Synthetic identity.** `getMe` answers per agent with a synthetic id and a
username derived from the binding (`<fleet>_<model>`, sanitized, ending in
`bot` as Telegram's own rule requires); `getChatMember` answers with the same
synthetic user as administrator. This is not cosmetic: `commandIsOurs`
(`bridge/commands.js:23`, landed in `1b980d1`) compares a command's `@suffix`
against `getMe`'s username and drops mismatches (`bridge/index.js:2155`), and
distinct synthetic usernames keep that check meaningful — `/stop@other_fleet_bot`
is dropped by the bridge itself, while bare `/stop` (no suffix) still passes
everywhere, because the relay routes by topic regardless of suffix.
`setMyCommands` is answered `ok` without forwarding: all agents would
otherwise write the same static `BOT_COMMANDS` list at one real bot, and the
relay sets that list once at `/use-group` time. `leaveChat` is refused
(section 1) — an agent that rejects a non-owner has no authority over group
membership.

**Callback queries.** A tap arrives as a `callback_query` whose `message`
carries the topic; routing keys on that topic's binding, so an agent only
ever receives taps on keyboards its own messages posted. `answerCallbackQuery`
is validated the same way (a query id is answered through the agent the
tap was routed to).

---

## 4. The pick conversation, and `/model` under the binding

**The pick is Telegram's select menus, posted by the relay in the new topic
the moment the user creates it.** A topic a HUMAN created belongs to nobody;
WHEN THE USER CREATES A TOPIC, the relay immediately posts the fleet menu
there from its own real identity, keyed off the `forum_topic_created`
service message — the relay receives it because it is the group's admin (an
admin sees service messages regardless of any privacy mode; that half is
the measured one in the old doc's section 1). The first owner message is
NOT the trigger. It remains ONLY the fallback for topics created before the
relay was in the group — a group already full of topics when `/use-group`
chose it, whose creation service messages the relay never received — and,
same shape, for a relay that happened to be down at creation time. The
conversation is two steps over inline keyboards — Telegram's select menus —
and both halves already exist: `onCallback` (`receive.go:301-342`,
owner-gated, `answerCallbackQuery`, `verb:agent:arg` routing with the note
that only the first two colons are structural, so the payload after them may
carry anything) and the claim-ask-match-expire discipline of `pendingZAuth`
(`internal/relay/zauth.go:200-230`).

The two menus, exactly:

1. **Fleet menu.** One button per fleet in the relay's fleet records
   (`internal/config/fleet_record.go` — the same list `/status` offers).
   Callback data `pick:f:<fleet>`.
2. **Model menu.** One button per model provisioned on the chosen fleet, from
   the manager's `models.json` (`internal/config/model_accounts.go`) — the
   same source `/auth` resolves against. Callback data
   `pick:m:<fleet>:<model>`. Only provisioned models are offered: a fleet
   with no codex account offers no codex button, so the pick can never bind a
   topic to an agent that does not exist.

On the second tap the relay writes the binding, edits its pick messages down
to a one-line record ("this topic is served by builder-1/zcode"), and the
CHOSEN AGENT'S FIRST STATUS PIN is the confirmation that the binding works:
from that moment the topic rides the agent's stream, the agent seeds its
store entry and its first `updateTopicStatus`/`tryPinTopicStatus` pass posts
and pins the fleet/model line in the topic (section 5). The e2e gate asserts
that arc — tap, binding written, `✅`-named holder, status pinned — the same
way the zauth steps already assert their `✅` names the right holder
(`steps_zcode.go:1408-1420`).

**Typed before the second tap.** Anything typed in the topic before the
binding exists — before the second tap, or with no menus answered at all —
makes the relay re-ask (one short pointer at the buttons per typed message,
from its own identity) and is delivered to NO agent: not fanned out, and not
buffered for replay after the pick, because a message typed before the menu
is answered may itself BE the pick's answer ("actually use codex"), and
replaying it as a prompt at the later-chosen agent would act on the user's
own menu reply. The menus stay the only path to a binding.

**Re-bind and close are owner-only verbs, and they are relay verbs.** Both
live in the driver's closed set (`internal/relay/driver.go:139-186`), both
get a `menuCommands` line (`receive.go:446-501` — a verb without a menu line
is a verb nobody finds), and the demux answers them itself in the shared
group, in bound and unbound topics alike; the owner gate is the relay's own
allowed-user check, the same one `onCallback` already applies.

- `/rebind` — re-runs the two menus in the topic it is typed in (no
  argument; the topic is the argument, the way `/model` is per-topic in the
  bridge). On the second tap the binding is rewritten and the OLD agent's
  session is closed, not abandoned: the relay synthesizes a
  `forum_topic_deleted` service message into the old agent's stream — the
  Bot-API-native way to say "this topic is no longer yours" — and the
  bridge, which grows a small handler for it, runs its own session-close
  path: the one MCP `session_close` drives (`sessionClose`,
  `bridge/index.js:2911` — mark the store entry `closed: true`, which
  `messageSend` then refuses; the handler skips `sessionClose`'s own
  best-effort `closeForumTopic`, because Telegram itself is the thing
  reporting the deletion, and the proxy's scope check would refuse the old
  agent anyway once the binding has moved). The same handler is what
  garbage-collects a topic the owner deleted through the Telegram UI, which
  today leaves a stale session behind. The relay then unpins the old status
  message through the real API — every pin in the group is the ONE relay
  bot's pin, so unpinning needs no permission the relay lacks — and the NEW
  agent's first status pin replaces it, the same first-pin confirmation a
  fresh pick gets.
- `/close` — ends a binding without replacing it: the relay closes the
  topic through the real API (`closeForumTopic` — it holds the admin
  right), delivers the same `forum_topic_deleted` close to the bound agent,
  and deletes the binding, after which the topic appears on no agent's
  stream. Telegram's own `forum_topic_deleted` service message triggers the
  same path, covering a topic deleted through the Telegram UI without the
  verb.

**Topics an agent mints itself need no pick.** `session_create` creates its
topic through the proxy (`createForumTopic`, `bridge/index.js:2918`); the
relay auto-binds the returned `message_thread_id` to the creating agent at
creation time. The pick exists for humans because the relay cannot tell which
agent a human meant; it can always tell which agent asked for a topic.

**`/model` is structurally bounded.** The agent behind a topic holds one
provider — the binding names the agent, the agent's account holds one
provider's credential — so "switch within the topic's provider" is just
"switch within this process's backend", and the binding does not move.
What the bridge must still refuse, in proxied mode
(`TELEGRAM_API_ROOT` is a `unix:` root — the bridge can test that locally, no
relay conversation required):

- `/backend <other>` (`handleBackendCommand`, `bridge/index.js:1941`): refused
  with the old doc's sentence, adjusted — "this topic's provider is fixed by
  its fleet/model binding; create a topic for <other provider> instead." A
  backend switch would move the conversation to a provider the relay's
  binding does not name, and the relay would keep filing the messages under
  the old agent — a divergence no check downstream catches.
- the cross-backend resolution in `handleModelCommand`
  (`bridge/index.js:1737`) — where `bridge/modelref.js` finds a ref on
  another backend and performs the fresh-session switch: refused the same
  way. `modelref.js` already returns the backend the ref was found in; the
  gate is one comparison after resolution.

Within-backend switches stay legal and stay invisible to the relay. MCP
`model_set` keeps `validateMcpModel`'s per-backend allowlist (the old doc,
section 2) — the same bound expressed at the MCP layer, unchanged.

---

## 5. The status line

The bridge renders and the relay pins — that division is the point of the
section. The render side is landed: `topicStatusText`
(`bridge/index.js:1609`) feeds `cfg.fleet` (from `TELEGRAM_FLEET`),
the topic's stored model, state, queue depth, and provider-routed usage into
`statusLineText` (`bridge/usage.js`, pure and unit-tested) — `1b980d1`'s
"the status line names fleet and model". Pinning goes through the proxy like
any other call: `tryPinTopicStatus` (`index.js:1646` region) →
`pinChatMessage` (`telegram.js:145-147`, "callers treat a failure as 'stay
unpinned'"), status updates edit in place (`index.js:1569` region), the 48h
edit-window replacement deletes and re-pins (`index.js:1583` region).

The relay owns the pin PERMISSION in both senses: it holds the group admin
right (`can_pin_messages`) — one promotion for the whole deployment, which is
the owner's tedium complaint answered — and it scope-checks the call: an
agent may pin only its own topic's status message, never another topic's,
never the group's header pin. Status edits ride the scheduler like every
other edit but on the reserved lane (section 6), because a status line that
lands minutes late misstates queue state, and the whole point of the line is
that it doesn't.

---

## 6. Rate limits — the hazard one token creates

Today every fleet streams edits against its own bot's budget.
One token makes that budget SHARED: every fleet's `ReplyStreamer` edits, every
prompt mirror, every placeholder, every status line compete for what Telegram
gives one bot.

**The numbers assumed.** The Bot API publishes no figures; enforcement
arrives as `429` + `retry_after`, which the bridge already parses
(`telegram.js:32-38`). We design to the conservative, commonly reported
figures — **~30 messages/second per bot globally, ~20 messages/minute per
group, counting `editMessageText` toward both** — and we take the second
number from this repo's own record: `bridge/streamer.js:6` names the
"group-wide 20 messages/min bot cap" (agreed contract, 2026-09-01), while
also recording that the streamer's own pacing rule ("don't edit the same
message more often than once per `minEditIntervalMs`", default 5s,
`streamer.js:30`) deliberately ignores it — a choice that was free when every
bridge had a private bot and is no longer free. The design target is that the
relay provably never approaches either number, so that the first `429` a
fleet sees is Telegram misbehaving, not a neighbor.

**The relay's outbound scheduler.** All forwarded writes — sends, edits,
pins, deletes, documents — pass through one scheduler before the real API:

1. **Per-message edit coalescing.** Keyed on `(chat_id, message_id)`: latest
   text wins; an edit arriving within ~1.5s of the last one for the same
   message replaces the pending edit in place; one edit goes out per message
   per interval. Nothing is dropped that matters — coalescing a superseded
   intermediate preview loses nothing the next edit doesn't carry. A
   terminal-delivery edit (the streamer's authoritative final render,
   `streamer.js:8-11` — "the final delivery on turn.terminal always runs
   regardless of the throttle") is flagged by the bridge and bypasses
   coalescing, though not the bucket.
2. **Two token buckets.** A global bucket refilling at ~25 msg/s (burst 30)
   and a per-group bucket refilling at ~16 msg/min (burst 20) — headroom under
   both assumed limits, so one noisy fleet cannot spend another fleet's
   budget.
3. **Fairness across topics.** Per-topic FIFO queues drained round-robin; no
   topic may starve another no matter how fast its model streams. Two lanes:
   interactive sends (prompt mirrors, replies, notices — latency-sensitive)
   and streaming/status edits (coalesced anyway). The status line gets a
   reserved slice of the edit lane, sized so one pinned line per active topic
   always lands within a couple of seconds of its render.
4. **429 as the pressure valve, in the API's own shape.** The relay honors
   `retry_after` globally (pausing the buckets). A call it cannot schedule
   within ~10s is answered to the bridge as a Bot-API `429` with
   `retry_after: 1`, which flows into the bridge's existing bounded retry
   (`RATE_LIMIT_ATTEMPTS = 3`, `telegram.js:74-81`) — so the bridge's
   worst-case behavior under an overloaded relay is EXACTLY its worst-case
   behavior under Telegram itself. No bridge code learns that a scheduler
   exists.

**What the bridge stops doing.** Not its cadence — its PRETENSE. The streamer
may keep `minEditIntervalMs = 5000` and its 60s heartbeat
(`streamer.js:30,57`); at 5s per message it is already stricter than the
relay's ~1.5s coalescing window, so the relay's coalescer mostly idles and
the two layers cannot fight. What the bridge must stop claiming is the
streamer header's own sentence — that the group-wide cap "is explicitly not a
design constraint here" (`streamer.js:6-8`). Under one token it is
everyone's constraint, and the layer that enforces it is the relay. The
inversion this buys, once the scheduler is confirmed in production: the
bridge's `STREAM_EDIT_INTERVAL_MS` becomes a pure rendering preference
(richer previews, faster elapsed counters) that the relay bounds for the
fleet as a whole — tightening it locally can no longer break a neighbor.

---

## 7. Auth and provisioning

**`/auth <model>` loses its token ask.** Today `beginModelAuth` /
`resolveAuthTarget` (`internal/relay/zauth.go`, verb `VerbAuth` in the closed
set at `internal/relay/driver.go:139-186`) walks the owner through
`zBotHowTo` (`zauth.go:93`) and `zTokenPrompt` (`zauth.go:74`) and lands the
reply in `PutZAuth` (`zauth.go:424-431` → `ops.ZAuth` →
`internal/agent/zauth.go:63` → `putZcodeEnv`, `internal/agent/zauth.go:311-348`
→ the model's `~/.config/agent-tg/<model>/.env`,
`internal/hostlayout/hostlayout.go:188-189`). In relay-owned mode the
conversation asks nothing: the relay mints a VIRTUAL token (opaque, namespaced
per agent), and `PutZAuth` writes the same three keys it writes today —
`TELEGRAM_BOT_TOKEN` = the virtual token, `TELEGRAM_CHAT_ID` = the shared
group, `TELEGRAM_ALLOWED_USER_ID` = the typer — plus one new key,
`TELEGRAM_API_ROOT=unix:<proxy socket>`. `ops.ZAuth` grows `APIRoot` with the
same contract its `Model` field documents (`internal/ops/ops.go:207` region —
"EMPTY IS A COMPATIBILITY VALUE"): empty means untouched, older relays and
legacy paths write nothing, and `putZcodeEnv`'s existing merge ("replaced at
the position the file had it in", `zauth.go:326-342`) carries the new key
with no new mechanism. The relay records the virtual token → agent map in
`shared-group.json`; revocation is deleting an entry.

**`/use-group` stays** — same verb, same `menuCommands` line
(`receive.go:446-465`), same discovery (`my_chat_member` is already asked for
by name at `receive.go:116` and judged at `:376`), writing `shared-group.json`
(section 3). What drops with the managed-bot premise is the premise check the
old doc bolted onto it (`getMe.can_manage_bots`) — there are no child bots to
manage. What it gains: the one-time real-side setup the relay now performs
itself — `setMyCommands` for the real bot, and the instruction that the relay
bot be promoted to admin once ("an admin sees every message regardless of
privacy mode" — the measured half of the old section 1's contradiction, now
needed once per deployment instead of once per pairing).

**Existing deployments keep working untouched.** A bridge whose `.env` says
`TELEGRAM_API_ROOT=https://api.telegram.org` (or says nothing — the default,
`telegram.js:10`) never contacts a proxy, never holds a virtual token, and
runs byte-for-byte today's behavior, per-pairing bot and all. The mode is per
bridge, decided by its own `.env`: mixed fleets (one legacy pairing beside
three relay-served agents) are legal and need no flag. A fleet migrates by
running `/use-group` and re-running `/auth` for each model it wants served
from the shared group — and can migrate back by re-running `/auth` with a
real token, because the bridge never learned anything except a URL.

---

## 8. MCP-only mode

The requirement is unchanged: zcode and codex stay consumable as MCPs by
Claude with NO Telegram at all — no bot, no group, no polling. The bridge
commit is in flight on `usage-onto-pin` (working tree carries
`bridge/config.js` parsing the three boot states — token present / MCP-only /
refused with both ways out — plus `test/config.test.js` and
`test/mcp-only.test.js`; `bridge/index.js` and `bridge/mcp.js` adjusted).
This design adds nothing to it and takes nothing from it: MCP-only means no
`TELEGRAM_API_ROOT` transport of either kind, and the relay's provisioning
never writes a half-state — an agent's `.env` gets either the virtual token +
`unix:` root (Telegram-served) or nothing Telegram-shaped (MCP-only). The
junior-agent MCP wiring that makes the mode useful
(`models.Registry`'s `Junior` + `JuniorAgentTools`,
`internal/models/models.go`) is transport-independent, as the old doc
already established.

---

## 9. Failure modes

- **Relay down.** The bridge sees `getUpdates` fail (ECONNREFUSED from the
  socket) and every outbound call fail — which is byte-for-byte what it sees
  when Telegram is down today: the poll loop logs and retries, sends surface
  their errors, notices degrade, nothing new to write. That equivalence is a
  design property, not luck: the bridge has exactly one upstream and the
  proxy stands in front of it without changing its shape. Queued owner
  messages wait in Telegram until the relay returns (the real API holds
  undelivered updates on its own offset, which is also what bounds the
  relay's catch-up).
- **Agent down (bridge process dead, fleet down).** The relay BUFFERS the
  agent's updates (bounded: a few hundred updates or 24h, whichever first) —
  dropping an owner's prompt silently is the one failure this design must not
  have. When the backlog ages past a few minutes, the relay itself posts ONE
  notice in the topic from its own identity ("builder-1/zcode has not
  collected messages for 10m — I'll keep them; /status builder-1 to check the
  fleet") and pins a matching status edit, rather than repeating itself per
  message.
- **Binding to a dead agent.** Deprovisioning is an operator act and the
  binding outlives the agent on purpose (a restarted fleet keeps its topics).
  A bound-but-unresolvable agent (no such model on that fleet per
  `models.json`) makes the relay say so once in the topic, with the
  `/auth <model>` hint, and keep buffering briefly rather than forever.
- **Duplicate delivery on relay restart.** Per-agent offsets persist with
  `shared-group.json` (atomic write, the `fsx.WriteFileAtomic` habit), and an
  update leaves the pending set only when the agent's `getUpdates` offset
  passes it (section 3). A restart therefore replays at most what was
  unacknowledged — at-least-once to the agent, which is idempotent there the
  same way it is from Telegram today (the bridge dedupes by update id in its
  own offset handling), and never a re-send of something the owner already
  saw answered. The real offset is persisted on the same schedule, so the
  relay never re-fetches a region it has fully fanned out.
- **Token rotation.** The real token rotates in ONE place — the relay's
  `relay.json` (and BotFather, once, by a human). Every agent keeps its
  virtual token, which is meaningless outside the relay and rotates never.
  Compare the old world, where rotation meant a BotFather conversation and a
  `PutZAuth` per pairing.

---

## 10. Testing without real accounts

Both fakes already speak the proxy's dialect, because the proxy is their
production cousin:

- **Relay ⇄ fake.** The relay's real Telegram transport points at
  `fakeTelegram` (`internal/e2e/steps_zcode.go:1431`, which already answers
  `getChat`/`getChatMember`/`createForumTopic`/`getUpdates` with the shapes
  the bridge needs, `:1476-1547`, and records every send and edit,
  `:1538-1545`). Test bridges — trivial HTTP clients holding virtual tokens —
  hit the relay's proxy over its unix socket, and the assertions are the
  scoping property itself: an update pushed into topic T reaches exactly the
  agent T is bound to, and a send from agent A into topic B is refused with
  the Bot-API-shaped 403. The fake's per-call record (`texts()`) is the
  oracle for what the scheduler released and coalesced.
- **Bridge ⇄ relay ⇄ fake.** In the e2e steps, the bridge's
  `TELEGRAM_API_ROOT` points at the relay proxy instead of the fake
  (`"TELEGRAM_API_ROOT="+fake.root` at `steps_zcode.go:158,366,554` becomes
  the proxy root in the shared-group steps) — and every existing assertion is
  expected to pass UNCHANGED, because the bridge cannot tell a proxy from a
  fake from Telegram, which is the whole design. The fake's
  `pushUserMessage` (`:1549-1567`) grows a topic parameter so a step can say
  which topic a message landed in.
- **The old "two bots, one fake" test becomes a relay scoping test.** The old
  doc's hardest fake feature — two bridge processes, one fake, exactly one
  answers — collapses into the relay: one fake, one relay, TWO proxy clients,
  and the property "exactly one agent's `getUpdates` ever yields topic T's
  updates" is a relay assertion with no second bridge process needed.
  (The supervisor-level two-bridge shape — two real bridge processes, one
  account, one must not cross the other — remains what
  `internal/e2e/steps_twobridge.go` proves, orthogonal to routing.)
- **Where tests live.** agent-cage: pure units beside their subjects
  (`internal/chat/telegram/receive_test.go` is the pattern — the demuxer's
  topic predicate is extractable the way `membershipVerdict` was; the
  scheduler gets fake-clock unit tests in the same style), and the flows as
  e2e steps beside the zauth steps in `internal/e2e/`
  (`steps_zcode.go`, new `steps_relaygroup.go`), orchestrated by
  `internal/testenv/e2e_test.go`. zcode-tg: the `unix:` transport as a
  `node --test` case in `test/telegram.test.js` against a temp-dir socket,
  the proxied-mode `/model`//`/backend` refusals as pure unit tests beside
  `commands.js`' existing ones, and the existing `test/e2e-*.mjs` suite
  untouched — its fake already IS a per-bridge proxy.

---

## 11. Work breakdown

Ordered, independently shippable commits; bridges before relay writers — the
old doc's rule ("no writer ships pointing at a reader that cannot exist yet")
with the roles it had: nothing relay-side ships before the bridge can speak
to it.

**Which of the old doc's commits survive.** 1 (the `@suffix` check — LANDED
in `1b980d1`, `bridge/commands.js:10-23` + the drop at `index.js:2155`) and
2 (the fleet/model status line — LANDED, same commit) carry over as-is; 6
(MCP-only boot) is the commit IN FLIGHT in `bridge/` — this document plans
around it and does not replan it. DROPPED: 3–5 (the managed-topic gate, the
bindings-file reader, the mtime re-read) — the bridge never learns of
bindings at all in this design; scoping lives entirely in the relay, and a
bridge-side copy of the binding table would be a second authority where one
is wanted. Old commit 4's `/model` bounding survives in the reduced
proxied-mode refusal (section 4).

**zcode-tg** (`usage-onto-pin`):

1. **`unix:` transport.** The `TELEGRAM_API_ROOT=unix:` form and the
   `http.request`/`socketPath` helper behind `_call`, `sendDocument`,
   `downloadFile` (section 2). Default root untouched. Gated on: unit test
   over a temp socket + one e2e run with the bridge pointed at a
   unix-socket front for the existing fake; `https` path byte-identical.
2. **Proxied-mode refusals.** `/backend` and cross-backend `/model` refused
   when the configured root is `unix:` (section 4). Inactive without it.
   Gated on: nothing (pure unit tests); *meaningful* only with agent-cage 4.
3. **(in flight, another session)** MCP-only boot — not replanned here; the
   boot-mode parser it lands is also what makes "no Telegram-shaped keys in
   an MCP-only `.env`" (section 8) checkable in `config.js`'s own tests.

**agent-cage** (fresh branch off `main`/`0d99fe1`):

4. **`shared-group.json` + `/use-group`.** The state file, the verb, its
   `menuCommands` line, discovery via the existing `my_chat_member` path,
   the real-side one-time setup (`setMyCommands`, admin instruction) —
   minus the managed-bot premise check. Gated on: nothing relay-side.
5. **Proxy core.** Virtual tokens, per-agent unix listeners (bare placement;
   pod placement flagged for its uid-mapping gate), the demuxer with the
   parse-only `message_thread_id` decode and many-to-one fan-in — one stream
   per agent carrying all its bound topics — per-agent `getUpdates` with
   offset-as-ack, synthetic `getMe`, `setMyCommands` answered,
   Bot-API-shaped scoping refusals. Scheduler NOT yet in front — forwarding
   is direct, so the proxy is shippable and honest before it is polite.
   Gated on: zcode-tg 1 (reader) and the relay ⇄ fake scoping tests (section
   10).
6. **The outbound scheduler.** Coalescing, the two buckets, the fairness
   lanes, 429-as-pressure-valve (section 6). Gated on: 5; fake-clock unit
   tests assert coalescing and fairness, the e2e asserts a burst from two
   topics emerges interleaved and capped.
7. **The pick conversation.** The two Telegram select menus (the relay's
   fleet records, then models.json's provisioned models for the chosen
   fleet) posted immediately on `forum_topic_created`, the first owner
   message kept only as the fallback for topics predating the relay's
   presence in the group, the re-ask on anything typed before the second
   tap (delivered to no agent, buffered nowhere), `pendingZAuth`
   discipline, binding written, the chosen agent's first status pin as
   confirmation, auto-bind for agent-minted topics, and the owner-only
   `/rebind`//`/close` verbs — re-bind closes the old agent's session
   through the `session_close` path and the topic's status pin is replaced
   by the new agent's (section 4). Gated on: 5.
8. **`/auth` rewrite + `PutZAuth` delivery.** `ops.ZAuth.APIRoot` (empty =
   compat), `putZcodeEnv` writes `TELEGRAM_API_ROOT`, `beginModelAuth`'s
   relay-owned path skips the token ask, virtual token minted and recorded.
   Gated on: 5. The e2e zauth arc asserts the written `.env` names the
   virtual token and the `unix:` root — the same file-content assertions the
   current steps already make.
9. **Hub/spoke tunnel.** The wire frame type carrying proxy bytes over the
   forced-command pipe; spoke-side listener; receiver-enforced chunk limits
   (section 2). Gated on: 5; e2e with one hub and two attached managers.
10. **Docs.** `docs/relay.md` (the role table gains "what `/use-group`
    writes"), the fleet READMEs' bot setup steps (one bot, admin once —
    replacing the per-pairing dance), and `docs/codex-agent.md`'s "two bots
    and two groups" sentence. Gated on: 8.

1–2 and 4–5 are the shippable spine that changes nothing about today's
deployments; 6–9 are the feature proper, and it is ON only when an operator
runs `/use-group` and re-auths a model — at which point every gate above is
already behind a test.
