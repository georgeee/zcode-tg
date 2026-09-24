# One Telegram group for every fleet: the shared-group design

> **SUPERSEDED by `docs/relay-owned-group-design.md`.**

How one Telegram supergroup with topics replaces today's one-group-per-`<fleet, model>`
arrangement, without taking anything away from a deployment that never asks for it.

Written against `zcode-tg` @ `usage-onto-pin` (f3b917f) and `agent-cage` @
`feat/short-names`. Line references are to those trees and will drift; the
function names are the durable half.

---

## 0. The target, restated

Today every `<fleet, model>` pairing gets its own Telegram group and its own bot
(`docs/codex-agent.md` says it out loud: "A fleet running both zcode and codex
needs two bots and two groups: one getUpdates consumer per token means the two
bridges cannot share one."). The target state:

- ONE topics-enabled supergroup serves every fleet.
- A **relay bot** (the `agent-cage` chat relay's own transport) manages the
  setup. `/use-group` picks the shared group among the groups the relay bot was
  invited to.
- The relay provisions a **managed bot account** per `<fleet>-<model>` pairing
  and hands the token to that fleet's agent through the path that already
  exists: `ops.ZAuth` → `internal/agent/zauth.go` `PutZAuth` → the model's
  `~/.config/agent-tg/<model>/.env`.
- A new topic is bound interactively: the owner creates a topic, sends
  something, and is asked (fleet, then model). `/model` afterwards switches
  only within the topic's provider — never provider, never fleet.
- The pinned status line names fleet, model, idle/running, queue depth, and
  usage over the ~5h and ~week windows.
- Everything must keep working **without** `/use-group`: zcode and codex stay
  consumable as MCPs by Claude with no Telegram witnessing at all.
- Testing stays on the Bot API fakes both repos already run. No real accounts.

Everything below cites where today's code makes each of those easy, hard, or
surprising.

---

## 1. Topology: N bots in one group

### What today's code does

**The bridge's only gate is the owner id.** `handleMessage`
(`bridge/index.js:2279`, gate at `:2281-2285`) refuses anyone who fails
`isOwner`, and the comment at `:2153-2160` says the design out loud: "THE OWNER
GATE IS THE ONLY GATE. The bridge serves whatever chat an owner speaks in."
There is no chat filter (the configured `TELEGRAM_CHAT_ID` is informational
since that refactor), no topic filter, no `@botname` filter. Two bridges
sharing a group would each answer every owner message: each bridge would see
the message, pass the owner gate, find no store entry for the topic, seed one,
and serve it. Two answers, two status lines, one topic.

**The relay's transport is topic-blind.** `internal/chat/telegram/receive.go`'s
`update`/`message` structs (`:17-47`) decode no `message_thread_id` at all —
there is not a reference to the field anywhere under `internal/chat`. The relay
serves one conversation per chat, which is correct for its current
one-bot-per-fleet world and means the relay cannot, today, tell messages in one
topic of the shared group from messages in another.

**The two setup instructions contradict each other.** `zcode-tg`'s README
(`README.md:68-74`) says: disable privacy mode, add the bot "as a normal member
(no admin needed)". The relay's `zBotHowTo` (`internal/relay/zauth.go:93-101`)
says: promote the bot to ADMIN, "an admin sees every message regardless of
privacy mode", and records the field measurement — "the toggle alone, with the
bot a plain member, delivered nothing — zero updates ever arrived". These
cannot both describe working deployments. The relay's is the one with a
measurement attached, and it is also the one that needs no second BotFather
step per bot, which the shared group turns from a convenience into a
requirement.

### The choice

**Bots as admins.** Privacy mode ON is not viable for the managed bots even
where it works: a privacy-mode bot sees only @-addressed commands, replies to
its own messages, and service messages — an owner's ordinary prompt in a topic
is none of those, so a managed bot could not serve its topic conversationally.
Privacy mode OFF as a plain member is the configuration `zBotHowTo` measured
*delivering nothing*. Admin-promotion is the one configuration both documents
agree delivers every message, and it is what the relay's flow already instructs.

The consequence is stated plainly: **every bot sees every message, so routing
is the software's job, not Telegram's.** Exactly one bot may answer a topic,
and the filter that guarantees it has two halves:

1. **Topic ownership.** A managed bot answers an owner message in the declared
   shared group only if that topic is bound to it (section 2). Unbound topics
   in the shared group get one hint message — and it must come from *one* bot,
   which is the relay bot, because a fresh topic belongs to nobody (the relay
   sees the same messages the managed bots do; only it has the authority to
   say "unbound").
2. **@-addressing.** A command carrying `@somename` belongs to `somename` or
   nobody. The relay already implements this (`receive.go:289-295`: a command
   addressed to another bot is dropped). The bridge does not — `parseCommand`
   (`bridge/index.js:2120-2123`) matches `/(?:@[a-zA-Z0-9_]+)?/` and discards
   the suffix without comparing it. `/model@OtherBot` runs today's handler
   today. The fix is small and worth shipping for the single-bot world alone:
   compare the suffix against `ensureBotUserId`'s cached `getMe` username
   (`bridge/index.js:2202-2205`) and drop mismatches, as the relay does.

**Where the filter goes:** in `handleMessage`, immediately after the owner gate
passes (`bridge/index.js:2285`, before `noteKnownChat` and the `keyFor`
resolution at `:2293`). The gate needs the bot's own identity, the declared
shared chat id, and the binding lookup — all cheap, all available before any
session work. `handleCallbackQuery` (`bridge/index.js:2765`) needs the same
treatment for symmetry, exactly as the relay gates taps at `receive.go:308`.

The gate must be **opt-in**, not ambient. A topic is served as today unless
the deployment declares the chat shared (`TELEGRAM_SHARED_GROUP` naming the
chat id — see section 2's binding record). That is what makes the change
independently shippable: a single-bot deployment with no declared shared chat
takes none of these branches, byte for byte.

---

## 2. Topic ownership: binding a topic to `<fleet, model>`

### The interactive pick, and who asks

The relay bot asks. A fresh topic belongs to nobody — every managed bot in the
group sees the same `forum_topic_created` service message (`forum_topic_created`
is a service message; the bridge seeds its store entry from it at
`bridge/index.js:2295-2312`, and service messages reach admins regardless of
privacy mode) — but only the relay has the state to arbitrate. The managed
bots seed an *unbound* stub and stay silent; the relay, seeing the first owner
message in an unbound topic, posts the pick.

The pick is a two-step callback conversation, and the relay already has every
piece of it:

- **Inline keyboards + callback queries** are the right primitives: a tap on
  the *relay's own* keyboard arrives at the relay regardless of privacy mode,
  and `onCallback` (`receive.go:301-342`) already owner-gates taps, answers
  with `answerCallbackQuery`, and routes `verb:agent:arg` — with the explicit
  note (`:321-324`) that only the first two colons are structural, so callback
  data may carry a topic key with colons in it. `pick:<chatid>:t<thread>` fits.
- **The relay's transport is topic-blind** (`:17-47`), so the pick prompt and
  the binding both key on `(chat_id, message_thread_id)` taken from the
  callback query's `message` — which `onCallback` already decodes — not from
  the inbound text message. This is the one place section 1's topic-blindness
  must be fixed in `internal/chat`: the `message` struct grows a decoded
  `message_thread_id` (parse-only; the relay still serves one conversation per
  chat and uses the topic id only for the pick and the binding).
- **The conversation shape is `pendingZAuth`'s.** The relay's auth flow
  (`internal/relay/zauth.go:200-230`) is exactly this pattern: claim a slot,
  ask, match the reply, expire on silence. The pick reuses the discipline with
  callback data instead of secret replies.

Flow: owner creates topic, sends anything → relay posts
"which fleet?" (buttons: every fleet the relay knows) → owner taps →
"which model on <fleet>?" (buttons: `models.Registry` entries provisioned on
that fleet, from the manager's `models.json` — `internal/config/model_accounts.go`) →
owner taps → relay writes the binding, tells the owner which bot now serves
the topic, and the managed bot's next status message in the topic confirms it.

### Where the binding is recorded, and how the owning bot reads it

**The relay is the authority; the bridge holds a copy.** The binding is a
fact about the fleet's setup, the relay is the component that arbitrates it,
and the bridge is a consumer. Concretely:

- The relay writes the binding into its own state — a sibling of `relay.json`
  in the `CAGE_SECRETS` directory (`internal/config/config.go:119-123`;
  `docs/relay.md` documents that directory as the manager-owned, 0600 home of
  relay configuration). A separate `shared-group.json` keeps `relay.json`'s
  load-bearing property intact: `docs/relay.md` defines a manager's *role* by
  which sections `relay.json` fills in, and "which topic belongs to which
  agent" must not perturb that table.
- The bridge reads its copy at `getOrCreateSession` time
  (`bridge/index.js:1380`) from a bindings file next to its `.env`
  (`~/.config/agent-tg/<model>/bindings.json`), populated by the relay
  (section 5 covers the transport). A file, not a store mutation, because the
  bridge holds an exclusive lock on its store (`bridge/store.js:93-123` — a
  second writer is refused loudly) and because the binding must survive
  bridge restarts and store resets alike. The bridge re-reads on mtime;
  a stale copy degrades to "unbound", which is the safe direction.

**The bridge's read path is one function.** A topic key in the declared shared
chat is served iff `bindings[key]` names this bridge's pairing
(`<fleet>, <model>`) — or iff the key predates the shared-group declaration
with a session in the bridge's own store, which is what keeps a
was-single-bot deployment's existing topics working with zero migration.

### `/model`, bounded to the provider

Define **provider** once, against the two registries that already exist:

- In `agent-cage`, `models.Registry` (`internal/models/models.go:69-211`) is
  the closed set of model integrations: `claude`, `zcode`, `codex`, `mock`.
  Each entry carries the facts that make the pairing real — `Bridge`,
  `BridgeBin: "zcode-tg"`, `AccountSuffix` (`-zai`, `-cdx`, `-cld`, `-mck`).
  One provisioned account per `<fleet, model>` — `setup.DefaultAgentName` via
  the `models.json` table — is exactly "one managed bot per pairing".
- In `zcode-tg`, `BACKEND_FACTORIES` (`bridge/index.js:297`) and the
  `/model` span `modelBackends` (`:342-347`, from `MODEL_BACKENDS`) are the
  per-process equivalent: each backend *is* a provider binding (`zcode` → the
  z.ai key in `~/.zcode/cli/config.json`; `codex` → the ChatGPT login in
  `~/.codex`; `mock` → nothing).

**Provider = the integration whose credential the topic's session runs on =
the Registry entry = the managed bot.** That identity chain is what makes the
bound structural rather than a UI rule: a managed bot is *provisioned for one
pairing*, holds one account, one credential, one provider. It cannot serve
another provider's models because it does not hold another provider's
credential — `getBackend` refuses to construct a backend it has no
configuration for (that refusal is live code today: `handleBackendCommand`
fails `getBackend(arg)` before touching state, `bridge/index.js:1946-1952`).

On a managed topic, then:

- `/model` lists and switches only the topic's own backend's `listModels()`.
  The cross-backend resolution in `handleModelCommand`
  (`bridge/index.js:1718-1795`) — where a ref found on *another* backend
  "performs the /backend-style fresh-session switch with that model stored for
  the new session" — is refused on managed topics with a message that says why
  ("this topic's provider is fixed by its fleet/model pairing; create a topic
  for <other provider> instead"). `bridge/modelref.js`'s resolver already
  returns the backend the ref was found in (`modelref.js:50-75`); the managed
  gate is one comparison against the topic's own backend, placed right after
  `resolveModelRef` returns.
- `/backend` (`bridge/index.js:1922`) is refused on managed topics for the
  same reason.
- Unmanaged topics (a deployment that never declared a shared chat, or the
  bot's own legacy group) keep today's behavior untouched — including the
  cross-backend switch, which remains correct there, because in that world
  *this bridge holds every provider's configuration itself*.
- MCP `model_set` keeps `validateMcpModel`'s existing allowlist behavior
  (`bridge/index.js:2955`, `validateMcpModel` at `:1912`); it is per-backend already, which is the same
  bound expressed at the MCP layer.

---

## 3. The status line

Today's line (`topicStatusText`, `bridge/index.js:1594-1598`) is:

```
📌 busy · 2 queued · 11% session / 5% week
```

built from `busySessions`, `store.getQueue(threadId).length`, and
`statusUsageText` (`bridge/index.js:1514-1520`), pinned and edited in place by
`updateTopicStatus` (`:1627-1676`).

New format, one segment added, order fixed (fleet and model are identity,
then the dynamics, then usage):

```
📌 <fleet>/<model> · busy · 2 queued · 11% session / 5% week
```

- **fleet**: new state. The bridge learns it from its own configuration —
  `TELEGRAM_FLEET`, written by the relay into the model's `.env` at auth time
  (section 5; the relay knows the fleet name — it is the manager's `FleetRecord`,
  `internal/config/fleet_record.go`). Empty means "not managed": the segment
  degrades to `/model` alone, and a pre-shared-group deployment renders exactly
  today's line. It is a string, not a derivation, for the same reason
  `config.Agent.Model` is (`internal/config/config.go:81-92`: "a name is a
  spelling").
- **model**: already in the store entry. `getOrCreateSession` persists
  `model` and `backend` per topic (`bridge/index.js:1437-1445`); the line
  renders `entry.model || defaultModelFor(entry.backend || cfg.defaultBackend)`.
  Render the *stored* model, which is what the topic runs, not the backend
  default.
- **idle/running, queue depth**: unchanged (`busySessions`,
  `store.getQueue`).
- **usage, per provider**: the two upstreams have different shapes and
  `bridge/usage.js` already normalizes both into one snapshot
  (`{level, windows[{window, used, cap, remaining, percentage, resetsAt}], cachedAt}`,
  `renderUsage` renders both, "the nulls are the interface" for codex, which
  reports percentages only — no fabricated absolutes):

  - *zcode (z.ai)*: `fetchUsage` (`bridge/usage.js:69-83`) reads the coding
    plan quota endpoint with the account's own API key. Field names are
    inverted (`limits[].usage` is the *cap*), unit 3 = hours, unit 6 = weeks;
    `usagePercentages` picks the ~5h and weekly windows. Absolutes exist
    ("2000 / 10000 cr") but the status line keeps the owner-agreed
    percentage-only form.
  - *codex*: `codexUsageCache` → `getBackend('codex').readAccountRateLimits()`
    over the `codex app-server` connection the bridge already holds
    (`bridge/index.js:1535-1552`), no new endpoint. Percentages only.

  The routing already exists — `usageGetForMcp` selects by
  `cfg.defaultBackend` (`bridge/index.js:1572`) — and the fix the status
  line needs is to use it: **`statusUsageText` reads `zaiUsageCache`
  unconditionally today** (`bridge/index.js:1514-1520`), so on a
  codex-default bridge the pinned line silently drops its usage segment while
  `/usage` answers correctly. The status line should take the same thunk
  `usageTelegramText(usageGetForMcp, …)` takes — the same move
  `handleUsageCommand` just made on this branch (commit f3b917f's own message:
  "/usage takes usage_get's path").

---

## 4. `/use-group`

### Discovery

The relay bot already receives `my_chat_member` — it asks for it by name
(`receive.go:116`, with the comment explaining that the update type is never
delivered unless requested) and dispatches it through `onMembership`
(`receive.go:350-369`) into `membershipVerdict` (`:376-413`), which decides
join vs. mere status change. **Discovery is this update**: `m.Chat.ID`,
`m.Chat.Title`, and who did the inviting (`m.From`) all arrive in it. A group
the relay was invited to is known the moment it joins — no polling, no
scanning.

"A message in the group may be needed for discovery" means two things in
practice, and both are already the codebase's own habits:

1. **Groups joined before the relay kept records.** `my_chat_member` is an
   *update* — delivered once, on the Bot API's offset semantics. A relay that
   was down, or was invited while a *different* process held the token, never
   saw it, and the Bot API cannot enumerate a bot's chats afterward (the
   bridge hits the identical wall and documents it at `bridge/store.js:149-153`
   — "The Bot API cannot enumerate a bot's chats"). The remedy is the one
   `zcode-tg`'s README step 4 teaches (`README.md:75-78`): send one message in
   the group; the relay's `onMessage` then sees the chat, records id + title,
   and it joins the candidate list. The `/use-group` listing should say this
   for any group it knows only by a message.
2. **The owner gate on the join.** `membershipVerdict` may make the relay
   *leave* a group it was invited to (`groupPolicy`, default
   `owner-invited`): a shared group must be invited by the owner or it never
   becomes a candidate. That is the existing security model working as
   designed; `/use-group` lists only groups the relay is still in.

### The verb

`/use-group` is a relay verb: a constant in `internal/relay/driver.go`'s verb
block (`driver.go:139-186`), a case in the driver's dispatch, and an entry in
`menuCommands` (`receive.go:465-501`) — that function's own comment is the
standing warning that a verb shipping without a menu line is a verb nobody
finds. The verb takes no argument and answers with the candidate list as
inline buttons (`onCallback` does the rest). Choosing one writes:

- `shared-group.json` (next to `relay.json`, section 2): the chosen chat id,
  its title, and the bindings table (initially empty).
- Nothing else changes about the relay's own serving: it keeps answering
  wherever it is spoken to; the shared group is where it additionally
  *arbitrates* (the pick) and *administers* (bot creation, section 5).

**Existing per-fleet groups: no migration, they keep working.** Their
`.env` files still carry `TELEGRAM_CHAT_ID` pointing at them; the bridge
serves any chat its owner speaks in regardless; and the section 1 gate is
opt-in per chat. The one deployment rule worth writing down: a bridge
*without* the section 1 gate must not be added to the shared group — it would
answer every topic, which is precisely the failure the gate exists to prevent.
Upgrade the bridges, then introduce the shared group.

---

## 5. Managed-bot creation — the decision

The Bot API cannot create bots. Creation is a **BotFather conversation**, and
a BotFather conversation is a *user-session* object — `zBotHowTo`
(`internal/relay/zauth.go:93-101`) already teaches the human the whole dance:
`/newbot`, name it, copy the token. Today a human does every step. The
decision is who does them in the shared-group world. Three options.

### Option A — the relay holds a Telegram *user* session

The relay logs in as the owner's Telegram account (or a dedicated secondary
account) over MTProto and scripts @BotFather itself.

- Libraries, as required by the survey: **Go — `gotd/td`** (pure-Go MTProto,
  the obvious fit for this repo); **JS — `gramjs`** (the `telegram` npm
  package) if it ever lived in the bridge instead. Neither repo contains any
  MTProto/TDLib/gramjs code today (verified — the only "MTProto"-adjacent
  string in either tree is `internal/setup/uninstall.go:72` refusing to write
  a binary).
- Needs `api_id`/`api_hash` (one developer registration at my.telegram.org)
  and **one interactive phone login** (code, possibly 2FA password) — after
  which the session file is a bearer credential for the whole account.
- The relay then opens a user chat with @BotFather, sends `/newbot`, walks the
  name/username prompts, and parses the token out of BotFather's reply.
- What the relay stores: the session file (on the manager account, 0600),
  `api_id`/`api_hash`, and the derived bot tokens.
- What the agent receives: **unchanged** — the token still travels the
  existing `PutZAuth` path (`internal/relay/zauth.go:421-426` →
  `ops.ZAuth{BotToken, ChatID, AllowedUser, Model}` → `internal/ops/ops.go:191-215`
  → `internal/agent/zauth.go:62-63` → the model's `.env`).

**Risks, named.** (1) *A user-session credential on a server.* This is a
different order of credential from a bot token, and the difference is not
subtle: a bot token exposes one bot's updates; a user session exposes the
account's entire chat history and can act as its owner. This workspace's own
security model (the executor account exists so that model-authored commands
cannot reach credentials) makes putting the *owner's Telegram identity* on
the manager account a regression in kind, not degree — and the relay process
is exactly the thing a chat-surfaced bug can steer. (2) *Rate limits and
fragility.* BotFather is an interactive bot; its replies are prose to scrape,
its prompts change without notice, and bulk creation trips flood-waits that
an unattended script handles by retrying into a longer ban. (3) *ToS shape.*
Automated user accounts are a gray zone Telegram enforces opportunistically;
a fleet provisioning bots automatically looks exactly like the thing their
anti-abuse looks for.

### Option B — human-in-the-loop (today's flow, generalized)

The relay prints the exact steps and the name it wants; the owner pastes the
token into the reply that already exists.

- `zBotHowTo` generalizes from "this agent's group" to "the shared group, then
  the naming scheme": the relay generates the bot name deterministically from
  the pairing (`<fleet>-<model>` against the registry's suffix scheme — the
  relay knows both halves at `beginModelAuth` time, `internal/relay/zauth.go:264-292`)
  and says so, so the owner never invents a name and the fleet's account
  list stays legible next to the bot list.
- The capture machinery is already built and already field-hardened:
  `zTokenPrompt` (`zauth.go:74`) is a routing key with truncation tolerance
  (`matchZAuth`, `:503-514`, born from a real incident where a long prompt
  name silently dropped a live token), the reply is deleted on arrival
  (`receive.go:227-228`), and the token lands via `PutZAuth` exactly as in
  Option A.
- What the relay stores: nothing new. What the agent receives: the same
  `ZAuth` write. The cost is ~90 seconds of a person at a phone per new
  `<fleet, model>` — which is the same cost as provisioning the account the
  bot serves (`/provision` is itself a chat verb today).

### Option C — hybrid

Option B in the relay, plus a *separate*, owner-side tool for bulk work: a
small CLI the owner runs **on their own machine** (holding the user session
there, where its blast radius is the owner's own), which scripts BotFather
over MTProto and pushes the resulting tokens to the relay's `PutZAuth` path.
The fleet never holds a user-session credential; the unattended path stays
human-in-the-loop; bulk provisioning of, say, five pairings at once becomes a
single local command. The seam is the same one Option B already has — the
token's *origin* is behind the `ZAuth` write, so the tool changes nothing
downstream.

### The decision

**Option B, with Option C as the designed-for extension and Option A
rejected for the fleet relay.** Reasoning, compactly: the only thing Option A
buys is removing the human from ~90 seconds per pairing, and the price is
putting the owner's Telegram identity on a server account whose whole threat
model (this workspace's AGENTS.md; `internal/agent`'s executor split) is
built on the assumption that model-reachable processes do not hold
person-credentials. The measured fragility of BotFather scraping adds an
operational cost to the one component that must be least flaky. Option B's
machinery is already shipped and already survived its worst incident; Option
C gets the bulk case without the server-side session. If the fleet ever
grows a pairing-per-department shape where B's human step is genuinely the
bottleneck, C is the sanctioned answer — not A.

**What is independent of this choice: everything in sections 1-4, 6, and 7.**
The topology gate, the binding record and its read path, the pick
conversation, the status line, `/use-group` discovery and recording, MCP-only
mode, and the fakes all consume "a token for a managed bot arrives via
`PutZAuth`" and "the relay knows the pairing" — both true under A, B, and C.
The choice touches exactly two strings: who (or what) types the reply to
`zTokenPrompt`, and the wording of `zBotHowTo`.

---

## 6. MCP-only mode (no group at all)

The requirement: zcode and codex stay configurable as MCPs for Claude with
**no Telegram witnessing** — no bot account, no group, no polling.

Today the bridge cannot boot that way. `bridge/index.js:84-86` requires
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_ALLOWED_USER_ID`
through `need()` (`:230-247`, which exits the process when a `TELEGRAM_*` var
is missing), `main()` constructs the TelegramClient unconditionally
(`:256`) and polls forever (`:3016-3050`).

The configuration surface that already exists for the MCP half is
`MCP_UNIX_SOCKET` / `MCP_HTTP_PORT` (`bridge/index.js:144-149`; the gateway
refuses to start without one of them, `bridge/mcp.js:44`) — the per-fleet
unix socket is the production transport and its 0600 placement *is* the
authentication (`bridge/mcp.js:12-19`). The missing piece is making the
Telegram half conditional on it:

- **"No group" is spelled:** `MCP_UNIX_SOCKET` (or `MCP_HTTP_PORT`) set, and
  `TELEGRAM_BOT_TOKEN` absent — with `TELEGRAM_ALLOWED_USER_ID` /
  `TELEGRAM_CHAT_ID` demoted from `need()` to required-only-when-a-token-is-
  present. An explicit `TELEGRAM_ENABLED=0` is the belt to the suspenders for
  a deployment that wants the absence enforced rather than inferred.
- **The bridge behaves:** config parses, store opens, MCP gateway binds the
  socket, backend construction is lazy as today — and the `TelegramClient`
  is never constructed, `setMyCommands` is skipped (`:2987-2995`, already
  failure-tolerant, must become a no-op), and the `getUpdates` loop never
  starts. Not "polling nothing": no token means `getUpdates` is unwritable
  anyway; the point is the loop's absence is *legible* (one log line:
  "MCP-only: no Telegram transport configured").
- **The one seam that assumes Telegram:** `session_create` mints its key via
  `createForumTopic` (`bridge/index.js:2842-2872`), and its auto-pick needs a
  live forum chat (`pickDefaultForumChat`, `:2233-2255`, validated live via
  `getChat`/`getChatMember`). In MCP-only mode, `session_create` with no
  `chat_id` mints a topic-less key (the `c<chat>` form of `keyFor`,
  `:2181-2188`, already exists for chats without topics), `messageSend`'s
  mirror into the chat is skipped — it is already best-effort and logged when
  it drops (`:2883-2902`) — and the reply is delivered through `replies_get`,
  which is the MCP contract's own channel. The agent side of this already
  exists and needs nothing: `models.Registry`'s `Junior` + `JuniorAgentTools`
  (`internal/models/models.go:44-49, 240-266`) wire the MCP delegation into
  Claude's allowlist independent of any transport.

This is also the honest answer to "what does the shared group change for the
MCP path": nothing. The MCP gateway drives the same topic store and dispatch
pipeline whether the topics are Telegram's or synthetic.

---

## 7. Testing without real accounts

Both repos already run the full stack against local fakes over the
`TELEGRAM_API_ROOT` seam (`bridge/telegram.js:1-14`; the Go side consumes the
same seam — `internal/e2e/steps_zcode.go:1423-1430` points the bridge at
`fakeTelegram` "the seam the zcode-tg repo's own e2e uses"). The design adds
four surfaces the fakes must grow:

**`fakeTelegram` must additionally fake — both repos' fakes, same list:**

1. **`getMe` per token.** Keyed on the token in the request path
   (`/bot<token>/<method>` — the fake sees it, today it answers `ok` with
   `{}` like everything else). This matters beyond politeness: the Go fake's
   empty `getMe` leaves `t.me.Username` empty, which *disables* the
   @-address check at `receive.go:293` — a real behavior today, silently
   untested. Per-token `getMe` is also what makes the two-bridge tests below
   possible.
2. **`my_chat_member` push + join events.** A helper like the existing
   `pushUserMessage` (`steps_zcode.go:1549-1567`) that queues a
   `my_chat_member` update (join: `old_chat_member.status = "left"`,
   `new_chat_member.status = "administrator"`, `from` = the owner id). This
   exercises discovery (`membershipVerdict`) end to end. The JS fakes have no
   push helper for it at all — `handleMyChatMember` (`bridge/index.js:2261`)
   is reached by no e2e today. The bridge's own `getUpdates` defaults to the
   same three update types (`bridge/telegram.js:48-50`), so both sides' fakes
   see identical traffic.
3. **Forum topics.** The Go fake already does the important half:
   `createForumTopic` returns a real, distinct `message_thread_id`
   (`steps_zcode.go:1490-1498` — "an empty result quietly degrades every key
   built from it"), and `getChat`/`getChatMember` answer as a forum
   supergroup with the bot as admin (`:1476-1489`). What remains:
   `forum_topic_created` *service message* push (the bridge's own
   topic-seeding path, `bridge/index.js:2295`), and the JS fakes'
   `createForumTopic` (`test/e2e.mjs` answers `ok`-empty for it — same
   thread-id degradation the Go comment warns about).
4. **Callback queries.** Both pick conversations run on them. Push a
   `callback_query` (with `message.message_thread_id` set), record the
   `answerCallbackQuery` call, and assert the handler answered. The JS fake
   already swallows `answerCallbackQuery` as `ok`-empty (`test/e2e.mjs:133`);
   it needs the push side.
5. **Two bots, one fake.** The routing property — exactly one bot answers a
   topic — is only testable with two bridge processes pointed at one fake
   (two tokens, two `getUpdates` consumers; the fake keys state per token).
   This is the test that fails if the section 1 gate regresses.

**Where the tests live:**

- `zcode-tg`: unit tests as `test/*.test.js` under `node --test` (the pure
  halves — the ownership predicate, the @-suffix comparison, the bounded
  `/model` resolution, the status-line renderer — are all extractable the way
  `bridge/modelref.js` was made pure deliberately); the two-process and
  pick-flow scenarios as `test/e2e-*.mjs` against the extended fake.
- `agent-cage`: pure-transport tests beside their subjects
  (`internal/chat/telegram/receive_test.go` — `membershipVerdict` already
  demonstrates the pattern: "Separated from the calls it leads to so the rule
  can be tested"); the full flow as e2e steps in `internal/e2e/` (the pick
  conversation joins `steps_zcode.go`'s zauth steps, which already assert the
  `✅` reply names the right holder, `:1408-1420`), orchestrated by
  `internal/testenv/e2e_test.go`.

**The Telegram test DC: not worth touching.** Say no, for three reasons.
(1) Nothing in this design speaks MTProto — every surface is Bot API, and the
fakes cover the Bot API surface completely; a test DC would be testing
Telegram's servers, not this code. (2) Forum-topic behavior on the test DC is
undocumented — the one thing it might have been worth checking is exactly the
thing it does not answer, and the fakes (which encode *our* assumptions) are
the better specification. (3) It adds an external dependency — accounts on a
Telegram DC, network egress, phone-less `-99966` user quirks — to a test
suite whose current virtue is that `go test` and `node --test` run hermetic.
If Option A (section 5) is ever revived, its BotFather conversation should be
faked at the MTProto client seam for the same reasons — the test DC is still
not the tool.

---

## 8. Work breakdown

Ordered commits; each independently shippable and each stating what it is
gated on. Bridges before relay writes: the deployment rule from section 4
(a bridge without the gate must not meet the shared group) generalizes to
every commit — no writer ships pointing at a reader that cannot exist yet.

**zcode-tg** (`usage-onto-pin`):

1. **`parseCommand` compares the @suffix against our own username.** Live
   bug fix (a command addressed to another bot executes today), required by
   section 1, zero behavior change for single-bot deployments. Gated on:
   nothing.
2. **Status line v2.** `TELEGRAM_FLEET` (optional; empty degrades to
   today's line) + fleet/model segment in `topicStatusText` + usage routed
   through the `usage_get` source selection (fixes codex-default bridges
   silently dropping the segment — section 3). Gated on: nothing. The fleet
   segment renders empty until commit 7's `.env` write exists; that is the
   intended degradation.
3. **Managed-topic gate.** `TELEGRAM_SHARED_GROUP` declaration, bindings-file
   read (empty file = everything unbound), the ownership predicate as a pure
   function with unit tests, the unbound-topic hint message. Gated on:
   nothing (inactive without the env var); *useful* only with 7.
4. **`/model` and `/backend` bounded on managed topics.** The provider gate
   after `resolveModelRef`, the `/backend` refusal. Gated on: 3.
5. **Bindings re-read.** mtime-watch (or read-through in
   `getOrCreateSession`) so a binding landing while the bridge runs takes
   effect without a restart. Gated on: 3; the writer is 7.
6. **MCP-only boot.** The `TELEGRAM_*` trio demoted, transport construction
   and poll loop conditional, topic-less MCP sessions, mirror skip. Gated on:
   nothing — this is the "must work without `/use-group`" guarantee and can
   ship at any point.

**agent-cage** (`feat/short-names` — the work lands on a fresh branch off it;
the branch itself is read-only for this design):

7. **Binding + fleet delivery.** `ops.ZAuth` grows `Fleet` (empty =
   compat, exactly as `Model`'s own doc requires, `internal/ops/ops.go:213-215`);
   the agent's `PutZAuth` writes it and the bindings file into the model's
   config directory; the e2e fake grows `getMe` per token (un-disables the
   @-check at `receive.go:293` in tests) and the `my_chat_member` push.
   Gated on: 3 (bridge reader) — ship after it.
8. **Shared-group discovery + `/use-group`.** Groups recorded from
   `my_chat_member`/first message into `shared-group.json` beside
   `relay.json`; the verb, its `menuCommands` line, and the candidate-list
   buttons. Gated on: nothing relay-side; pairs with 7 for the full story.
9. **The pick conversation.** Topic-blindness fix in `internal/chat`'s
   `message` decode (`message_thread_id`, parse-only), the two-step
   fleet→model pick over callback queries, bindings written relay-side.
   `models.json` (`internal/config/model_accounts.go`) is the fleet→models
   source. Gated on: 8.
10. **Provisioning flow, generalized `zBotHowTo`.** `beginModelAuth` /
    `resolveAuthTarget` extended with the shared-group path (deterministic
    bot name, shared-group wording, Option B's human steps, `PutZAuth` as the
    unchanged delivery), e2e steps for the whole arc, the two-bridge
    exactly-one-answer assertion. Gated on: 9.

Commits 1, 2, 6 (bridge) and 7, 8 (relay) are the shippable spine that
changes nothing about today's deployments; 3-5 and 9-10 are the shared-group
feature proper, and the feature is *on* only when an operator sets
`TELEGRAM_SHARED_GROUP` and runs `/use-group` — at which point every gate in
this document is already behind a test.
