// zcode <-> Telegram bridge.
//
// One Telegram forum topic == one zcode session. Sending a message in a
// topic sends it to that session; the reply STREAMS into the topic's
// placeholder message (edited in place, at most once per
// STREAM_EDIT_INTERVAL_MS, prefixed ⌛ while the turn is still running) and
// is finalized there when the turn ends -- with a small usage footer
// (duration · tokens · tool calls). A message sent while a turn is still
// running is queued (persistently) and runs when that turn ends.
// Send /stop (or /cancel) in a busy topic to abort its in-progress turn.
//
// Bridge commands (intercepted before anything reaches the model; anything
// else starting with / is passed through to zcode's own command handling):
//   /usage      plan quota for this bridge's own backend (the usage_get path)
//   /stop /cancel   cancel the topic's running turn
//   /queue      list this topic's queued messages
//   /clearqueue drop this topic's queued messages
//   /model      list models / switch this topic's model
//   /mode       list modes / switch this topic's session mode
//   /file       send a file from the workspace into this topic
//   /help       the list above
// These are registered with BotFather-style autocomplete (setMyCommands)
// on every boot.
//
// Model replies are rendered from markdown to Telegram HTML (bridge/format.js)
// and split under the 4096-char message cap; if Telegram ever rejects the
// entities, the chunk falls back to plain text rather than being lost.
//
// The model's mid-turn questions (interaction/requestUserInput, the
// AskUserQuestion tool) are posted to the topic as inline-button prompts and
// genuinely answered from Telegram; with no answer within
// USER_INPUT_TIMEOUT_MS they are declined so the turn keeps moving.
//
// Permission requests: sessions run in "yolo" mode (auto-approve) by
// default, and any interaction/requestPermission that still arrives is
// auto-approved with a non-blocking notice posted to the topic. Set
// AUTO_APPROVE_PERMISSIONS=false to fall back to interactive Approve/Deny
// inline-keyboard prompts instead.
//
// Each topic also gets a status message (model · mode · busy/idle · queue),
// pinned if the bot has pin rights, updated whenever that state changes.
//
// Background tasks: when a task started by the agent finishes while the
// session is idle, zcode emits a task-completed session event and then
// auto-starts a "task notification" turn. The bridge posts a 🌀 notice for
// the former and adopts the latter (fresh ⌛ placeholder, normal delivery),
// so the agent's own follow-up on the completed task reaches the topic
// instead of being silently dropped.
//
// Transport is Telegram long-polling only -- no inbound port, no webhook,
// nothing to put behind the TLS cert (that's for the future WebSocket/app
// phase). Run this as a long-lived process (see README.md for the systemd
// unit); it does not daemonize itself.

import { randomBytes } from 'node:crypto';
import { createMcpGateway, raceReply, repliesForTopic } from './mcp.js';
import { pickForumChat } from './chatpick.js';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, resolveEnvPath } from './env.js';
import { ZcodeBackend } from './backends/zcodeBackend.js';
import { CodexBackend } from './backends/codexBackend.js';
import { MockBackend, MOCK_MODEL_REF } from './backends/mockBackend.js';
import { makeSessionId, backendNameOf, rawSessionId } from './backend.js';
import { TelegramClient, TelegramClient as TG } from './telegram.js';
import { buildConfig, ConfigError } from './config.js';
import { Store } from './store.js';
import { renderReply, toPlainText, extractFileMarkers } from './format.js';
import { ReplyStreamer } from './streamer.js';
import { ProgressReporter, stepDetail, noteActivity, progressForTopic } from './progress.js';
import { readZaiApiKey, readZaiProvider, fetchUsage, usageSnapshotOrThrow, codexUsageSnapshotOrThrow, codexUsageFetchError, usageTelegramText, createUsageCache, unconfiguredUsageError, statusPercentages, statusModelFor, statusLineText } from './usage.js';
import { runtimePreferences } from './runtimePrefs.js';
import { mergeModelLists, resolveModelRef } from './modelref.js';
import { parseCommandText, commandIsOurs, proxiedBackendSwitchRefusal } from './commands.js';
import { createTopicStatusTracker } from './topicStatus.js';

// Deliberately NOT ../.env (repo root == the zcode agent's own workspace):
// a session running in this same directory could read that file as part of
// completely ordinary "look at your own code" work and echo the bot token
// back into Telegram, no adversarial intent required. Kept outside the
// workspace instead -- see resolveEnvPath (env.js) for the search order and
// compatibility fallbacks.
loadEnv(resolveEnvPath({ override: process.env.ZCODE_TG_ENV || process.env.ZCODE_MOBILE_ENV }));

// Parsed in bridge/config.js so the three boot states (Telegram, MCP-only,
// neither) are unit-testable without booting this file. A ConfigError is the
// operator-facing boot refusal -- printed and exited exactly as the inline
// need() it replaced did; anything else is a bug and propagates.
let cfg;
try {
  cfg = buildConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
// The MCP gateway handle (module-level because finalizeTurn's reply hook
// notes replies into it); created in main() when MCP_HTTP_PORT is set.
let mcp = null;

// Registered with Telegram on boot so these show as / autocomplete in the
// client. Keep in sync with the command handling in handleMessage().
const BOT_COMMANDS = [
  { command: 'usage', description: "Plan usage & quota (this bridge's backend)" },
  { command: 'stop', description: "Cancel this topic's running turn" },
  { command: 'cancel', description: "Cancel this topic's running turn" },
  { command: 'queue', description: 'Show queued messages in this topic' },
  { command: 'clearqueue', description: 'Drop queued messages in this topic' },
  { command: 'model', description: 'List / switch this topic’s model' },
  { command: 'mode', description: 'List / switch this topic’s mode' },
  { command: 'backend', description: 'List / switch this topic’s backend (zcode/codex/mock)' },
  { command: 'file', description: 'Send a workspace file into this topic' },
  { command: 'help', description: 'Bridge commands' },
];

const store = new Store(cfg.storePath);

// THE TELEGRAM TRANSPORT IS OPTIONAL. Constructed only when a token is
// configured; MCP-only mode (MCP_UNIX_SOCKET / MCP_HTTP_PORT with
// TELEGRAM_BOT_TOKEN absent -- shared-group design section 6) runs the same
// store, backends and MCP gateway with `tg` permanently null: no bot, no
// group, no polling, no setMyCommands. The client's constructor refuses a
// missing token, so the condition here is also what keeps that refusal from
// killing a token-less boot.
const tg = cfg.telegramToken ? new TelegramClient({ token: cfg.telegramToken }) : null;
// THE ONE PREDICATE every MCP-only guard is written against. Each code path
// that can run without Telegram checks it ONCE, at its single entry (the
// function head, or the one branch that posts to the chat) -- never as
// scattered `if (tg)` null-dodges. A path that genuinely needs Telegram and
// is still reached refuses with a clear error instead of crashing on null.
const telegramEnabled = () => tg !== null;

// --- backend registry ---
// One long-lived instance per backend KIND (not per session/topic) --
// exactly the "one process, many multiplexed sessions" shape zcode always
// had.
//
// THE EAGER/LAZY SPLIT IS BY cfg.defaultBackend, NOT BY BACKEND NAME.
// Originally (before a second backend existed) zcode was unconditionally
// eager -- there was only one backend, so "eager" and "load-bearing" were
// the same thing by construction. When Codex was added, that got hardcoded
// forward as "zcode is eager and load-bearing, Codex is lazy and optional",
// which is silently wrong the moment a deployment sets DEFAULT_BACKEND=codex:
// it would still eagerly spawn a `zcode app-server` and treat ITS death as
// fatal to the whole process, even though that deployment may have no real
// z.ai credential configured at all and never intends to use zcode. Fixed
// (2026-09-08, "bug #3"): whichever backend cfg.defaultBackend actually
// names is the one started eagerly, here, at module load -- exactly the
// point in startup zcode's own eager start always ran at, with identical
// construction args and an identical synchronous start() call, so a
// deployment with DEFAULT_BACKEND=zcode (the live one, and the default
// absent that env var) is byte-for-byte unchanged by this refactor. ANY
// OTHER known backend stays lazy, built and started the first time a topic
// actually asks for it (getBackend() below) -- see wireBackend() for what
// "starts" wires up on every backend alike, and its exit handler for how
// "load-bearing" now means "is the default backend" instead of a bare name
// check.
const backends = {};

// One factory per backend kind, used for BOTH the eager default-backend
// construction below and getBackend()'s lazy path -- a backend the caller
// never touches is never even constructed (never mind started), so a
// deployment missing that backend's config (e.g. no CODEX_HOME on a
// zcode-default deployment, or no z.ai credential on a codex-default one)
// pays nothing for it. Codex's factory already threw on missing config
// before this refactor (see the getBackend() 'codex' branch it replaces);
// zcode's factory has no equivalent guard because it never needed one --
// a missing/invalid z.ai credential doesn't stop the zcode app-server
// process from *starting*, only from completing a real turn (see
// zcodeClient.js's spawn-'error' handling and bridge/backends/zcodeBackend.js
// for what DOES fail, and how).
const BACKEND_FACTORIES = {
  zcode: () => {
    const backend = new ZcodeBackend({ nodeBin: cfg.nodeBin, zcodeBin: cfg.zcodeBin, cwd: cfg.workspaceDir, zaiConfigPath: cfg.zaiConfigPath });
    // THE RUNTIME-PREFERENCES HANDLER, REGISTERED AT THE ONE PLACE A ZCODE
    // BACKEND IS EVER CREATED. This factory serves BOTH start paths -- the
    // eager default-backend boot and getBackend()'s lazy construct-on-first-
    // use -- so every zcode instance answers
    // session/requestRuntimePreferences, whichever way it came to exist. It
    // used to be registered once at module scope against `backends.zcode`,
    // which crashed every bridge whose default backend wasn't zcode
    // (backends.zcode didn't exist yet) and, had that been patched with an
    // optional chain, would have silently dropped the handler from every
    // zcode constructed LAZILY -- the /backend-zcode-on-a-codex-bridge case.
    //
    // ZCODE-ONLY, AND KEPT IN THE ZCODE BRANCH FOR THAT REASON:
    // session/requestRuntimePreferences is a zcode app-server method with no
    // Codex analog (codexBackend.js registers nothing like it), so this is
    // not a backend-generic wireBackend() concern. And answering it is not
    // optional: the blanket "unregistered method" reply is -32601, which the
    // app-server reads as "client too old" and answers by enabling its own
    // bash prelude -- see runtimePrefs.js for the whole chain and why
    // NATIVE_SEARCH_ENHANCEMENTS exists.
    backend.onServerRequest('session/requestRuntimePreferences', async () => runtimePreferences());
    return backend;
  },
  codex: () => {
    if (!cfg.codexHome) throw new Error("the 'codex' backend needs CODEX_HOME set (see README)");
    return new CodexBackend({ codexBin: cfg.codexBin, codexHome: cfg.codexHome, cwd: cfg.workspaceDir, autoApprovePermissions: cfg.autoApprovePermissions });
  },
  // No config to check -- that's the whole point (see mockBackend.js's
  // module comment). Eligible as DEFAULT_BACKEND=mock too, for a deployment
  // that wants zero external dependencies at all (e.g. this bridge's own
  // future from-scratch tests).
  mock: () => new MockBackend(),
};

// THE /model SPAN, and its safe default. A production bridge must not have
// its /model construct the mock backend and offer the owner fake models
// (mock is the zero-credential test double -- see README's "The mock
// backend"), so the default is every known backend EXCEPT mock. A bridge
// whose DEFAULT_BACKEND is mock, or which eagerly starts mock via
// EAGER_BACKENDS, is itself a test bridge and sees mock unless the operator
// names a list without it. This set is what gatherModelsAcrossBackends
// iterates AND what resolution sees: a `mock:` qualified ref on a bridge
// that excludes mock is refused as unknown, never constructed.
const modelBackends = cfg.modelBackendsEnv.length
  ? cfg.modelBackendsEnv
  : Object.keys(BACKEND_FACTORIES).filter((name) => name !== 'mock' || cfg.defaultBackend === 'mock' || cfg.eagerBackends.includes('mock'));
for (const name of modelBackends) {
  if (!BACKEND_FACTORIES[name]) {
    throw new Error(`unknown backend in MODEL_BACKENDS: ${name} (known: ${Object.keys(BACKEND_FACTORIES).join(', ')})`);
  }
}

// Per-backend default model, used wherever a topic/session needs one and
// hasn't been told otherwise (a brand-new session, or /model's "current"
// display with nothing stored yet). One place so the three-way branch this
// replaced (zcode's cfg.defaultModel / Codex's cfg.codexDefaultModel / a
// third backend's own default) can't drift across call sites -- it already
// had before mock was added (see git history: getOrCreateSession's model
// fallback and /model's "current" display used to hand-roll the same
// zcode/codex two-way check independently).
function defaultModelFor(backendName) {
  if (backendName === 'codex') return cfg.codexDefaultModel || undefined;
  if (backendName === 'mock') return MOCK_MODEL_REF;
  return cfg.defaultModel;
}

function wireBackend(backend) {
  backend.on('event', onBackendEvent);
  backend.on('warn', (m) => console.error(`[bridge] [${backend.name}]`, m));
  backend.on('stderr', (text) => process.stderr.write(`[${backend.name} stderr] ${text}`));
  backend.on('parseError', ({ line, error }) => console.error(`[bridge] unparseable line from ${backend.name}:`, error.message, line.slice(0, 200)));
  backend.onPermissionRequest(onPermissionRequest);
  backend.onUserInputRequest(onUserInputRequest);
  backend.on('exit', ({ code, signal }) => {
    if (backend.name === cfg.defaultBackend) {
      // The deployment's load-bearing backend: every topic that doesn't
      // explicitly choose another one depends on it, so its death takes the
      // bridge down for the service manager to restart -- unchanged
      // behavior from before this refactor for a zcode-default deployment
      // (the live one), now correctly generalized to whichever backend is
      // actually load-bearing here instead of hardcoding zcode's name.
      console.error(`[bridge] ${backend.name} app-server exited unexpectedly (code=${code} signal=${signal}); exiting so the service manager restarts us`);
      // TELL THE MCP CALLER BEFORE THE SOCKET GOES. A supervising model parked in
      // message_send has no other way to learn this: exiting first drops its
      // connection mid-request, which arrives as a transport error indistinguishable
      // from a network hiccup, and if it somehow survives that it waits out the full
      // ten-minute timeout and is then told "the turn may still be running" -- which
      // by then is a lie.
      //
      // THE MESSAGE ADMITS IGNORANCE ON PURPOSE. A process killed by a signal
      // reports nothing on its way out, so this bridge genuinely does not know
      // whether the runtime crashed, was OOM-killed, or was stopped by a person.
      // Naming SIGKILL and the most likely cause, while saying plainly that the
      // cause is not established, is more useful to a model deciding what to do
      // next than either a confident guess or silence.
      const killed = signal === 'SIGKILL' || code === 137;
      const why =
        `the ${backend.name} runtime exited while this turn was running (code=${code} signal=${signal}). ` +
        'The bridge does not know why: a process killed by a signal cannot report anything on its way out. ' +
        (killed
          ? 'SIGKILL here is most often the kernel out-of-memory killer -- this host, or this pod, ran out of memory. '
          : '') +
        'The turn is lost and no partial answer was delivered. The bridge restarts automatically; retry in a few seconds, ' +
        'and if it happens again the fleet is probably short of memory rather than the request being at fault.';
      const stranded = mcp ? mcp.failWaiters(why) : 0;
      if (stranded) console.error(`[bridge] failed ${stranded} parked MCP caller(s) with the reason above`);

      // A BEAT FOR THOSE REPLIES TO REACH THE WIRE. The rejections above turn into
      // JSON-RPC error responses written to a socket; process.exit() on the same
      // tick discards them and the caller is back to a dropped connection.
      //
      // 250ms IS ONLY ENOUGH BECAUSE message_send RACES (see raceReply). Awaiting
      // the dispatch first would put a Telegram round trip between the rejection
      // and the response, and this timer would routinely lose to it.
      if (stranded) setTimeout(() => process.exit(1), 250);
      else process.exit(1);
    }
    // Optional/secondary backend: its subprocess dying shouldn't take down
    // topics running on the default one. Sessions currently on it will error
    // on their next call (backends[name] still points at the dead instance)
    // rather than silently hang; a fresh getBackend(name) call after this is
    // NOT auto-respawned by this handler on purpose -- restarting the whole
    // bridge is the same "known good" recovery the default backend already
    // relies on.
    console.error(`[bridge] ${backend.name} app-server exited unexpectedly (code=${code} signal=${signal}); ${backend.name}-backed topics are unavailable until the bridge restarts`);
  });
  return backend;
}

if (!BACKEND_FACTORIES[cfg.defaultBackend]) {
  throw new Error(`unknown DEFAULT_BACKEND: ${cfg.defaultBackend} (known: ${Object.keys(BACKEND_FACTORIES).join(', ')})`);
}
// THE EAGER SET: cfg.eagerBackends when the operator named one, else the
// default backend alone -- which makes the unset behavior the identical two
// statements this loop replaced (construct the default, start it, nothing
// else).
const eagerBackends = cfg.eagerBackends.length ? [...new Set(cfg.eagerBackends)] : [cfg.defaultBackend];
for (const name of eagerBackends) {
  if (!BACKEND_FACTORIES[name]) {
    throw new Error(`unknown backend in EAGER_BACKENDS: ${name} (known: ${Object.keys(BACKEND_FACTORIES).join(', ')})`);
  }
  backends[name] = wireBackend(BACKEND_FACTORIES[name]());
  backends[name].start();
}

function getBackend(name) {
  if (backends[name]) return backends[name];
  const factory = BACKEND_FACTORIES[name];
  if (!factory) throw new Error(`unknown backend: ${name}`);
  backends[name] = wireBackend(factory());
  backends[name].start();
  return backends[name];
}

// Resolve the backend a given (prefixed) sessionId belongs to.
function backendForSession(sessionId) {
  return getBackend(backendNameOf(sessionId));
}

// Defense in depth only -- every await chain in this file is intended to be
// caught somewhere already (per-update try/catch in main(), try/catches
// around individual RPCs). This is a backstop against a *future* unguarded
// await slipping in unnoticed, not a substitute for handling errors at the
// point they occur: log and keep running rather than let Node's default
// behavior (crash the whole process) turn one bad await into an outage for
// every topic.
process.on('unhandledRejection', (err) => console.error('[bridge] unhandled rejection:', err));

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
async function shutdown(signal) {
  // Found the hard way (2026-09-01): a redeploy -- the common case this
  // fires for -- used to kill the app-server child a moment after this ran,
  // taking with it whatever turn was streaming into a topic's placeholder.
  // Nothing was left to ever edit that message again: the watchdog is off by
  // default, and even armed, no sweep runs between then and process death.
  // The placeholder just sat there forever showing a stale "💭 · 117s" --
  // exactly the "task performed well but didn't report" failure mode all
  // over again, just triggered by an intentional restart instead of a
  // timeout. That version of this function notified every in-flight turn
  // before killing anything -- an honest apology, but still an interrupted
  // turn every time a redeploy landed mid-work.
  //
  // Extended the same day: an apology is strictly worse than the turn just
  // finishing. Nothing about a redeploy actually requires killing the
  // process the instant the signal arrives -- so stop ADMITTING new work
  // (the `draining` flag, checked in handleMessage and drainQueue) and wait
  // for what's already running to finish through the ordinary finalizeTurn
  // path first. No special-casing needed there: it already delivers
  // correctly and clears activeTurns/busySessions itself. This intentionally
  // is NOT a two-process blue-green handoff -- Telegram's getUpdates
  // long-poll tolerates exactly one consumer and store.js's lock is
  // exclusive to one process, both already true of this bridge for other
  // reasons -- so "keep the one process alive and responsive a bit longer"
  // is the zero-downtime shape actually available here, not "start a second
  // one alongside it".
  //
  // Only turns still open after cfg.shutdownDrainMs get the interrupt-and-
  // notify treatment below, same as the old unconditional behavior -- a
  // genuinely stuck turn (or an operator who wants fast restarts) isn't left
  // waiting forever. Killing the app-server process is a strictly stronger
  // stop than the session/stop RPC (confirmed elsewhere in this file not to
  // reliably interrupt an in-flight tool-call loop) -- once the process is
  // gone, nothing is running -- so there's no need to also call session/stop
  // on the way out.
  draining = true;
  console.log(`[bridge] received ${signal}: draining ${activeTurns.size} in-flight turn(s) for up to ${cfg.shutdownDrainMs}ms before restart`);
  if ((activeTurns.size > 0 || pendingFinalize > 0) && cfg.shutdownDrainMs > 0) {
    await waitForDrain(cfg.shutdownDrainMs);
  }
  if (activeTurns.size > 0) {
    console.log(`[bridge] drain window elapsed with ${activeTurns.size} turn(s) still running -- notifying and interrupting`);
  } else {
    console.log('[bridge] all in-flight turns finished naturally -- nothing to interrupt');
  }

  // Bounded wait so a slow Telegram call can't hang a redeploy indefinitely;
  // under systemd this whole handler is also redundant-but-harmless with the
  // default KillMode=control-group (which reaps the app-server child
  // regardless), and matters most for the foreground/dev-loop path
  // README.md documents, where nothing else guarantees the child doesn't
  // outlive us as an orphaned, still-authenticated zcode process.
  // ENTRIES, NOT VALUES: activeTurns is keyed by sessionId, and the chat a
  // turn belongs to is reachable only through that key (sessionToTopic). The
  // value alone does not carry it, which is how `chatOf(threadId)` came to be
  // written here against an identifier this scope does not define.
  const notifications = [...activeTurns.entries()].map(([sessionId, turn]) => {
    turn.streamer?.stop();
    turn.progress?.stop();
    const liveId = turnLiveMessageId(turn);
    // Fixed: was chatOf(threadId), a bare undefined module-global that
    // happened to fall back to cfg.chatId (correct only for the single
    // configured home chat) -- see the identical fix in onUserInputRequest
    // above. sessionToTopic has this session's real conversation key.
    const topic = sessionToTopic.get(sessionId);
    if (!liveId || !topic) return Promise.resolve();
    return tg
      .editMessageText({
        chatId: chatOf(topic.threadId),
        messageId: liveId,
        text: "⚠️ Bridge is restarting (deploying an update) — this turn was interrupted. Send your message again once it's back (usually a few seconds).",
      })
      .catch((e) => console.error('[bridge] failed to notify an in-flight turn of shutdown:', e.message));
  });
  await Promise.race([Promise.allSettled(notifications), sleep(8000)]);

  // THE SAME COURTESY THE TELEGRAM SIDE ALREADY GETS. The loop above edits
  // every interrupted turn's placeholder to say the bridge is restarting; an
  // MCP caller parked in message_send got nothing at all and sat out its full
  // ten-minute timeout, on every ordinary redeploy.
  mcp?.failWaiters(
    'the bridge restarted (a deploy or a supervisor restart) while this turn was running, so the turn was ' +
      'interrupted. Nothing partial was delivered. Send the message again once the bridge is back, usually a few seconds.',
  );
  await sleep(100); // let those rejections reach the socket before it closes

  for (const backend of Object.values(backends)) backend.stop();
  process.exit(0);
}

// Polls (rather than wiring an event) because activeTurns/pendingFinalize
// are plain counters mutated all over this file (finalizeTurn, the /stop
// handler, the watchdog) -- adding an emitter just for this one caller would
// be more moving parts than a 500ms poll against a bounded, one-shot wait.
async function waitForDrain(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while ((activeTurns.size > 0 || pendingFinalize > 0) && Date.now() < deadline) {
    await sleep(500);
  }
}

// --- in-memory routing state (rebuilt each process start; durable session
// identities live in `store`) ---
const subscribedSessions = new Set(); // sessionId we've called session/subscribe for, this process
const sessionToTopic = new Map(); // sessionId -> { threadId }
const busySessions = new Set(); // sessionId currently running a turn
const activeTurns = new Map(); // sessionId -> { placeholderMessageId, textBuffer, startedAt, turnId?, streamer, usageSummary?, toolNames, adopted? }
// Set true by shutdown() once a redeploy starts draining. Checked in
// handleMessage (queue instead of starting a fresh turn) and drainQueue
// (don't promote the next queued item) so activeTurns can actually reach
// zero instead of one finished turn being replaced by a freshly-started one.
let draining = false;
// Turns still inside finalizeTurn's delivery awaits (Telegram calls) after
// activeTurns has already lost their entry -- see finalizeTurn and
// shutdown()'s waitForDrain. Without this, the drain wait could see
// activeTurns.size hit 0 and process.exit() out from under a reply that's
// mid-send.
let pendingFinalize = 0;
const pendingPermissions = new Map(); // requestId -> { resolve, tokenMap: Map(token->response), chatId, threadId }
const pendingUserInputs = new Map(); // requestId -> { resolve, timer, questions, answers, tokenToChoice, chatId, threadId }
const tokenToRequestId = new Map(); // callback_data token -> requestId ('p_' permissions, 'u_' user input)
const pendingPrompts = new Map(); // threadId -> { parts: [promptText...], firstAt, timer } -- burst-merge window

// interaction/requestUserInput (the model's "AskUserQuestion" tool, asking a
// mid-turn clarifying question). The server sends
//   { input, prompt, requestId, sessionId, toolName, turnId,
//     questions: [{ header, multiSelect, question,
//                   options: [{ label, description, value }] }] }
// (field shapes confirmed against a live app-server: each option's protocol
// value IS its label) and expects a reply
// matching { action: "accept"|"decline"|"cancel", content?, reason? } --
// where accept+content gets merged back into the tool input as
// content.answers keyed by question text (or answer_0..N). Anything else --
// decline in particular -- must remain a *valid* reply: the runtime's
// default client-request path only degrades gracefully for valid declines,
// and letting the blanket "unregistered method -> error" default answer
// instead rethrows inside the runtime's own race wrapper and most likely
// fails the tool call outright.
//
// The bridge posts one message per question with inline buttons (plus Skip),
// waits up to cfg.userInputTimeoutMs for taps, then answers. Timeout ->
// decline (same as the old auto-decline behavior, just later). One tap per
// question; multiSelect questions are answered single-pick (documented
// limitation -- Telegram buttons don't toggle).

// Registered on every backend that supports it (see wireBackend()) --
// currently zcode only; Codex's nearest analog is experimental and unwired,
// see bridge/backends/codexBackend.js.
async function onUserInputRequest(params) {
  // MCP-only: there is no chat to post the question into and no one to tap
  // it, so waiting out the timeout would only park the turn. Decline at
  // once -- the same answer the timeout eventually gives, honestly labeled --
  // so the turn keeps moving; the reason goes back to the model.
  if (!telegramEnabled()) {
    return { action: 'decline', reason: 'bridge: MCP-only mode (no Telegram) -- nobody can answer a mid-turn question' };
  }
  const topic = sessionToTopic.get(params.sessionId);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (!topic || !questions.length || !questions.every((q) => Array.isArray(q.options) && q.options.length)) {
    return { action: 'decline', reason: 'bridge: question not deliverable to Telegram (no topic or malformed questions)' };
  }

  const tokenToChoice = new Map(); // token -> { question, label, value, skip }
  const state = {
    resolve: null,
    timer: null,
    // Fixed: this used to read a bare `threadId` that doesn't exist in this
    // scope (a module-global that was never declared) -- chatOf() fell back
    // to its own "unparseable key" default, cfg.chatId, which happens to be
    // correct for the single configured home chat but would misroute for
    // any other chat (e.g. an MCP session_create with a custom chat_id).
    // topic.threadId is this session's actual conversation key.
    chatId: chatOf(topic.threadId),
    threadId: topic.threadId,
    questions: [],
    answers: {},
    tokenToChoice,
  };

  for (const [qi, q] of questions.entries()) {
    const lines = [`❓ ${q.header || 'Question'}`, q.question || ''].filter(Boolean);
    if (q.multiSelect) lines.push('(multi-select — pick one)');
    if (questions.length > 1) lines.push(`(question ${qi + 1} of ${questions.length})`);
    const buttons = q.options.slice(0, 8).map((opt) => {
      const token = 'u_' + randomBytes(6).toString('hex');
      const label = truncate(opt.label || String(opt.value ?? 'option'), 60);
      tokenToChoice.set(token, { question: q, label, value: opt.value ?? opt.label, skip: false });
      if (opt.description) lines.push(`• ${label} — ${truncate(opt.description, 200)}`);
      return { text: label, data: token };
    });
    const skipToken = 'u_' + randomBytes(6).toString('hex');
    tokenToChoice.set(skipToken, { question: q, skip: true });
    buttons.push({ text: '✖ Skip', data: skipToken });

    let msg;
    try {
      msg = await tg.sendMessage({
        chatId: chatOf(topic.threadId),
        messageThreadId: threadOf(topic.threadId),
        text: lines.join('\n'),
        replyMarkup: TG.inlineKeyboard(buttons),
      });
    } catch (e) {
      // If we can't deliver some of the questions, the request as a whole
      // can't be interactively answered -- clean up what was already posted
      // and decline cleanly rather than leave half a prompt behind.
      console.error('[bridge] failed to post user-input prompt:', e.message);
      for (const posted of state.questions) {
        await tg.editMessageText({ chatId: chatOf(topic.threadId), messageId: posted.messageId, text: '⚠️ Not deliverable — question declined.', replyMarkup: { inline_keyboard: [] } }).catch(() => {});
        store.removePendingPermission(userInputStoreKey(params.requestId, posted.index));
      }
      return { action: 'decline', reason: `bridge: failed to deliver the question to Telegram (${e.message})` };
    }
    state.questions.push({ index: qi, key: q.question, messageId: msg.message_id, header: q.header || '' });
    // Reused pendingPermissions storage (see its comment): entries orphaned by
    // a restart get their buttons swept and cleared at next startup.
    store.addPendingPermission(userInputStoreKey(params.requestId, qi), { chatId: chatOf(topic.threadId), messageId: msg.message_id, threadId: topic.threadId, kind: 'userInput' });
  }

  // The turn is now blocked on this answer -- say so on the ⌛ placeholder.
  // Mirrored into progress_get's log on purpose: a turn waiting on the USER
  // otherwise looks exactly like a wedged one (aging last-activity), and a
  // caller reading '❓' as the last label knows the next move is theirs.
  const turn = activeTurns.get(params.sessionId);
  if (turn?.streamer) turn.streamer.update({ status: '❓ waiting for your answer above' });
  noteActivity(turn, '❓ waiting for your answer');

  return new Promise((resolve) => {
    state.resolve = resolve;
    state.timer = setTimeout(() => {
      finishUserInput(params.requestId, { action: 'decline', reason: 'auto-declined: no answer within timeout' }, (q) => '⏱ Expired — declined.');
    }, cfg.userInputTimeoutMs);
    pendingUserInputs.set(params.requestId, state);
  });
}

function userInputStoreKey(requestId, index) {
  return `${requestId}#q${index}`;
}

function finishUserInput(requestId, response, labelFor) {
  const pending = pendingUserInputs.get(requestId);
  if (!pending) return;
  pendingUserInputs.delete(requestId);
  clearTimeout(pending.timer);
  for (const token of pending.tokenToChoice.keys()) tokenToRequestId.delete(token);
  for (const q of pending.questions) store.removePendingPermission(userInputStoreKey(requestId, q.index));
  pending.resolve(response);
  for (const q of pending.questions) {
    const label = typeof labelFor === 'function' ? labelFor(q, pending.answers[q.key]) : labelFor;
    if (label != null) {
      tg.editMessageText({ chatId: pending.chatId, messageId: q.messageId, text: label, replyMarkup: { inline_keyboard: [] } }).catch((e) => console.error('[bridge] failed to finalize user-input message:', e.message));
    }
  }
}

// A button tap on a user-input question (routed from handleCallbackQuery).
function handleUserInputTap(requestId, token, choice) {
  const pending = pendingUserInputs.get(requestId);
  if (!pending) return null;
  if (choice.skip) {
    finishUserInput(requestId, { action: 'decline', reason: 'declined from Telegram' }, () => '✖ Declined by you.');
    return 'Declined';
  }
  pending.answers[choice.question.question] = choice.value;
  const qState = pending.questions.find((q) => q.key === choice.question.question);
  if (qState) {
    tg.editMessageText({ chatId: pending.chatId, messageId: qState.messageId, text: `✅ ${choice.label}`, replyMarkup: { inline_keyboard: [] } }).catch(() => {});
  }
  const unanswered = pending.questions.filter((q) => pending.answers[q.key] === undefined);
  if (!unanswered.length) {
    finishUserInput(requestId, { action: 'accept', content: { answers: pending.answers } }, (q) => `✅ ${pending.answers[q.key] ?? '—'}`);
    return 'Answered';
  }
  return `Recorded (${unanswered.length} left)`;
}

// --- permission relay: server asks, we answer (auto-approve by default) ---
// Registered on every backend (see wireBackend()): zcode's own
// interaction/requestPermission IS this shape already; Codex's approval
// requests are translated into it by bridge/backends/codexBackend.js. Same
// generic logic drives both -- this function doesn't know or care which
// backend's session is asking.
async function onPermissionRequest(params) {
  const topic = sessionToTopic.get(params.sessionId);

  if (cfg.autoApprovePermissions) {
    const response = pickAutoApproveOption(params.options);
    if (topic) {
      const reason = truncate(params.reason, 300);
      queueAutoApproveNotice(`🔓 auto-approved: ${params.toolName} (${params.riskLevel})${reason ? ` — ${reason}` : ''}`, topic.threadId);
    }
    return response;
  }

  if (!topic) {
    // Session we don't know about asked for permission (shouldn't happen in
    // practice) -- fail safe rather than hang the turn forever.
    return { decision: 'deny', reason: 'bridge: no Telegram topic mapped for this session' };
  }

  // MCP-only with AUTO_APPROVE_PERMISSIONS=false: an interactive prompt
  // genuinely needs the Telegram chat its buttons live in -- the one path
  // in this file with no MCP-only behavior. Refuse with a schema-valid deny
  // naming the way out, rather than post into the void.
  if (!telegramEnabled()) {
    return { decision: 'deny', reason: 'bridge: MCP-only mode has no Telegram chat to approve in -- run with AUTO_APPROVE_PERMISSIONS=true (the default) to auto-approve' };
  }

  const tokenMap = new Map();
  const buttons = params.options.map((opt) => {
    const token = 'p_' + randomBytes(6).toString('hex');
    tokenMap.set(token, opt.response);
    tokenToRequestId.set(token, params.requestId);
    return { text: opt.name, data: token };
  });

  // reason has no length limit in the protocol (bare Zod string, no
  // .max()); input already goes through the same truncate() below. Left
  // unbounded, a long reason can push this composed message over
  // Telegram's 4096-char cap, which throws *before* the pendingPermissions
  // entry or timeout timer are ever created -- silently killing the whole
  // interactive flow for that request with no Approve/Deny prompt ever
  // reaching the user.
  const inputPreview = safePreview(params.input);
  const reason = truncate(params.reason, 500);
  const text = [
    `🔐 Permission requested`,
    `Tool: ${params.toolName}  ·  risk: ${params.riskLevel}`,
    reason ? `Reason: ${reason}` : null,
    inputPreview ? `Input: ${inputPreview}` : null,
  ].filter(Boolean).join('\n');

  let msg;
  try {
    msg = await tg.sendMessage({
      chatId: chatOf(topic.threadId),
      messageThreadId: threadOf(topic.threadId),
      text,
      replyMarkup: TG.inlineKeyboard(buttons),
    });
  } catch (e) {
    // If posting the prompt itself fails (Telegram unreachable, bot removed
    // from the group, ...), fall through to the generic decline-via-error
    // path in ZcodeClient, which is NOT confirmed safe for this specific
    // method (unlike session/requestRuntimePreferences and
    // interaction/requestOfficialMcpAuthHeaders, which do have a confirmed
    // fallback). Return an explicit, schema-valid deny instead, matching
    // the !topic fail-safe above, so the failure mode is always "cleanly
    // denied" rather than "unverified effect on the in-flight turn."
    console.error('[bridge] failed to post permission prompt:', e.message);
    return { decision: 'deny', reason: `bridge: failed to deliver the permission prompt to Telegram (${e.message})` };
  }

  // Persisted so a request still awaiting a button press when the process
  // dies isn't left as an orphaned message with dead-but-still-clickable
  // buttons forever -- swept and cleaned up on the next startup, below.
  store.addPendingPermission(params.requestId, { chatId: chatOf(topic.threadId), messageId: msg.message_id, threadId: topic.threadId });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const denyOpt = params.options.find((o) => o.response?.decision === 'deny');
      finishPermission(params.requestId, denyOpt?.response ?? { decision: 'deny', reason: 'auto-denied: no response within timeout' }, '⏱ Expired — auto-denied (no response in time).');
    }, cfg.permissionTimeoutMs);

    pendingPermissions.set(params.requestId, {
      resolve,
      tokenMap,
      chatId: chatOf(topic.threadId),
      messageId: msg.message_id,
      timer,
    });
  });
}

function finishPermission(requestId, response, resultLabel) {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingPermissions.delete(requestId);
  for (const token of pending.tokenMap.keys()) tokenToRequestId.delete(token);
  store.removePendingPermission(requestId);
  pending.resolve(response);
  // Explicitly clearing reply_markup matters: Telegram's editMessageText
  // only touches the keyboard if you pass one -- omitting it (the previous
  // bug here) leaves the old buttons live and clickable indefinitely, even
  // after the request has already been resolved or has timed out.
  tg.editMessageText({ chatId: pending.chatId, messageId: pending.messageId, text: resultLabel, replyMarkup: { inline_keyboard: [] } }).catch((e) =>
    console.error('[bridge] failed to edit permission message:', e.message),
  );
}

// Sweep permission requests left dangling by a previous process instance
// (in-memory `pendingPermissions` above resets on every restart, but this
// disk-backed record survives it) -- clear their buttons and mark them
// expired rather than leaving them clickable forever with nothing listening
// on the other end anymore.
async function cleanupOrphanedPermissionRequests() {
  const orphans = store.getAllPendingPermissions();
  const requestIds = Object.keys(orphans);
  if (!requestIds.length) return;
  console.log(`[bridge] cleaning up ${requestIds.length} permission request(s) orphaned by a previous restart`);
  for (const requestId of requestIds) {
    const { chatId, messageId } = orphans[requestId];
    await tg
      .editMessageText({ chatId, messageId, text: '⚠️ Expired — bridge restarted before this was answered.', replyMarkup: { inline_keyboard: [] } })
      .catch((e) => console.error(`[bridge] failed to clean up orphaned permission request ${requestId}:`, e.message));
    store.removePendingPermission(requestId);
  }
}

function pickAutoApproveOption(options) {
  // Prefer a broad/persistent allow (avoids repeat prompts within the same
  // session) if the server offers one, then any plain allow, then anything
  // that isn't an explicit denial, then just the first option -- always
  // answer *something* valid rather than leave the turn hanging.
  const chosen =
    options.find((o) => o.response?.decision === 'allow' && o.response?.permissionUpdates?.length) ||
    options.find((o) => o.response?.decision === 'allow') ||
    options.find((o) => o.response?.decision !== 'deny') ||
    options[0];
  return chosen.response;
}

// Auto-approve notices are the traffic pattern most likely to burst --
// potentially one per tool call within a single turn, fired with no human
// pacing them, against Telegram's stricter documented group-wide cap
// ("bots are not able to send more than 20 messages per minute" in a
// group), which is shared across every topic in this one physical group.
// Serializing just this one class of (lowest-priority, audit-only) message
// with a minimum spacing doesn't make the bridge immune to the cap when
// combined with all its other traffic, but it keeps the audit trail itself
// from being the thing that trips it during a busy, unattended turn --
// precisely when auto-approve mode produces the most permission events and
// a human is least likely to be watching to notice a gap.
let autoApproveNoticeQueue = Promise.resolve();
function queueAutoApproveNotice(text, threadId) {
  // MCP-only: the audit notice has no chat to go to. The approval itself
  // already happened in onPermissionRequest -- only the 🔓 mirror is skipped.
  if (!telegramEnabled()) return;
  autoApproveNoticeQueue = autoApproveNoticeQueue
    .then(() => tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text }))
    .catch((e) => console.error('[bridge] failed to post auto-approve notice:', e.message))
    .then(() => sleep(1100));
}

// Codepoint-aware (not UTF-16-code-unit-aware): plain `.slice(0, n)` can
// split an astral character's surrogate pair in half, e.g. splitting an
// emoji right at the truncation boundary. Array.from iterates by codepoint.
function truncate(s, max) {
  if (!s) return s;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s;
}

function safePreview(input) {
  try {
    const s = JSON.stringify(input);
    if (!s) return null;
    return truncate(s, 300);
  } catch {
    return null;
  }
}

// --- session event routing: zcode -> Telegram ---
// Wired to EVERY backend (see wireBackend()): both zcode's own wire events
// and Codex's translated ones (bridge/backends/codexBackend.js) arrive here
// in the exact same shape (bridge/backend.js documents it) -- this function
// doesn't know or care which backend produced a given message.
function onBackendEvent(msg) {
  if (process.env.BRIDGE_DEBUG_EVENTS) {
    console.log(`[dbg] ${msg.method} kind=${msg.params?.kind ?? msg.params?.payload?.kind ?? '-'} session=${String(msg.params?.sessionId ?? '').slice(-8)} turn=${String(msg.params?.turnId ?? '').slice(-8)}`);
  }
  const sessionId = msg.params?.sessionId;
  if (!sessionId) return;
  const turn = activeTurns.get(sessionId);

  // activeTurns is keyed by sessionId, and a topic's next turn can start
  // (new activeTurns entry, same sessionId key) essentially the instant
  // finalizeTurn() clears the previous one -- both are driven by
  // independent async I/O (Telegram's poll loop vs. zcode's stdout stream)
  // with nothing else serializing them. A straggling event for the turn
  // that JUST finished (protocol delivery/ordering across these event
  // "kinds" isn't documented as strict) could otherwise bleed into the
  // next turn's buffer. Both session/event and v4/telemetry/event carry
  // turnId at the top level of params; correlate on it once we've learned
  // it from that turn's own turn.started event, and ignore anything that
  // doesn't match.
  if (turn && msg.params.turnId) {
    const isTurnStart = msg.method === 'v4/telemetry/event' && msg.params.kind === 'turn.started';
    if (!turn.turnId) {
      if (isTurnStart) turn.turnId = msg.params.turnId;
      // else: haven't seen turn.started for THIS turn yet -- can't yet tell
      // a genuine early event of this turn from a last straggler of the one
      // we just superseded. Narrow residual race, not fully closed; the
      // common case (turn.started arrives before any content) is handled.
    } else if (turn.turnId !== msg.params.turnId) {
      return; // confirmed straggler from a different turn -- ignore
    }
  }

  if (msg.method === 'session/event') {
    const payload = msg.params.payload;
    if (!turn) {
      // Background-task lifecycle snapshots carry {taskId, status} with no
      // `kind` discriminator, and keep arriving after the turn that started
      // the task has ended. A task reaching a terminal status while the
      // session is idle is the one thing worth acting on here: post the 🌀
      // notice; the notification turn the runtime auto-starts next is picked
      // up by adoptUnclaimedTurn below.
      if (payload?.taskId && payload.status) noteTaskLifecycle(sessionId, payload);
      if (payload?.taskId && payload.status && payload.status !== 'running') void handleBackgroundTaskFinished(sessionId, payload);
      return;
    }

    // Blocking-wait tracking for the circuit breaker: set when the turn's
    // current tool is TaskOutput(block=true), cleared on any other event
    // kind (a new tool starting, text resuming, or the wait returning).
    if (payload?.kind === 'tool_call' && /taskoutput/i.test(payload.toolName || '') && payload.input?.block !== false) {
      turn.blockSince = turn.blockSince ?? Date.now();
    } else if (payload?.kind === 'result' || payload?.kind === 'text_delta' || (payload?.kind === 'tool_call' && !/taskoutput/i.test(payload.toolName || ''))) {
      turn.blockSince = null;
    }

    if (turn.progress) {
      // Milestone mode (STREAM_PROGRESS=messages, branch experiment
      // 2026-09-02): narration blocks become per-milestone messages, tool
      // calls become the steps listed inside them -- see bridge/progress.js.
      // textBuffer still accumulates for the final-text fallback below.
      // noteActivity mirrors each of these into progress_get's activity log
      // at the same instant the Telegram view is fed, so the two views of a
      // turn cannot disagree.
      if (payload?.kind === 'text_delta' && typeof payload.delta === 'string') {
        turn.textBuffer += payload.delta;
        turn.progress.narration(payload.delta);
        noteActivity(turn, '💭 narration');
      } else if (payload?.kind === 'tool_call') {
        if (payload.toolCallId) turn.toolNames.set(payload.toolCallId, payload.toolName);
        turn.progress.toolCall(payload);
        // Same label construction the milestone step line renders (tool +
        // the model's own description, stepDetail's 80-char budget) -- the
        // caller sees what the topic shows, minus all reply text.
        const detail = stepDetail(payload.toolName, payload.input);
        noteActivity(turn, `🔧 ${payload.toolName}${detail ? ` · ${detail}` : ''}`, { toolCallId: payload.toolCallId });
      } else if (payload?.kind === 'result') {
        turn.progress.toolResult(payload);
        noteActivity(turn, `🔧 ${payload.toolName ?? 'tool'}`, { toolCallId: payload.toolCallId, done: true });
      }
    } else if (payload?.kind === 'text_delta' && typeof payload.delta === 'string') {
      turn.textBuffer += payload.delta;
      turn.streamer?.update({ text: turn.textBuffer, status: null });
      noteActivity(turn, '💭 narration');
    } else if (payload?.kind === 'reasoning_delta') {
      turn.streamer?.update({ status: '💭' });
      noteActivity(turn, '💭');
    } else if ((payload?.kind === 'started' || payload?.kind === 'scheduled' || payload?.kind === 'tool_input_start') && payload.toolName) {
      if (payload.toolCallId) turn.toolNames.set(payload.toolCallId, payload.toolName);
      turn.streamer?.update({ status: `🔧 ${payload.toolName}` });
      noteActivity(turn, `🔧 ${payload.toolName}`, { toolCallId: payload.toolCallId });
    } else if (payload?.kind === 'result') {
      // result payloads carry toolCallId but not toolName; look up the name
      // learned at started/scheduled time.
      const name = payload.toolName ?? (payload.toolCallId && turn.toolNames.get(payload.toolCallId)) ?? 'tool';
      turn.streamer?.update({ status: `🔧 ${name} ✓` });
      noteActivity(turn, `🔧 ${name}`, { toolCallId: payload.toolCallId, done: true });
    } else if (payload?.taskId && payload.status) {
      noteTaskLifecycle(sessionId, payload);
      // Task finished while THIS turn is still running: the notification is
      // injected into the model's next request anyway; a status hint on the
      // placeholder is enough.
      turn.streamer?.update({ status: `🌀 task ${payload.status}` });
      noteActivity(turn, `🌀 task ${payload.status}`);
    }

    if (typeof payload?.response === 'string' && payload.usage) {
      // Turn-level final event ({response, tokenCount, usage, toolCallCount,
      // duration, resultType} -- verified live): authoritative full-turn text
      // plus the cumulative usage the footer renders from.
      turn.finalText = payload.response;
      turn.usageSummary = payload.usage;
    } else if (typeof payload?.content === 'string' && payload.content) {
      // Last assistant message's text. The guard matters: a model request
      // that ends in tool calls also emits {content: ""} -- an empty string
      // is NOT nullish and used to blank the reply by overriding the
      // accumulated delta buffer at finalize time.
      turn.finalText = payload.content;
    } else if (payload?.error) {
      turn.error = payload.error;
    }
    return;
  }

  if (msg.method === 'v4/telemetry/event') {
    const kind = msg.params.kind;
    // The runtime auto-starts turns the bridge never sent (verified live:
    // a completed background task injects a <task-notification> input and
    // runs a fresh turn seconds after the previous one ended). Without
    // adoption those turns' events hit the `if (!turn) return` paths and
    // their entire reply is generated, persisted... and never delivered.
    if (kind === 'turn.started' && !turn && !busySessions.has(sessionId) && sessionToTopic.has(sessionId)) {
      void adoptUnclaimedTurn(sessionId, msg.params);
      return;
    }
    // Per-model-request usage, used by the footer as a fallback: the
    // turn-final session event ({response, usage}) is the nicer source but
    // arrives on a different event channel whose ordering vs turn.terminal
    // is NOT guaranteed -- observed live both ways. usage.delta reliably
    // precedes terminal, so accumulating it per requestId covers the case
    // where the response event lands after finalize has already run.
    if (kind === 'usage.delta' && turn && msg.params.requestId) {
      if (!turn.requestUsage) turn.requestUsage = new Map();
      turn.requestUsage.set(msg.params.requestId, { inputTokens: msg.params.inputTokens, outputTokens: msg.params.outputTokens });
      return;
    }
    if (kind === 'turn.terminal') {
      // Straggler guard: a terminal for a turn that never saw ITS turnId
      // started (turn.turnId unset), when that turn began after a recent
      // interrupt of the same session, is the INTERRUPTED turn's death
      // rattle -- finalizing on it would kill the brand-new turn (seen
      // live: the post-breaker follow-up reply never arrived).
      const interruptedAt = lastInterruptedAt.get(sessionId) ?? 0;
      if (turn && !turn.turnId && turn.startedAt > interruptedAt && Date.now() - interruptedAt < 30_000) {
        console.log(`[bridge] ignoring terminal straggler from the interrupted turn on session ${sessionId}`);
        return;
      }
      void finalizeTurn(sessionId, msg.params);
    }
  }
}

async function adoptUnclaimedTurn(sessionId, params) {
  const topic = sessionToTopic.get(sessionId);
  if (!topic) return;
  busySessions.add(sessionId);
  // Registered before the placeholder send so early events of this turn have
  // something to land on; placeholderMessageId fills in once posted.
  const entry = { placeholderMessageId: null, textBuffer: '', startedAt: Date.now(), turnId: params.turnId, toolNames: new Map(), adopted: true };
  activeTurns.set(sessionId, entry);
  // MCP-only: no chat to post the 🌀 placeholder into -- but the turn MUST
  // stay tracked (unlike the send-failure drop below), or its reply would be
  // generated and then silently lost with no activeTurns entry to deliver
  // it through. finalizeTurn notes it into the MCP reply log either way.
  if (!telegramEnabled()) {
    console.log(`[bridge] adopted auto-started turn ${params.turnId} on session ${sessionId} (MCP-only: no placeholder to post)`);
    return;
  }
  let msg;
  try {
    // Fixed: was chatOf(threadId), a bare undefined module-global -- see the
    // identical fix + explanation in onUserInputRequest above.
    msg = await tg.sendMessage({ chatId: chatOf(topic.threadId), messageThreadId: threadOf(topic.threadId), text: '⌛ 🌀 …' });
  } catch (e) {
    console.error(`[bridge] failed to post placeholder for auto-started turn ${params.turnId}; dropping it:`, e.message);
    activeTurns.delete(sessionId);
    busySessions.delete(sessionId);
    return;
  }
  entry.placeholderMessageId = msg.message_id;
  attachTurnView(entry, { placeholderMessageId: msg.message_id, threadId: topic.threadId });
  updateTopicStatus(topic.threadId, 'busy').catch(() => {});
  console.log(`[bridge] adopted auto-started turn ${params.turnId} on session ${sessionId}`);
}

async function handleBackgroundTaskFinished(sessionId, payload) {
  // MCP-only: the 🌀 notice has no chat to go to. The runtime's own
  // task-notification turn still runs and lands in the MCP reply log (see
  // adoptUnclaimedTurn).
  if (!telegramEnabled()) return;
  const topic = sessionToTopic.get(sessionId);
  if (!topic) return;
  const label = truncate(payload.description || payload.command || payload.taskId, 120);
  const icon = payload.status === 'completed' ? '✅' : '⚠️';
  await tg
    .sendMessage({ chatId: chatOf(topic.threadId), messageThreadId: threadOf(topic.threadId), text: `🌀 Background task ${icon} ${label} — ${payload.status}` })
    .catch((e) => console.error('[bridge] failed to post background-task notice:', e.message));
}

async function finalizeTurn(sessionId, terminalParams) {
  // activeTurns loses its entry for this turn a few lines below, before the
  // delivery awaits underneath ever start -- so shutdown()'s drain wait
  // can't use activeTurns.size alone to know a turn is truly done.
  // pendingFinalize covers the gap: incremented here, decremented in the
  // finally at the very bottom, after delivery (or its failure) is settled.
  pendingFinalize++;
  try {
    const turn = activeTurns.get(sessionId);
    activeTurns.delete(sessionId);
    busySessions.delete(sessionId);
    const topic = sessionToTopic.get(sessionId);
    if (turn) {
      turn.streamer?.stop();
      // Milestone mode: freeze the last milestone message; settle() says
      // which message the final reply may REPLACE (the degenerate tool-less
      // single-placeholder case) -- otherwise the reply goes out as its own
      // message after the milestone trail.
      const replaceId = turn.progress ? await turn.progress.settle() : turn.placeholderMessageId;
      let text;
      if (terminalParams.status === 'success') {
        text = turn.finalText ?? turn.textBuffer ?? '';
      } else {
        const err = turn.error;
        text = `⚠️ Turn failed: ${terminalParams.errorCode || 'unknown_error'}${err?.message ? `\n${err.message}` : ''}`;
      }
      if (turn.adopted && !text.trim()) {
        // Auto-started notification turns sometimes produce no user-facing
        // text; a quiet label beats spamming "(no reply text)".
        const quietId = replaceId ?? turnLiveMessageId(turn);
        if (quietId) {
          // Fixed: was chatOf(threadId), a bare undefined module-global --
          // see the identical fix in onUserInputRequest above.
          await tg
            .editMessageText({ chatId: chatOf(topic?.threadId), messageId: quietId, text: '🌀 Background task notification processed.' })
            .catch(() => {});
        }
      } else {
        const footer = terminalParams.status === 'success' ? usageFooter(turn, terminalParams) : '';
        const replyText = text.trim() ? text : '(no reply text)';
        if (mcp && topic) mcp.noteReply(topic.threadId, replyText);
        await deliverReply(replaceId, topic?.threadId, replyText, footer);
      }
    }
    if (topic) {
      // Skip the idle write when a queued message immediately re-busies the
      // topic (drainQueue -> startTurn writes "busy") -- two racing edits of
      // the same status message can land out of order.
      if (!store.getQueue(topic.threadId).length) updateTopicStatus(topic.threadId, 'idle').catch(() => {});
    }
    // Whatever the user queued behind this turn runs now -- success, failure,
    // and the "!turn" early-return case all lead here for one reason: the
    // session is no longer busy, and the queue's whole contract is "runs when
    // the current message finishes". A no-op while draining (see drainQueue).
    if (topic) void drainQueue(topic.threadId);
  } finally {
    pendingFinalize--;
  }
}

// Cost/steps footer appended to the delivered reply (agreed tier-1 item).
// Sources, in preference order: the turn-final session event's cumulative
// usage (verified live: {inputTokens, outputTokens, totalTokens, ...}), the
// sum of per-request usage.delta telemetry (same numbers, ordering-proof),
// and turn.terminal's durationMs/tokenCount/toolCallCount. No dollar figure
// exists anywhere in the protocol -- the plan is credit-based, /usage has
// the quota view.
function usageFooter(turn, terminal) {
  const u = turn.usageSummary ?? aggregateRequestUsage(turn.requestUsage);
  const parts = [];
  if (terminal?.durationMs != null) parts.push(`⏱ ${fmtDuration(terminal.durationMs)}`);
  if (u && (u.inputTokens != null || u.outputTokens != null)) {
    const total = terminal?.tokenCount ?? u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    parts.push(`${abbrev(total)} tok · ${abbrev(u.inputTokens)} in / ${abbrev(u.outputTokens)} out`);
  } else if (terminal?.tokenCount != null) {
    parts.push(`${abbrev(terminal.tokenCount)} tok`);
  }
  if (terminal?.toolCallCount) parts.push(`${terminal.toolCallCount} tool call${terminal.toolCallCount === 1 ? '' : 's'}`);
  return parts.length ? `\n\n<i>${parts.join(' · ')}</i>` : '';
}

function aggregateRequestUsage(map) {
  if (!map || !map.size) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const v of map.values()) {
    inputTokens += v.inputTokens ?? 0;
    outputTokens += v.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

function abbrev(n) {
  if (n == null) return '?';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

// Render the model's markdown as Telegram HTML, put the first chunk into the
// turn's placeholder, and follow with additional messages if it didn't fit.
// A Telegram entity-parse failure (a renderer bug we didn't foresee) falls
// back to tag-stripped plain text for that chunk: delivered unformatted beats
// not delivered. A null placeholderMessageId (adopted turns whose placeholder
// could not be posted) sends the first chunk as a fresh message instead.
// Any `[file: path]` markers in the text (the model's way of attaching a
// file -- the protocol has no native mechanism) are stripped here and sent
// as documents after the text, workspace-restricted like /file.
async function deliverReply(placeholderMessageId, threadId, text, footerHtml = '') {
  // MCP-only: finalizeTurn has already noted the reply into the MCP reply
  // log (replies_get / a parked message_send waiter) -- the Telegram edit-
  // and-send below is the chat mirror, and there is no chat.
  if (!telegramEnabled()) return;
  const { paths, cleaned } = extractFileMarkers(text);
  const chunks = renderReply(cleaned);
  if (!chunks.length || !chunks[0]) {
    chunks.length = 0;
    chunks.push(paths.length ? '(files attached below)' : '(no reply text)');
  }
  if (footerHtml) chunks[chunks.length - 1] += footerHtml;
  try {
    if (placeholderMessageId) {
      await tg.editMessageText({ chatId: chatOf(threadId), messageId: placeholderMessageId, text: chunks[0], parseMode: 'HTML' });
    } else {
      await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: chunks[0], parseMode: 'HTML' });
    }
  } catch (e) {
    await sendChunkFallback(placeholderMessageId ? 'edit' : 'send', placeholderMessageId, threadId, chunks[0], e);
  }
  for (let i = 1; i < chunks.length; i++) {
    await sleep(350);
    try {
      await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: chunks[i], parseMode: 'HTML' });
    } catch (e) {
      await sendChunkFallback('send', null, threadId, chunks[i], e);
    }
  }
  // Cap the blast radius of a model bug that marker-spams its reply.
  for (const p of paths.slice(0, 5)) {
    if (!threadId) break;
    try {
      await sendWorkspaceFile(threadId, p, { source: 'model' });
    } catch (e) {
      // Marker send failures stay out of the chat (the text already said
      // what the model intended); they're visible server-side.
      console.error(`[bridge] [file:] marker send failed for ${p}:`, e.message);
    }
    await sleep(350);
  }
}

async function sendChunkFallback(method, messageId, threadId, chunk, originalError) {
  const isParseError = /parse entities|can't parse/i.test(originalError.message || '');
  if (!isParseError) {
    console.error(`[bridge] failed to deliver reply chunk (${method}):`, originalError.message);
    return;
  }
  console.error('[bridge] Telegram rejected rendered HTML, falling back to plain text:', originalError.message);
  const plain = truncate(toPlainText(chunk), 4000);
  try {
    if (method === 'edit') await tg.editMessageText({ chatId: chatOf(threadId), messageId, text: plain });
    else await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: plain });
  } catch (e) {
    console.error('[bridge] plain-text fallback also failed:', e.message);
  }
}

// Force-clears any turn that's been open longer than cfg.turnTimeoutMs with
// no turn.terminal ever seen. DISABLED BY DEFAULT (turnTimeoutMs=0, owner
// decision 2026-09-01): real agentic turns here regularly exceed 20 minutes,
// and the cap killed a correct one mid-work; /stop below is the designated
// escape hatch for a genuinely wedged topic. Set TURN_TIMEOUT_MS to re-arm.
//
// IMPORTANT: this must call session/stop before clearing local state, not
// just wipe bookkeeping and walk away. Found the hard way: a turn that's
// merely SLOW (not actually hung -- e.g. a long agentic task doing real
// work) keeps running server-side even after the bridge stops tracking it.
// If it later completes, its events arrive with no `activeTurns` entry to
// attach to (the session/event handler's `if (!turn) return` silently
// drops them, including the final content), so the real, successful answer
// is generated and persisted in zcode's own history but never reaches
// Telegram -- exactly the "task performed well but didn't report" failure
// mode this was built to prevent, just relocated one level deeper. Calling
// session/stop here makes a watchdog timeout behave like /stop: the turn
// actually ends, instead of continuing to run unobserved.
setInterval(async () => {
  // Circuit breaker for blocking TaskOutput camps (owner ask 2026-09-06:
  // 'ensure such behavior will be fixed in full' after the third live
  // occurrence). Old-context sessions never read the guidance, and even a
  // hard /stop needs a human to notice first. This ends the TURN after
  // TASK_BLOCK_LIMIT_MS of a continuously blocking TaskOutput; background
  // tasks deliberately keep running -- their completion notifications are
  // the mechanism the model should have used instead of blocking.
  if (cfg.taskBlockLimitMs > 0) {
    for (const [sessionId, turn] of activeTurns) {
      if (!turn.blockSince || Date.now() - turn.blockSince < cfg.taskBlockLimitMs) continue;
      const mins = Math.round((Date.now() - turn.blockSince) / 60000);
      console.log(`[bridge] circuit breaker: session ${sessionId} blocked on TaskOutput for ${mins}m -- interrupting the turn (background tasks keep running)`);
      turn.blockSince = null;
      const topic = sessionToTopic.get(sessionId);
      await interruptTurn(sessionId, { killEverything: false }).catch(() => {});
      if (topic) {
        // Bookkeeping mirrors /stop: clear busy, label the live message,
        // drain the queue.
        busySessions.delete(sessionId);
        activeTurns.delete(sessionId);
        turn.streamer?.stop();
        turn.progress?.stop();
        updateTopicStatus(topic.threadId, 'idle').catch(() => {});
        // The breaker itself is transport-independent and still runs; only
        // the chat label is Telegram's to show.
        if (telegramEnabled()) {
          const liveId = turnLiveMessageId(turn);
          const text = `⚠️ Auto-interrupted after ${mins} min blocked on TaskOutput. Background tasks were NOT cancelled -- they keep running and will notify on completion; send a message to continue.`;
          if (liveId) {
            await tg.editMessageText({ chatId: chatOf(topic.threadId), messageId: liveId, text }).catch(() => {});
          } else {
            await tg.sendMessage({ chatId: chatOf(topic.threadId), messageThreadId: threadOf(topic.threadId), text }).catch(() => {});
          }
        }
        void drainQueue(topic.threadId);
      }
    }
  }
  if (!cfg.turnTimeoutMs) return; // default: watchdog off, /stop is the hatch
  const now = Date.now();
  for (const [sessionId, turn] of activeTurns) {
    if (now - turn.startedAt <= cfg.turnTimeoutMs) continue;
    console.error(`[bridge] turn on session ${sessionId} exceeded ${cfg.turnTimeoutMs}ms with no turn.terminal event -- stopping it and force-clearing`);
    turn.streamer?.stop();
    turn.progress?.stop();
    backendForSession(sessionId)
      .cancel(sessionId)
      .catch((e) => console.error(`[bridge] cancel on watchdog timeout failed for ${sessionId} (state is cleared locally regardless):`, e.message));
    activeTurns.delete(sessionId);
    busySessions.delete(sessionId);
    const topic = sessionToTopic.get(sessionId);
    if (telegramEnabled()) {
      tg
        .editMessageText({
          // Fixed: was chatOf(threadId), a bare undefined module-global -- see
          // the identical fix in onUserInputRequest above.
          chatId: chatOf(topic?.threadId),
          messageId: turn.placeholderMessageId,
          text: '⚠️ No response after a long time — the turn has been stopped. Send another message to try again (or /stop next time to cancel earlier).',
        })
        .catch((e) => console.error('[bridge] failed to edit watchdog-timeout notice:', e.message))
        .finally(() => topic && drainQueue(topic.threadId));
    } else {
      if (topic) void drainQueue(topic.threadId);
    }
  }
}, 60_000);

// --- get-or-create the session for a Telegram topic, on whichever backend
// the topic is configured for ---
// The zcode-specific "cold process has an empty model catalog, so a plain
// resume takes zcode's deferred-model-adapter path and every send after it
// rejects with ZCODE_RUNTIME_MODEL_UNAVAILABLE" fix (README's "Restart
// continuity" section) now lives entirely inside
// bridge/backends/zcodeBackend.js's resumeConversation() -- this function
// doesn't know that bug exists, the same way it doesn't know anything else
// backend-specific. See that file for the two costly-to-discover traps
// recorded there.
//
// Returns { sessionId, resumed }. `resumed: true` means this call reloaded
// a session that already existed before this process started (as opposed
// to creating a brand new one) -- see the caller in startTurn for why that
// distinction matters despite resumeConversation itself having succeeded.
async function getOrCreateSession(threadId, { forceFresh = false } = {}) {
  // A CLOSED entry is a finished conversation -- MCP session_close marked it,
  // and in proxied mode so does the relay-synthesized forum_topic_deleted
  // handler below (relay-owned-group design section 4: after a /rebind moves
  // the topic away and it later comes BACK to this agent, the next message
  // must start a FRESH session, not resume the closed one -- the closed
  // session's upstream thread may not even exist anymore, and resuming would
  // silently append a new conversation onto a session messageSend already
  // refuses). Read off the store regardless of forceFresh, because a fresh
  // session written over a closed entry must lift that mark: setTopic MERGES,
  // so merely creating would leave closed:true stamped on the new session and
  // messageSend would refuse a conversation that is demonstrably live again.
  // The mark is cleared only by the successful creation write, so if
  // session/create throws the topic stays closed and refuses, as it should.
  // Applies in legacy mode too (there `closed` only ever comes from MCP
  // session_close, whose topic Telegram itself has closed -- a message
  // arriving after a reopen is a new conversation all the same).
  const wasClosed = !!store.getTopic(threadId)?.closed;
  let entry = forceFresh ? null : store.getTopic(threadId);
  let resumed = false;
  if (entry?.closed) {
    console.log(`[bridge] topic ${threadId}: previous session was closed -- starting a fresh session for the new conversation`);
    // Strip ONLY the session: the topic's own identity (backend, model, mode)
    // survives into the fresh session, exactly as a /model fresh-switch keeps
    // it. The `!entry.sessionId` stub branch below then routes this to the
    // ordinary creation path.
    entry = { ...entry, sessionId: undefined };
  }

  // Migration for a store entry written before this backend refactor: its
  // sessionId is a bare zcode id with no "backend:" prefix. Treat it as
  // zcode's (the only backend that ever existed before now) and persist the
  // canonical prefixed form so this check is a one-time cost per topic.
  if (entry?.sessionId && !backendNameOf(entry.sessionId)) {
    entry = { ...entry, sessionId: makeSessionId('zcode', entry.sessionId), backend: entry.backend || 'zcode' };
    store.setTopic(threadId, entry);
  }

  const backendName = entry?.backend || cfg.defaultBackend;
  const backend = getBackend(backendName);
  const workspaceKey = `tg-topic-${threadId}`;

  if (entry?.sessionId && !subscribedSessions.has(entry.sessionId)) {
    // Every bridge start spawns a brand-new backend subprocess -- there is
    // no reconnection to a lingering daemon (true of zcode always, and of
    // Codex too: each restart gets a fresh `codex app-server`). That fresh
    // process's live session/thread registry is empty; a session persisted
    // from a *previous* process is unknown to it until reloaded.
    // resumeConversation is exactly the mechanism for that reload. Without
    // it, zcode's session/subscribe and session/send reject a pre-existing
    // topic's session with -32004 "Session is not active" -- forever, on
    // every single restart, since store.js keeps returning the same
    // now-permanently-dead sessionId on every future message.
    try {
      await backend.resumeConversation(entry.sessionId, { workspaceDir: cfg.workspaceDir, workspaceKey, model: entry.model });
      resumed = true;
    } catch (e) {
      // Session/thread is genuinely gone upstream (or this backend can't
      // resume at all) -- start fresh rather than have this topic loop on
      // the same error on every future message forever. History is lost;
      // said so below.
      console.error(`[bridge] topic ${threadId}: resume failed for ${entry.sessionId}, starting a fresh session (history lost):`, e.message);
      entry = null;
    }
  } else if (entry && !entry.sessionId) {
    // A topic-only stub (forum_topic_created, or MCP's session_create,
    // seeds a store record -- chatId/name/backend/mode -- before any
    // session exists yet) -- nothing to resume; fall through to creation.
    entry = null;
  }

  if (!entry) {
    // /model, /mode or /backend issued before the session existed is
    // honored here (store.getTopic re-read: forum_topic_created seeds a
    // topic-only record with no sessionId well before this ever runs).
    const stored = store.getTopic(threadId);
    // NOT a bare `... || cfg.defaultModel` on the end: that fallback is
    // zcode's own default model string ('zai/glm-5.3-flash') and forcing it
    // onto a Codex thread/start call is a real bug this refactor almost
    // shipped (caught live: Codex's own API rejected it outright -- "not
    // supported when using Codex with a ChatGPT account"). defaultModelFor()
    // picks the right per-backend default instead (see its definition above).
    const model = stored?.model || defaultModelFor(backendName);
    const mode = stored?.mode || cfg.defaultSessionMode;
    const created = await backend.createConversation({ workspaceDir: cfg.workspaceDir, workspaceKey, model, mode });
    entry = { sessionId: created.sessionId, model: created.model ?? model, mode: created.mode ?? mode, backend: backendName };
    // See wasClosed above: the explicit false is the point -- a plain entry
    // merge would leave the old closed:true in place underneath it.
    store.setTopic(threadId, wasClosed ? { ...entry, closed: false } : entry);
    console.log(`[bridge] topic ${threadId}: created ${backendName} session ${created.sessionId} (${entry.model}${entry.mode ? `, mode=${entry.mode}` : ''})`);
  }

  sessionToTopic.set(entry.sessionId, { threadId });
  if (!subscribedSessions.has(entry.sessionId)) {
    await backend.subscribe(entry.sessionId);
    subscribedSessions.add(entry.sessionId);
  }
  return { sessionId: entry.sessionId, resumed };
}

// --- per-topic pinned status message (agreed tier-2 item, reshaped
// 2026-09-01 per owner feedback) ---
// One message per topic showing model · mode · busy/idle · queue depth.
// Placement: created at TOPIC CREATION (the earliest message a topic can
// have) so it never occupies conversational space near the latest messages,
// then edited in place for the topic's lifetime. Pinned when the bot has
// admin pin rights; until then, pinning is retried quietly on every state
// change, so it activates the moment rights are granted.
//   - message deleted by someone -> stop tracking (don't resurrect it at the
//     bottom of the chat; that's the failure mode this reshape fixed).
//   - message older than Telegram's 48h bot-edit window -> replaced (old
//     deleted, new posted + pinned + id re-stored) so exactly one exists.
// The machine itself (map, send/edit/pin, recreate, and the per-topic
// serialization that keeps racing callers -- topic creation, the turn's
// busy/idle, the queue refresh -- from posting a second pinned line) lives
// in bridge/topicStatus.js; this side only decides WHAT the line says and
// WHEN to refresh it.
const topicStatus = createTopicStatusTracker({
  tg,
  // Dereferenced at call time: chatOf/threadOf are defined further down,
  // and these only run once the bridge is up and handling updates.
  chatOf: (key) => chatOf(key),
  threadOf: (key) => threadOf(key),
  persist: (key, messageId) => store.setTopic(key, { statusMessageId: messageId }),
});

// The quota endpoint's last-known response, shared by the status line's
// percentages AND the MCP usage_get tool a supervisor model may poll before
// delegating each task. ONE cache rather than one per consumer: this
// endpoint is the account's rate-limit-sensitive monitor (observed to 429
// under load), and a second independent fetch path would double the outbound
// rate exactly when the account is busiest.
//
// The POLICY lives in createUsageCache (usage.js) -- explicit asks (usage_get,
// /usage) refresh once the cache is older than a 30s floor and await their own
// refresh, the status line keeps the 5-minute cache fire-and-forget, and a
// failed refresh backs explicit asks off for 60s and serves the cached figure
// with its age -- because index.js exports nothing and that policy is
// unit-tested there against an injected clock and a counting fetch.
//
// The key read is INSIDE the fetch, never evaluated as a bare argument:
// readZaiApiKey() throws synchronously when the file is missing, and a
// codex- or mock-DEFAULT deployment (this cache is built regardless of
// cfg.defaultBackend) has no reason to have that file at all. It used to
// crash such a bridge straight out of main() before the MCP socket ever
// bound (found live, test/e2e-codex-bug3-smoke.mjs); inside the promise
// chain it is classified instead (ZAI_UNCONFIGURED -- permanent: remembered,
// logged once, never retried).
const zaiUsageCache = createUsageCache({
  // explicit asks pass their 30s floor at the explicitAsk() call sites (see
  // usageGetForMcp) -- the floor is a property of the ASK, not of this cache,
  // whose own TTL is the status line's 5 minutes.
  fetch: () => fetchUsage({ apiKey: readZaiApiKey(cfg.zaiConfigPath) }),
  isUnconfigured: (e) => e?.code === 'ZAI_UNCONFIGURED',
  onUnconfigured: (e) => console.error(`[bridge] usage fetch skipped (no zcode credential configured -- expected on a non-zcode-default deployment): ${e.message}`),
  onFailure: (e) => console.error(`[bridge] usage refresh failed (figures will lag or be omitted): ${e.message}`),
});

// The cache the status line renders from: the SAME source selection
// usage_get uses (usageGetForMcp's branch on cfg.defaultBackend), on the
// HEARTBEAT path -- whatever is cached RIGHT NOW, refreshes fired
// fire-and-forget below, never explicitAsk, never awaited: a status write
// fires on every turn start/end across every topic and must never stall
// one on a call to an endpoint that can itself hang or 429. Mock &c keep
// the z.ai cache (its unconfigured classification expects exactly that).
function statusUsageCache() {
  return cfg.defaultBackend === 'codex' ? codexUsageCache : zaiUsageCache;
}

function refreshUsagePercentages() {
  statusUsageCache().heartbeat(); // fire-and-forget: this call alone is what keeps the selected cache warm
}

function statusUsageText() {
  const { shortPct, weekPct } = statusPercentages(cfg.defaultBackend, {
    zaiData: zaiUsageCache.data,
    codexData: codexUsageCache.data,
  });
  const seg = [];
  if (shortPct != null) seg.push(`${shortPct}% session`);
  if (weekPct != null) seg.push(`${weekPct}% week`);
  return seg.length ? seg.join(' / ') : null;
}

// --- the codex side of usage_get (owner decision, 2026-09-22) ---
//
// usage_get reports the quota of THIS BRIDGE's own default backend; on a
// codex-default bridge that is the codex account's rate limits, read over
// the `codex app-server` connection the bridge already holds -- no new
// external endpoint, no new configuration knob (see usageGetForMcp for the
// branch). SAME cache policy as the z.ai cache (createUsageCache, usage.js):
// one shared in-flight fetch, a second caller joins rather than stampedes --
// with the floors that fit a LOCAL RPC: floorMs 0, so every explicit ask may
// refresh (a local round trip cannot 429), and the 60s failure backoff,
// which is what bounds the cost of asking while the app-server is dead --
// getBackend lazily starts it, and a dead one is re-attempted at most once
// per backoff, never once per ask.
const codexUsageCache = createUsageCache({
  fetch: () => getBackend('codex').readAccountRateLimits(), // getBackend lazily starts the app-server if eager boot didn't
});

async function codexUsageGetForMcp() {
  let result;
  try {
    result = await codexUsageCache.explicitAsk(0);
  } catch (e) {
    throw codexUsageFetchError(e);
  }
  const snap = codexUsageSnapshotOrThrow(result.data, codexUsageCache.dataAt);
  if (result.stale) snap.stale = result.stale;
  return snap;
}

// usageGetForMcp is the usage_get tool's handler.
//
// ROUTING, owner decision 2026-09-22: it reports the quota of THIS BRIDGE's
// own backend, and cfg.defaultBackend is the signal the bridge already uses
// to decide which backend a brand-new session gets -- the same identity,
// no new knob. zcode-default keeps the z.ai path below byte for byte;
// codex-default reads codex's account rate limits (codexUsageGetForMcp
// above); anything else (mock) has no quota and says so. A caller should
// not have to know which bridge it is talking to -- but neither should it
// ever be handed a figure from an account the bridge isn't running on.
//
// AN EXPLICIT ASK REFRESHES ONCE THE CACHE IS OLDER THAN THE 30s FLOOR, AND
// AWAITS ITS OWN REFRESH (owner decision, half 2, 2026-09-22): twice a
// minute apart must show movement, so the old warm path -- answer stale
// immediately, refresh behind the answer -- is gone. A failed refresh with
// a cached figure degrades to cached + `stale: {ageMs, reason}` rather than
// an error; with nothing cached it throws as before. A COLD CACHE STILL
// AWAITS ONE FETCH RATHER THAN ERRORING: the gateway already lets
// message_send block for up to ten minutes, so blocking for the ~10s
// fetchUsage's own timeout allows, on the FIRST call this bridge has ever
// made, is a real answer rather than a degradation.
async function usageGetForMcp() {
  if (cfg.defaultBackend === 'codex') return codexUsageGetForMcp();
  if (cfg.defaultBackend !== 'zcode') {
    throw new Error(
      `usage_get reports this bridge's own backend's quota, and the default backend here is '${cfg.defaultBackend}', ` +
      'which has no quota to report. Retrying will not change this.');
  }
  let result;
  try {
    result = await zaiUsageCache.explicitAsk(30_000);
  } catch (e) {
    if (zaiUsageCache.unconfigured) throw unconfiguredUsageError();
    throw new Error(`usage could not be fetched: ${e.message}`);
  }
  const snap = usageSnapshotOrThrow(result.data, zaiUsageCache.dataAt, { unconfigured: zaiUsageCache.unconfigured });
  if (result.stale) snap.stale = result.stale;
  return snap;
}

// Owner-specified format: the tail is the 2026-09-01 line (one-word state,
// "N queued" / "no queued", usage as percentages only); the shared-group
// design (section 3) prepends identity -- fleet/model when TELEGRAM_FLEET
// is set, the model alone when not -- so the pinned line names what the
// topic runs. The model segment is the topic's STORED model, never the
// backend default when one is stored. Mode stays off the line; /mode
// confirms its own effect. All wording lives in usage.js's statusLineText,
// pure and unit-tested; this only gathers what the topic actually is.
function topicStatusText(threadId, state) {
  const entry = store.getTopic(threadId);
  return statusLineText({
    fleet: cfg.fleet,
    model: statusModelFor(entry, cfg.defaultBackend, defaultModelFor),
    state,
    queued: store.getQueue(threadId).length,
    ...statusUsageText(),
  });
}

// Queue-depth changes are status changes too (owner-observed gap
// 2026-09-01: queueing a message never touched the 📌 line, so `queued: N`
// stayed stale from the last turn boundary -- and with the idle-write skip
// in finalizeTurn, the next refresh even showed the post-dequeue count).
// Called after every queue mutation; state derived from the topic's session.
function refreshTopicStatusForQueue(threadId) {
  const sid = store.getTopic(threadId)?.sessionId;
  updateTopicStatus(threadId, sid && busySessions.has(sid) ? 'busy' : 'idle').catch(() => {});
}

// Thin wrapper: the existence check and the usage-cache warm happen at
// REQUEST time, once per requested update, as before -- the send/edit/pin
// itself runs on the tracker's per-topic chain, so concurrent callers queue
// instead of each posting their own status message (the why is in
// bridge/topicStatus.js).
async function updateTopicStatus(threadId, state) {
  // MCP-only: the pinned status line and its pin machinery are chat
  // furniture -- every caller's write is skipped here, at the one place all
  // of them funnel through.
  if (!telegramEnabled()) return;
  const entry = store.getTopic(threadId);
  if (!entry) return; // topic never used (no store entry) -- nothing to report
  refreshUsagePercentages(); // fire-and-forget; this write uses the last cache
  return topicStatus.update(threadId, () => topicStatusText(threadId, state));
}

// Re-adopt status message ids persisted by a previous process (the tracker's
// map is in-memory) so a restart keeps editing the same message instead of
// posting a second one.
function restoreTopicStatuses() {
  for (const [threadId, entry] of Object.entries(store.data.topics)) {
    if (entry.statusMessageId) topicStatus.adopt(threadId, entry.statusMessageId);
  }
}

// --- /model: list / switch the topic's model, across the /model span (the
// MODEL_BACKENDS set -- every backend except mock by default; the listing
// constructs lazily where needed; a ref the topic's own backend offers
// switches in-session exactly as before; a ref only ANOTHER backend offers
// performs the /backend-style fresh-session switch with that model stored
// for the new session; a ref two backends both offer is refused until
// qualified as backend:model) -- the merge and resolve rules themselves are
// pure functions in bridge/modelref.js ---

// One gather, shared by the listing and the resolution: every backend in the
// /model span (modelBackends -- mock excluded by default, see its
// definition). getBackend() constructs each exactly as a topic asking for it
// would (so a bridge that never touches codex pays nothing until this runs),
// and a backend that cannot be constructed or cannot answer becomes a
// one-line note instead of failing the whole command.
async function gatherModelsAcrossBackends(threadId) {
  const workspaceKey = `tg-topic-${threadId}`;
  const lists = {};
  const unavailable = [];
  for (const name of modelBackends) {
    try {
      const models = await getBackend(name).listModels({ workspaceDir: cfg.workspaceDir, workspaceKey });
      if (models.length) lists[name] = models;
      else unavailable.push(`${name}: no models advertised`);
    } catch (e) {
      unavailable.push(`${name}: unavailable — ${e.message}`);
    }
  }
  return { lists, unavailable };
}

async function handleModelCommand(threadId, arg) {
  const entry = store.getTopic(threadId) || {};
  const currentBackend = entry.backend || cfg.defaultBackend;
  const currentModel = entry.model || defaultModelFor(currentBackend);
  const workspaceKey = `tg-topic-${threadId}`;
  const { lists, unavailable } = await gatherModelsAcrossBackends(threadId);

  if (!arg) {
    const rows = [];
    let lastBackend = null;
    for (const m of mergeModelLists(lists, modelBackends)) {
      if (m.backend !== lastBackend) {
        rows.push(`${m.backend}:`);
        lastBackend = m.backend;
      }
      const ctx = m.contextWindow ? (m.contextWindow >= 1000000 ? `${m.contextWindow / 1000000}M` : `${Math.round(m.contextWindow / 1000)}k`) : null;
      // The topic's current model is marked only within its own backend's
      // group -- the header already names the current backend.
      const mark = m.backend === currentBackend && m.ref === currentModel ? '▶' : '•';
      rows.push(`${mark} ${m.ref} — ${m.label || m.ref}${ctx ? ` (${ctx} ctx)` : ''}`);
    }
    const text = [
      `Models across backends (current: ${currentBackend} · ${currentModel || '(backend default)'}):`,
      ...rows,
      ...unavailable,
      '',
      "Switch: /model <name> — if the model lives on another backend, this topic starts a FRESH session there (backends don't share history).",
      'If a name exists on more than one backend, qualify it: /model backend:name.',
    ].join('\n');
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text });
    return;
  }

  // Resolve the typed ref against every backend's list. The resolver's
  // answer carries the backend it was found in, and the switch below applies
  // THAT pair -- a resolved model is never applied to the topic's current
  // backend by default (that guess is the recorded live bug this replaces).
  let resolution = null;
  let resolveError = null;
  try {
    resolution = resolveModelRef(arg, lists);
  } catch (e) {
    resolveError = e;
  }
  if (!resolution && !arg.includes(':') && !arg.includes('/')) {
    // zcode's bare-name convention, unchanged: a bare name defaults to the
    // zai provider ('glm-5.3' -> 'zai/glm-5.3') -- tried only when the bare
    // ref resolved nowhere on its own, so a name another backend genuinely
    // offers is not shadowed by it.
    try {
      resolution = resolveModelRef(`zai/${arg}`, lists);
      resolveError = null;
    } catch {
      /* the original error is the honest one; report that */
    }
  }
  if (!resolution) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ /model failed: ${resolveError.message}` });
    return;
  }
  const { backend: resolvedBackend, ref } = resolution;

  // Proxied mode (relay-owned-group design, section 4): the resolver found
  // the ref on ANOTHER backend -- the fresh-session switch below would move
  // this topic to a provider its fleet/model binding does not name, so it
  // is refused, exactly as /backend is. Within-backend switches (the
  // resolved backend IS the topic's) fall through to the in-session switch,
  // unchanged -- and with no unix: root this gate is inert, byte for byte
  // today's cross-backend behavior.
  const proxiedRefusal = proxiedBackendSwitchRefusal(cfg.proxied, currentBackend, resolvedBackend);
  if (proxiedRefusal) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: proxiedRefusal });
    return;
  }

  // CODEX_DISALLOW_ASTRA (and any future per-backend dial) operates on the
  // backend the ref was FOUND in, not the topic's current one.
  if (resolvedBackend === 'codex' && ref === 'gpt-6-astra' && cfg.codexDisallowAstra) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ This deployment has CODEX_DISALLOW_ASTRA set; /model gpt-6-astra is refused here.` });
    return;
  }

  if (resolvedBackend === currentBackend) {
    // The topic's own backend: the in-session switch, unchanged.
    store.setTopic(threadId, { ...entry, model: ref });
    getBackend(resolvedBackend).invalidateModelCache?.(workspaceKey);
    if (entry.sessionId && subscribedSessions.has(entry.sessionId)) {
      try {
        await getBackend(resolvedBackend).setModel(entry.sessionId, ref);
      } catch (e) {
        await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Stored for this topic, but the live session rejected the switch: ${e.message}` });
        return;
      }
    }
    await updateTopicStatus(threadId, busySessions.has(entry.sessionId) ? 'busy' : 'idle').catch(() => {});
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `✅ Model for this topic: ${ref}` });
    return;
  }

  // A different backend: the /backend-style fresh-session switch, with the
  // model the ref resolved to stored so the new session opens on it. A
  // running turn is refused, exactly as /backend refuses one.
  if (busySessions.has(entry.sessionId)) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: '⚠️ A turn is running in this topic — /stop it first, then switch models.' });
    return;
  }
  if (entry.sessionId) {
    // Best-effort close of the OLD session -- the new backend has no idea
    // what the old session id even means, so this genuinely isn't "the same
    // conversation continuing" the way a same-backend /model switch is.
    await backendForSession(entry.sessionId).closeConversation(entry.sessionId).catch(() => {});
    subscribedSessions.delete(entry.sessionId);
    sessionToTopic.delete(entry.sessionId);
    // The old backend's per-workspace model cache (zcode's runtimeModel) was
    // built for the old model -- drop it so this topic returning there later
    // warms with whatever the model is then.
    try {
      backendForSession(entry.sessionId).invalidateModelCache?.(workspaceKey);
    } catch {}
  }
  // THE PAIR, APPLIED TOGETHER: the resolved model is stored WITH the backend
  // it was found in, and the old session id is dropped -- a resolved model is
  // never applied to the topic's current backend by default (that guess is
  // the recorded live bug this command's resolver exists to make impossible).
  store.setTopic(threadId, { ...entry, backend: resolvedBackend, sessionId: undefined, model: ref });
  await updateTopicStatus(threadId, 'idle').catch(() => {});
  await tg.sendMessage({
    chatId: chatOf(threadId),
    messageThreadId: threadOf(threadId),
    text: `✅ This topic now runs ${ref} on '${resolvedBackend}' — a fresh session starts on your next message (history does not carry over: backends don't share sessions).`,
  });
}

// --- /mode: list / switch the topic's session mode -- a zcode-native
// concept (its runtime mode enum: plan/edit/yolo/...); backends with no
// equivalent (Codex) report an empty listModes() and /mode becomes a
// documented no-op for that topic rather than a fake mapping onto whatever
// Codex concept looks vaguely similar (see codexBackend.js's setMode). ---
async function handleModeCommand(threadId, arg) {
  const entry = store.getTopic(threadId) || {};
  const backendName = entry.backend || cfg.defaultBackend;
  const backend = getBackend(backendName);
  const modes = backend.listModes();
  if (!modes.length) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `This topic runs on the '${backendName}' backend, which has no mode concept — /mode is a no-op here.` });
    return;
  }
  const current = entry.mode || cfg.defaultSessionMode;
  if (!arg) {
    const rows = modes.map((m) => `• ${m.name}${m.note ? ` — ${m.note}` : ''}`);
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: [`Modes (current: ${current}):`, ...rows, '', 'Switch: /mode <name>'].join('\n') });
    return;
  }
  if (!modes.some((m) => m.name === arg)) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Unknown mode "${arg}". /mode with no argument lists valid modes.` });
    return;
  }
  store.setTopic(threadId, { ...entry, mode: arg });
  if (entry.sessionId && subscribedSessions.has(entry.sessionId)) {
    try {
      await backend.setMode(entry.sessionId, arg);
    } catch (e) {
      await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Stored for this topic, but the live session rejected the switch: ${e.message}` });
      return;
    }
  }
  await updateTopicStatus(threadId, busySessions.has(entry.sessionId) ? 'busy' : 'idle').catch(() => {});
  await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `✅ Mode for this topic: ${arg}` });
}

// --- /backend: list / switch which backend (zcode / codex) this topic runs
// on. Switching starts a FRESH session on the new backend on the next
// message -- a session id from one backend means nothing to the other, so
// there is no way to carry conversation history across this switch (unlike
// /model or /mode, which act on the SAME running session). ---
const KNOWN_BACKENDS = Object.keys(BACKEND_FACTORIES);

// THE MCP-REACHABLE CODEX TIERS, AND ONLY THESE THREE -- Sol (flagship,
// ~Opus), Terra (balanced, ~Sonnet, the strong default), Luna (fastest/
// cheapest, ~Haiku). gpt-6-astra is Codex's newest and most expensive model
// (confirmed live via model/list's isDefault flag -- it's what Codex's own
// server picks absent an override) and is deliberately absent: MCP is not a
// channel for reaching it, no matter what a caller asks for. An exact-match
// allowlist rather than a pattern/prefix check on purpose -- a future model
// name is refused by default until someone deliberately adds it here, not
// silently admitted because it happens to start with "gpt-5.6-".
//
// CONFIGURABLE FROM ENV, never from code at a deployment: CODEX_MCP_MODELS
// is a comma list replacing this default wholesale (not extending it --
// an operator who names one model gets exactly one, which is how a bridge
// pinned to Terra alone is done: CODEX_MCP_MODELS=gpt-5.6-terra). Unset or
// empty means the three tiers below. Paired with CODEX_DEFAULT_MODEL, which
// should name one of the listed models -- a default outside the allowlist
// is unreachable over MCP.
const codexMcpModelsFromEnv = (process.env.CODEX_MCP_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CODEX_MCP_MODELS = codexMcpModelsFromEnv.length ? codexMcpModelsFromEnv : ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];

// validateMcpModel enforces the MCP model policy for both session_create and
// model_set, in one place, so the two can't drift: zcode and mock both
// refuse a model argument outright (zcode's own MCP contract has never
// offered one; mock has exactly one model and nothing to switch to/from --
// see mockBackend.js's "Model-switching policy" comment), Codex accepts
// only CODEX_MCP_MODELS, omitted means "use the backend's own default"
// (Terra, for Codex -- see cfg.codexDefaultModel).
function validateMcpModel(backend, model) {
  if (model == null) return undefined;
  if (backend !== 'codex') {
    throw new Error(`model may only be chosen for the codex backend over MCP (got backend=${backend}); ${backend} has no MCP-switchable model`);
  }
  if (!CODEX_MCP_MODELS.includes(model)) {
    throw new Error(`model "${model}" is not offered over MCP; choose one of ${CODEX_MCP_MODELS.join(', ')}`);
  }
  return model;
}
async function handleBackendCommand(threadId, arg) {
  const entry = store.getTopic(threadId) || {};
  const current = entry.backend || cfg.defaultBackend;
  if (!arg) {
    const rows = KNOWN_BACKENDS.map((n) => `${n === current ? '▶' : '•'} ${n}`);
    await tg.sendMessage({
      chatId: chatOf(threadId),
      messageThreadId: threadOf(threadId),
      text: [`Backend (current: ${current}):`, ...rows, '', "Switch: /backend <name> — starts a FRESH session on the new backend; this topic's history does not carry over."].join('\n'),
    });
    return;
  }
  if (!KNOWN_BACKENDS.includes(arg)) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Unknown backend "${arg}". Known: ${KNOWN_BACKENDS.join(', ')}.` });
    return;
  }
  if (arg === current) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `Already on '${arg}'.` });
    return;
  }
  // Proxied mode (relay-owned-group design, section 4): a unix: API root
  // means a relay stands in for Telegram, and this topic's provider is fixed
  // by its fleet/model binding -- moving the conversation to another backend
  // would leave the relay filing its messages under the old agent. Refused
  // before any state changes and before the getBackend probe (the refusal is
  // the binding's, not the backend's configurability); in the direct world
  // this gate is inert. The relay-native way to reach '${arg}' is a topic
  // of its own, which the pick binds to the agent holding that provider.
  const proxiedRefusal = proxiedBackendSwitchRefusal(cfg.proxied, current, arg);
  if (proxiedRefusal) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: proxiedRefusal });
    return;
  }
  if (busySessions.has(entry.sessionId)) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: '⚠️ A turn is running in this topic — /stop it first, then switch backends.' });
    return;
  }
  try {
    getBackend(arg); // throws e.g. if Codex isn't configured (CODEX_HOME unset) -- fail before touching any state
  } catch (e) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Can't switch to '${arg}': ${e.message}` });
    return;
  }
  if (entry.sessionId) {
    // Best-effort close of the OLD session -- the new backend has no idea
    // what the old session id even means, so this genuinely isn't "the same
    // conversation continuing" the way /model and /mode are.
    await backendForSession(entry.sessionId).closeConversation(entry.sessionId).catch(() => {});
    subscribedSessions.delete(entry.sessionId);
    sessionToTopic.delete(entry.sessionId);
  }
  store.setTopic(threadId, { ...entry, backend: arg, sessionId: undefined, model: undefined });
  await tg.sendMessage({
    chatId: chatOf(threadId),
    messageThreadId: threadOf(threadId),
    text: `✅ This topic now runs on '${arg}' — a fresh session starts on your next message (history does not carry over).`,
  });
}

// --- /file: send a workspace file into the topic as a document ---
// Restricted to the workspace subtree: the bridge account can read files
// (e.g. ~/.zcode credentials) that must not become one tap away from chat.
// Shared by /file (interactive, errors posted to the topic) and the model's
// `[file: path]` reply markers (silent). Always restricted to the workspace
// subtree: the bridge account can read files (e.g. ~/.zcode credentials)
// that must not become one tap away from chat.
async function sendWorkspaceFile(threadId, arg, { source }) {
  const abs = path.resolve(cfg.workspaceDir, arg);
  const real = await realpath(abs);
  const root = await realpath(cfg.workspaceDir); // so symlinked prefixes compare correctly
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`${arg} resolves outside the workspace -- only files under it can be sent`);
  }
  const st = await stat(real);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > cfg.maxFileBytes) throw new Error(`file is ${Math.round(st.size / 1024 / 1024)} MB; cap is ${Math.round(cfg.maxFileBytes / 1024 / 1024)} MB`);
  const buf = await readFile(real);
  await tg.sendDocument({
    chatId: chatOf(threadId),
    messageThreadId: threadOf(threadId),
    blob: new Blob([buf]),
    filename: path.basename(real),
    caption: `${arg} (${abbrev(st.size)} B)${source === 'model' ? ' — attached by the agent' : ''}`,
  });
}

async function handleFileCommand(threadId, arg) {
  if (!arg) {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: 'Usage: /file <path-inside-workspace>' });
    return;
  }
  try {
    await sendWorkspaceFile(threadId, arg, { source: 'command' });
  } catch (e) {
    const msg = /outside the workspace/.test(e.message || '')
      ? `⚠️ ${e.message}`
      : `⚠️ /file failed: ${/ENOENT/.test(e.message || '') ? 'not found' : e.message}`;
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: msg }).catch(() => {});
  }
}

// Inbound files (owner request 2026-09-01): a document sent to the topic is
// downloaded (Telegram bots can fetch up to 20 MB) and saved under
// inbox/telegram/ in the workspace -- the same inbox/ that exists for
// owner-dropped files generally -- timestamped to avoid collisions. The
// turn's prompt tells the agent exactly where it landed; the user's
// caption, if any, rides along as the instruction. Returns the prompt text,
// or null after posting the specific failure to the topic.
async function receiveInboundDocument(message, threadId) {
  const doc = message.document;
  const caption = (message.caption || '').trim();
  try {
    if ((doc.file_size ?? 0) > cfg.maxInboundFileBytes) {
      throw new Error(`file is ${Math.round((doc.file_size ?? 0) / 1024 / 1024)} MB; Telegram's bot download cap is ${Math.round(cfg.maxInboundFileBytes / 1024 / 1024)} MB`);
    }
    const file = await tg.getFile({ fileId: doc.file_id });
    const buf = await tg.downloadFile(file.file_path);
    const dir = path.join(cfg.workspaceDir, 'inbox', 'telegram');
    await mkdir(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${sanitizeFileName(doc.file_name, doc.file_unique_id)}`;
    const dest = path.join(dir, name);
    await writeFile(dest, buf);
    const rel = path.relative(cfg.workspaceDir, dest);
    console.log(`[bridge] topic ${threadId}: inbound file saved -> ${rel} (${abbrev(buf.length)} B)`);
    return [
      `[The user sent a file in Telegram; the bridge saved it to ${rel} (${abbrev(buf.length)} bytes). Read it with your file tools whenever useful.]`,
      caption ? `User's caption: ${caption}` : 'No caption was provided.',
    ].join('\n');
  } catch (e) {
    console.error('[bridge] inbound file failed:', e.message);
    await tg
      .sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Couldn't receive "${doc.file_name || 'file'}": ${e.message}` })
      .catch(() => {});
    return null;
  }
}

// Filename for inbound saves: keep the readable part, drop anything that
// could escape the save directory or confuse shells, never return empty.
function sanitizeFileName(name, fallbackId) {
  const base = path
    .basename(String(name || ''))
    .replace(/[^\w.\-+ ()]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return base || `file-${fallbackId || 'unnamed'}`;
}


// --- /stop is a HARD interrupt (owner ask 2026-09-06) ---
// cancel() (a backend's session/stop-equivalent) aborts the turn's
// server-side control flow, which interrupts the model stream and FUTURE
// steps -- but a tool that is EXECUTING right now (a blocking TaskOutput, a
// long bash) does not check that signal, so the turn idles until the tool
// returns on its own. To actually stop "everything, immediately, with
// interruption", the bridge additionally:
//   1. asks the session's own backend to kill its in-flight tool processes
//      (killLocalToolProcesses -- an OPTIONAL, backend-specific capability:
//      zcode's implementation (bridge/backends/zcodeBackend.js) finds them
//      via /proc by the raw session id embedded in every command the
//      runtime launches, as a full process TREE, SIGTERM then SIGKILL for
//      stragglers; a backend with no way to make the same guarantee about
//      its own subprocess naming leaves this a no-op rather than risk
//      killing the wrong thing -- see codexBackend.js);
//   2. cancels the session's known background tasks via the backend's
//      cancelBackgroundTask (taskIds tracked from the task lifecycle events
//      the bridge already receives -- a no-op for a backend with no
//      background-task concept).
const sessionBackgroundTasks = new Map(); // sessionId -> Set(taskId) currently running
// sessionId -> timestamp of the last interrupt (hard /stop or breaker). A
// terminal event arriving for a turn that never learned ITS OWN turnId,
// started after this timestamp, is the INTERRUPTED turn's straggler -- the
// new turn's own turn.started always precedes its terminal, so an unknown
// turnId at terminal time means the event cannot belong to the new turn.
const lastInterruptedAt = new Map();

function noteTaskLifecycle(sessionId, payload) {
  if (!payload?.taskId) return;
  const set = sessionBackgroundTasks.get(sessionId) ?? new Set();
  if (payload.status === 'running') set.add(payload.taskId);
  else set.delete(payload.taskId);
  if (set.size) sessionBackgroundTasks.set(sessionId, set);
  else sessionBackgroundTasks.delete(sessionId);
}

// Shared interrupt core. Used by /stop (EVERYTHING dies: processes killed,
// background tasks cancelled) and by the TaskOutput circuit breaker below
// (cancel() only: the TURN dies, while background tasks and their
// processes keep running so completion notifications still arrive later --
// the process sweep must NOT run there, because a background task's
// command line carries the same session id as any foreground tool's, and
// killing "the session's processes" would silently kill the task the model
// was waiting ON, defeating the breaker's whole point. Verified by
// test/e2e-breaker.mjs after exactly that bug fired live in its first run).
async function interruptTurn(sessionId, { killEverything }) {
  lastInterruptedAt.set(sessionId, Date.now());
  const backend = backendForSession(sessionId);
  await backend.cancel(sessionId).catch((e) => console.error('[bridge] cancel failed:', e.message));
  if (!killEverything) return;
  backend.killLocalToolProcesses(sessionId);
  for (const taskId of sessionBackgroundTasks.get(sessionId) ?? []) {
    backend.cancelBackgroundTask(sessionId, taskId).catch(() => {});
  }
}

// --- Telegram message handling ---

// '/usage@botname arg' -> 'usage'; null for anything that isn't a command
// for us. Parsing is bridge/commands.js's; the @-addressing verdict is THIS
// bridge's, because only it knows whether the suffix is its own name.
// A command carrying @somename belongs to somename or nobody (shared-group
// design section 1): ours only when the suffix equals our own username, and
// NEVER while getMe hasn't answered -- "assume ours" is how two bots in one
// group both end up answering. Only our own commands are intercepted below;
// anything else starting with '/' (zcode's /init, /memo, ...) passes through
// to the model as ordinary input. A foreign-suffixed command, though, is
// dropped OUTRIGHT -- not run as a command and not passed to the model
// either: an owner typing /stop@otherbot is talking to the other bot.
function resolveOwnCommand(text) {
  const parsed = parseCommandText(text);
  if (!parsed) return { command: null };
  if (parsed.suffix == null) return { command: parsed.name };
  const own = botUsername();
  if (!own) {
    console.warn(`[bridge] /${parsed.name}@${parsed.suffix} dropped: own username unknown (getMe not answered yet) -- a suffixed command is never assumed ours`);
    return { command: null, drop: true };
  }
  if (!commandIsOurs(parsed.suffix, own)) {
    console.log(`[bridge] /${parsed.name}@${parsed.suffix} is addressed to another bot -- dropped`);
    return { command: null, drop: true };
  }
  return { command: parsed.name };
}

async function handleUsageCommand(threadId) {
  // The SAME source-selection path usage_get takes: usageGetForMcp itself,
  // handed over as the thunk usageTelegramText renders from -- not a
  // re-branch here, and not the direct readZaiApiKey+fetchUsage this used to
  // be (which read the z.ai key unconditionally and crashed a codex-default
  // bridge with ENOENT on its isolated $HOME; reported 2026-09-22). Failure
  // sentences are usage_get's, byte for byte -- one wording, both surfaces.
  const label = cfg.defaultBackend === 'codex' ? 'codex usage' : 'Z.ai usage';
  const text = await usageTelegramText(usageGetForMcp, { label });
  await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text, parseMode: 'HTML' }).catch((e) => console.error('[bridge] failed to post usage:', e.message));
}

function helpText() {
  return [
    'Bridge commands (each scoped to this topic):',
    '/usage — plan usage & quota for this bridge’s backend',
    '/stop, /cancel — cancel the running turn',
    '/queue — show queued messages',
    '/clearqueue — drop queued messages',
    '/model [name] — list / switch this topic’s model',
    '/mode [name] — list / switch this topic’s mode',
    '/backend [name] — list / switch this topic’s backend (zcode/codex/mock)',
    '/file <path> — send a workspace file here',
    '',
    'Anything else is sent to the model. Replies stream into the ⌛ placeholder message. Messages sent while a turn is running are queued and run in order; reply to any message to quote it to the model. Send a file as a document and the agent reads it (saved to inbox/, your caption = instruction).',
  ].join('\n');
}

// THE OWNER GATE IS THE ONLY GATE. The bridge serves whatever chat an owner
// speaks in -- a DM, a group, any topic -- and ignores everyone else. The old
// fixed TELEGRAM_CHAT_ID filter is gone: the chat id recorded at /auth time
// (or in .env) is informational now, because the whole point of the bridge is
// to follow its owner around rather than to own a room.
// An unhandled rejection must not kill the bridge: one failed turn is a
// message lost, a dead bridge is every message lost. Logged loudly instead.
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] UNHANDLED REJECTION:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});

const allowedOwners = new Set(
  String(cfg.allowedUserId).split(',').map((s) => s.trim()).filter(Boolean).map(Number),
);
const isOwner = (id) => allowedOwners.has(Number(id));

// A conversation key: stable per chat (+topic when there is one), so the
// store, the queue and the session map can serve several chats at once.
// Legacy shape preserved for the configured home chat (bare thread id), so an
// speaks in -- a DM, a group, any topic -- and ignores everyone else. The old
// fixed TELEGRAM_CHAT_ID filter is gone: the chat id in .env is informational
// now (the default/home chat), because the bridge follows its owner around
// rather than owning one room.

// A conversation key: stable per chat (+topic when there is one), so the
// store, the queue and the session map can serve several chats at once. The
// configured home chat keeps its legacy bare-thread keys, so an existing
// store's topic/session mappings survive this change untouched.
function keyFor(chatId, threadId) {
  if (Number(chatId) === Number(cfg.chatId)) return threadId ? String(threadId) : `c${chatId}`;
  return `c${chatId}` + (threadId ? `:t${threadId}` : '');
}
// And back again: every outgoing call needs the real chat id and thread.
function parseTopicKey(key) {
  if (/^-?\d+$/.test(String(key))) return { chatId: Number(cfg.chatId), threadId: Number(key) };
  const m = String(key).match(/^c(-?\d+)(?::t(\d+))?$/);
  if (!m) return { chatId: Number(cfg.chatId), threadId: undefined };
  return { chatId: Number(m[1]), threadId: m[2] ? Number(m[2]) : undefined };
}
const chatOf = (key) => {
  const t = store.getTopic(key);
  if (t?.chatId) return Number(t.chatId); // entries staged before composite keys
  return parseTopicKey(key).chatId;
};
const threadOf = (key) => parseTopicKey(key).threadId;

// The session key an MCP-only session_create mints: a synthetic `m<N>`,
// numbered past anything already in the store (so a restart can't mint a
// colliding key over a live session). Why not the chat-less `c<chat>` form
// keyFor already has: that form keys a real chat, and without Telegram there
// is no chat id to put in it -- every MCP-only session would collapse onto
// the same `c<chat>` string and share one conversation, reply log and
// session. `m<N>` is unique per session, names no chat that doesn't exist,
// and if a bug ever carried one into a Telegram call anyway, parseTopicKey's
// no-match fallback sends it to chat 0 -- where the call fails loudly rather
// than posting into some real group.
function mintMcpOnlySessionKey() {
  let max = 0;
  for (const key of Object.keys(store.data.topics)) {
    const m = /^m(\d+)$/.exec(key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `m${max + 1}`;
}

// The bot's own Telegram identity, fetched once -- the id getChatMember
// needs to ask about our own admin status when auto-picking a session
// target, and the username a command's @suffix is compared against
// (resolveOwnCommand above). Until getMe answers, username is null and a
// suffixed command is treated as NOT ours, never assumed ours.
let botSelf = null; // { id, username }
async function ensureBotSelf() {
  if (botSelf == null) {
    const me = await tg.getMe();
    botSelf = { id: me.id, username: me.username ?? null };
  }
  return botSelf;
}
async function ensureBotUserId() {
  return (await ensureBotSelf()).id;
}
function botUsername() {
  return botSelf?.username ?? null;
}

// A group the bot is IN and has SERVED (the owner spoke in it, created a
// topic there, or added the bot): a candidate for the default MCP session
// target. Positive ids (private chats) can never host topics, so they are
// not worth remembering. lastSeenAt orders candidates at pick time; entries
// are re-validated live there (pickDefaultForumChat), so staleness is
// harmless -- but an hour of owner chatter shouldn't mean an hour of store
// rewrites either, hence the throttle.
const CHAT_RESEEN_MS = 60 * 1000;
function noteKnownChat(chat) {
  const chatId = Number(chat?.id);
  if (!Number.isInteger(chatId) || chatId >= 0) return;
  const known = store.getChats()[chatId] || {};
  const fresh = {};
  if (chat.title != null) fresh.title = chat.title;
  if (chat.type != null) fresh.type = chat.type;
  if (
    (known.title ?? null) === (fresh.title ?? null) &&
    (known.type ?? null) === (fresh.type ?? null) &&
    Date.now() - (known.lastSeenAt ?? 0) < CHAT_RESEEN_MS
  ) return; // nothing new worth a store write
  store.noteChat(chatId, { ...fresh, lastSeenAt: Date.now() });
}

// Where a chat-less MCP session_create should land: the forum-enabled groups
// the bot actually knows, admin-run ones first, most recently served first.
// See bridge/chatpick.js for the ranking rationale.
async function pickDefaultForumChat() {
  const botId = await ensureBotUserId();
  const byId = new Map(
    Object.entries(store.getChats()).map(([id, info]) => [Number(id), { chatId: Number(id), lastSeenAt: info.lastSeenAt ?? 0 }]),
  );
  // The configured home chat stays a candidate (ranked by its own real
  // activity, i.e. behind any chat the owner actually uses) so a CORRECT
  // TELEGRAM_CHAT_ID keeps working even before the owner has ever spoken
  // in it -- while a stale one can no longer break the default.
  if (!byId.has(Number(cfg.chatId))) byId.set(Number(cfg.chatId), { chatId: Number(cfg.chatId), lastSeenAt: 0 });
  const candidates = [...byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const winner = await pickForumChat({
    getChat: (chatId) => tg.getChat({ chatId }),
    getChatMember: (chatId) => tg.getChatMember({ chatId, userId: botId }),
    botId,
    candidates,
  });
  console.log(
    `[bridge] mcp session_create: no chat_id given -- picked chat ${winner.chatId}${winner.title ? ` ("${winner.title}")` : ''}` +
      `${winner.admin ? '' : ' (bot NOT admin there: topic creation may fail)'} from ${candidates.length} known chat(s)`,
  );
  return winner;
}

// ADDED SOMEWHERE BY A NON-OWNER: say why and leave, exactly as the cage's
// own bot does. Exiting the process would only crash-loop under the service
// supervisor (the bot is still a member of the foreign chat on every
// restart); leaving is final and tells the truth once.
function handleMyChatMember(m) {
  const status = m.new_chat_member?.status;
  // Any status in these three means the bot is IN the chat right now --
  // worth remembering as a default-target candidate (it gets re-validated
  // live at pick time, so a chat we are subsequently kicked out of merely
  // becomes unreachable there).
  if (['member', 'restricted', 'administrator'].includes(status)) noteKnownChat(m.chat);
  if (!['member', 'restricted'].includes(status)) return;
  if (isOwner(m.from?.id)) return;
  const chatId = m.chat?.id;
  if (!String(chatId).startsWith('-')) return; // a private chat needs no check
  console.warn(`[bridge] added to chat ${chatId} by non-owner ${m.from?.id} -- leaving`);
  tg.sendMessage({ chatId: String(chatId), text: '⛔ I only serve my owner. Leaving.' })
    .catch(() => {})
    .then(() => tg.leaveChat({ chatId: String(chatId) }))
    .catch((e) => console.error('[bridge] leaveChat failed:', e.message));
}

// --- the relay's synthetic topic deletion (relay-owned-group design §4,
// "Re-bind and close") ---
//
// In proxied mode the relay stands between this bridge and Telegram, and
// when a bound topic moves away -- an owner's /rebind or /close, or the
// topic physically deleted through the Telegram UI -- the relay synthesizes
// a Bot-API-shaped MESSAGE update carrying `forum_topic_deleted: {}` into
// this bridge's getUpdates stream. It is NOT a real Bot API field (Telegram
// itself has forum_topic_closed, and sends it as a service message) -- it is
// the relay's agreed synthetic marker for "this topic is no longer yours".
//
// NOT forum_topic_closed, deliberately: a human closing a topic in the
// Telegram UI is REVERSIBLE (they can reopen it), so it must not end the
// session here; only the deletion marker does. A real forum_topic_closed
// service message therefore falls through to the ordinary message path and
// is ignored like any other service message.
//
// THE TRUST BOUNDARY is the transport, not the message: the synthetic
// update's `from` is the relay's synthetic identity -- not the owner -- so
// the owner gate must not (and does not) see this message. It is accepted
// ONLY when cfg.proxied (TELEGRAM_API_ROOT is a unix: root): only the relay
// can inject updates into that stream, because only the relay is on the
// other end of the socket. In legacy mode a real Telegram never sends this
// field, and a bridge must ignore it rather than let any injected-looking
// update close a session -- the field's arrival there would mean something
// is wrong, and closing a session is the one act we do not take on a
// maybe-hostile maybe-nothing.
//
// What it does is the MCP session_close path MINUS the Telegram half:
//   - any in-flight turn for the topic is stopped cleanly (the turn's
//     session is cancelled; background tasks keep running so their
//     completion notifications still land -- the circuit-breaker rule,
//     since killing them would orphan exactly the work the model was
//     waiting on);
//   - queued messages are dropped and their parked MCP callers told why;
//   - the store entry is marked closed, which messageSend then refuses;
//   - and closeForumTopic is NOT called: the topic is no longer ours (it is
//     deleted, or the binding has moved), the relay owns the real topic
//     lifecycle, and the proxy's scope check would 403 the call anyway.
// No chat writes at all, for the same reason: the topic may already be gone
// or re-bound elsewhere, and every send would just 403.
//
// Idempotent by design: the relay may deliver the delete more than once
// (at-least-once across a restart, design section 9), and a second delete
// for an unknown or already-closed topic is a logged no-op.
async function handleRelayTopicDeleted(message) {
  if (!cfg.proxied) {
    console.warn(`[bridge] ignoring forum_topic_deleted for thread ${message.message_thread_id} in chat ${message.chat?.id}: not in proxied mode (a real Telegram never sends this field)`);
    return;
  }
  const threadId = keyFor(message.chat?.id, message.message_thread_id);
  const entry = store.getTopic(threadId);
  if (!entry) {
    console.log(`[bridge] forum_topic_deleted: no session for topic ${threadId} -- nothing to close (already gone, or never bound)`);
    return;
  }
  if (entry.closed) {
    console.log(`[bridge] forum_topic_deleted: topic ${threadId} is already closed -- ignoring duplicate`);
    return;
  }
  console.log(`[bridge] forum_topic_deleted: closing session for topic ${threadId} (relay reports the topic deleted or re-bound)`);
  // Stop the in-flight turn FIRST, so its streamer/progress views cannot
  // fire another edit into a topic that is leaving, and so the turn's own
  // terminal (if the cancel races one) finalizes into a topic entry that is
  // already closed rather than re-busying it.
  const sessionId = entry.sessionId;
  if (sessionId && activeTurns.has(sessionId)) {
    const turn = activeTurns.get(sessionId);
    console.log(`[bridge] forum_topic_deleted: interrupting in-flight turn on session ${sessionId}`);
    await interruptTurn(sessionId, { killEverything: false });
    busySessions.delete(sessionId);
    activeTurns.delete(sessionId);
    turn.streamer?.stop();
    turn.progress?.stop();
    // The session is finished; drop the mapping so a straggler turn.started
    // on it can never be adopted into a ghost turn for a topic we no longer
    // serve (adoptUnclaimedTurn keys off this map).
    sessionToTopic.delete(sessionId);
  }
  // Queued prompts would otherwise drain straight into a fresh session after
  // a re-bind -- a message the user sent to the OLD conversation must not run
  // on a new one. Parked MCP waiters are told why their reply never comes.
  const queued = store.getQueue(threadId).length;
  if (queued) {
    store.setQueue(threadId, []);
    stranded(threadId, `the topic was deleted or re-bound to another agent while this message was queued, so it was DROPPED and will not be answered`);
    console.log(`[bridge] forum_topic_deleted: dropped ${queued} queued message(s) for topic ${threadId}`);
  }
  // The sessionClose mark: messageSend refuses from here on. Deliberately
  // NOT tg.closeForumTopic() -- see this function's comment.
  store.setTopic(threadId, { closed: true });
}

async function handleMessage(message) {
  try {
  // The relay's synthetic deletion arrives with a non-owner `from`, so it
  // must be handled BEFORE the owner gate (which would drop it). The handler
  // itself carries the proxied-mode trust boundary.
  if (message.forum_topic_deleted) {
    await handleRelayTopicDeleted(message);
    return;
  }
  if (message.from?.is_bot) return;
  if (!isOwner(message.from?.id)) {
    console.warn(`[bridge] ignoring message from unauthorized user ${message.from?.id} in chat ${message.chat?.id}`);
    return;
  }
  noteKnownChat(message.chat); // a group the owner speaks in is a default-target candidate
  const chatId = message.chat.id;
  const messageThread = message.message_thread_id;
  // FROM HERE, `threadId` IS THE CONVERSATION KEY (chat+topic), not the raw
  // Telegram thread id: the callees below key the store and resolve their
  // sends through chatOf/threadOf, so a topicless DM or group is just another
  // conversation rather than a message that silently dies.
  const topicKey = keyFor(chatId, messageThread);
  const threadId = topicKey;
  if (message.forum_topic_created) {
    console.log(`[bridge] topic created: "${message.forum_topic_created.name}" (thread ${threadId}) in chat ${chatId}`);
    if (!threadId) return; // service message outside any topic -- nothing to do
    // Create the 📌 status message NOW, as the topic's first message, so it
    // never occupies conversational space near later messages (owner
    // preference 2026-09-01). A minimal store entry is seeded so the status
    // has somewhere to live; getOrCreateSession merges the session in later.
    if (!store.getTopic(topicKey)) {
      // No `model` seeded here (unlike `mode`): its default depends on which
      // backend this topic ends up on (see getOrCreateSession), which isn't
      // decided yet -- a stub value here would win over that backend-aware
      // default the moment a session is actually created (stored?.model
      // there would already be non-empty). `backend` isn't seeded either,
      // for the same reason: it defaults to cfg.defaultBackend later.
      store.setTopic(topicKey, { chatId, mode: cfg.defaultSessionMode });
    }
    updateTopicStatus(topicKey, 'idle').catch(() => {});
    return;
  }
  // DMs and topicless groups carry no thread and are served whole (the
  // conversation key is the chat alone); topics keep their per-topic session.
  if (!message.text && !message.document) return; // stickers, photos, voice, ... still ignored

  // An inbound document becomes a turn: the bridge downloads it into the
  // workspace and prompts the agent with where it landed (the user's
  // caption, if any, is the instruction). Documents never carry message
  // text -- captions are a separate field -- so this can't collide with the
  // command/quote handling below.
  let fileNote = null;
  if (message.document) {
    fileNote = await receiveInboundDocument(message, threadId);
    if (fileNote === null) return; // specific failure already posted to the topic
  }
  const { command, drop } = resolveOwnCommand(message.text ?? '');
  if (drop) return; // addressed to another bot (or ours not yet known): never ours to act on

  // Bridge-own commands that never need a session run before anything else,
  // so a stray /usage in a brand-new topic doesn't spawn a zcode session.
  if (command === 'usage') {
    await handleUsageCommand(threadId);
    return;
  }
  if (command === 'model') {
    await handleModelCommand(threadId, message.text.split(/\s+/).slice(1).join(' ').trim());
    return;
  }
  if (command === 'mode') {
    await handleModeCommand(threadId, (message.text.split(/\s+/)[1] || '').trim());
    return;
  }
  if (command === 'backend') {
    await handleBackendCommand(threadId, (message.text.split(/\s+/)[1] || '').trim());
    return;
  }
  if (command === 'file') {
    await handleFileCommand(threadId, message.text.split(/\s+/).slice(1).join(' ').trim());
    return;
  }
  if (command === 'help') {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: helpText() });
    return;
  }
  if (command === 'queue') {
    const q = store.getQueue(threadId);
    const text = q.length
      ? ['📥 Queued in this topic:', ...q.map((it, i) => `${i + 1}. ${truncate((it.text || '').split('\n')[0], 80)}`)].join('\n')
      : 'Queue for this topic is empty.';
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text });
    return;
  }
  if (command === 'clearqueue') {
    const q = store.getQueue(threadId);
    store.setQueue(threadId, []);
    refreshTopicStatusForQueue(threadId);
    for (const it of q) {
      await tg.editMessageText({ chatId: chatOf(threadId), messageId: it.placeholderMessageId, text: '🗑 Dropped from queue.' }).catch(() => {});
    }
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: q.length ? `🗑 Dropped ${q.length} queued message(s).` : 'Queue was already empty.' });
    return;
  }
  // /stop and /cancel are NOT handled here: they need the topic's sessionId,
  // resolved below.

  // Replying to an earlier message quotes it into the prompt (agreed tier-3
  // item): the model otherwise has no way to know which of the topic's many
  // messages the user is pointing at. Composed before the busy-queue branch
  // so a queued reply-to keeps its quote too. Quoting is skipped for the
  // bridge's own chrome (status/queued/notice messages and still-streaming
  // ⌛ placeholders) -- quoting "📌 Topic status" into a prompt is noise,
  // and a mid-stream reply's ⌛-prefixed preview is an incomplete text the
  // model can't usefully act on.
  let promptText = message.text ?? fileNote;
  const quoted = message.reply_to_message?.text;
  if (quoted && quoted.trim() && !/^(📌|📥|⌛|🌀|🔓|⚠️)/.test(quoted.trim())) {
    const q = truncate(quoted, 600);
    promptText = `[replying to this earlier message in the topic]\n${q.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${promptText}`;
  }

  // Telegram's client splits long input into several near-simultaneous
  // messages; treating each as its own prompt (or queue entry) turns one
  // user message into a burst of turns. Sit in a short merge window before
  // anything is sent to the model: further parts within the window join
  // this one, then the combined prompt goes through the ordinary dispatch.
  // /stop and /cancel bypass the window -- they must act immediately.
  if (command !== 'stop' && command !== 'cancel' && cfg.inputMergeMs > 0) {
    const pending = pendingPrompts.get(threadId);
    if (pending) {
      pending.parts.push(promptText);
      if (Date.now() - pending.firstAt < cfg.inputMergeMaxMs) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => firePendingPrompt(threadId), cfg.inputMergeMs);
      }
      return; // folded into the burst; dispatched when the window closes
    }
    const entry = { parts: [promptText], firstAt: Date.now(), timer: null };
    entry.timer = setTimeout(() => firePendingPrompt(threadId), cfg.inputMergeMs);
    pendingPrompts.set(threadId, entry);
    return;
  }

  await dispatchUserPrompt(threadId, promptText, command);
  } catch (e) {
    // CONTAINED, AND NAMED. A message whose handling throws must not take
    // the update loop (and with it every conversation the bridge serves)
    // down with it -- measured on the multichat e2e: one conversation's
    // session-create failure killed the whole process, silently, while the
    // owner watched a bot that never answered.
    console.error(`[bridge] message handling failed for chat ${message.chat?.id}:`, e);
    try {
      await tg.sendMessage({ chatId: String(message.chat?.id ?? cfg.chatId), text: `⚠️ message handling failed: ${e.message}` });
    } catch {}
  }
}

function firePendingPrompt(threadId) {
  const entry = pendingPrompts.get(threadId);
  if (!entry) return;
  pendingPrompts.delete(threadId);
  void dispatchUserPrompt(threadId, entry.parts.join('\n\n'), null);
}

// Queue an incoming prompt, merging into the newest entry when it landed
// within the input-merge window -- the queue-side half of the Telegram
// split-message defense (see the merge window in handleMessage).
// stranded tells an MCP caller parked on this conversation that the turn it
// asked for will never answer.
//
// Same reason-or-null contract as dispatchUserPrompt: null once the prompt
// is durably queued, the reason when the queue is full and the message was
// dropped.
//
// EVERY CALL SITE IS ONE THAT ALREADY POSTS A NOTICE TO THE TOPIC. Those
// notices resolve the story for a Telegram user and used to resolve nothing
// at all for an MCP caller, which sat out the full ten-minute wait and was
// then told the turn might still be running -- about a turn that was never
// started, or a message that was dropped outright. A no-op when nobody is
// parked, which is every Telegram-driven prompt.
function stranded(key, reason) {
  const n = mcp?.failWaitersFor(key, reason) ?? 0;
  if (n) console.error(`[bridge] told ${n} parked MCP caller(s) on ${key}: ${reason}`);
}

async function enqueuePrompt(threadId, promptText, noticeText) {
  const queue = store.getQueue(threadId);
  if (queue.length >= cfg.maxQueuePerTopic) {
    await tg.sendMessage({
      chatId: chatOf(threadId),
      messageThreadId: threadOf(threadId),
      text: `⚠️ Queue for this topic is full (${cfg.maxQueuePerTopic}) — this message was dropped. /stop to cancel the running turn.`,
    });
    const why = `this conversation's queue is full (${cfg.maxQueuePerTopic}), so the message was DROPPED, not queued. Nothing will answer it. Wait for the running turn to finish, or stop it`;
    stranded(threadId, why);
    return why;
  }
  const last = queue[queue.length - 1];
  if (last && Date.now() - (last.at ?? 0) < cfg.inputMergeMs) {
    last.text += `\n\n${promptText}`;
    last.at = Date.now();
    store.setQueue(threadId, queue);
    refreshTopicStatusForQueue(threadId);
    return null;
  }
  // MCP-only: no "📥 Queued" notice to post -- the queue itself (persistence,
  // merging, drain order) is transport-independent and still works; the
  // queued item just carries a null placeholder, which drainQueue handles.
  const notice = telegramEnabled()
    ? await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: noticeText })
    : { message_id: null };
  store.setQueue(threadId, [...queue, { text: promptText, placeholderMessageId: notice.message_id, at: Date.now() }]);
  refreshTopicStatusForQueue(threadId);
  return null;
}

// Everything that happens AFTER a prompt is composed (merge window closed):
// drain-check, session resolution, /stop handling, queueing, placeholder,
// turn start. Split out of handleMessage so the merge window can hand it
// one combined prompt -- and so live-typed messages and debounced bursts
// flow through the exact same code path.
//
// Returns null when the prompt is in the agent's hands (a turn started, or
// the message durably queued behind one), or a human-readable reason when it
// is not -- the same sentence stranded() gives a parked waiter, returned so
// message_send can fail its caller instead of acking a prompt it dropped.
// Callers that don't care (handleMessage, the merge window, and drainQueue
// via startTurn) ignore the value.
async function dispatchUserPrompt(threadId, promptText, command) {
  // A redeploy is draining: don't start anything new (getOrCreateSession
  // below can itself call session/create, work an about-to-restart process
  // has no way to see through to completion). /stop and /cancel are exempt
  // since they only ever stop something -- letting them fall through to the
  // ordinary busy-check below is simpler than duplicating that logic here.
  if (draining && command !== 'stop' && command !== 'cancel') {
    const queue = store.getQueue(threadId);
    if (queue.length >= cfg.maxQueuePerTopic) {
      if (telegramEnabled()) {
        await tg.sendMessage({
          chatId: chatOf(threadId),
          messageThreadId: threadOf(threadId),
          text: `⚠️ Queue for this topic is full (${cfg.maxQueuePerTopic}) — this message was dropped. Try again once the bridge is back.`,
        });
      }
      const why = `this conversation's queue is full (${cfg.maxQueuePerTopic}) and the bridge is restarting, so the message was DROPPED, not queued. Nothing will answer it. Send it again once the bridge is back`;
      stranded(threadId, why);
      return why;
    }
    return enqueuePrompt(threadId, promptText, `📥 Queued (position ${queue.length + 1}) — the bridge is deploying an update and will run this once it's back (usually a few seconds).`);
  }

  let session;
  try {
    session = await getOrCreateSession(threadId);
  } catch (e) {
    // Without this, a failure here (e.g. session/create rejecting) is
    // completely silent to the user: message sent, nothing ever happens,
    // only a server-side log line. The per-update catch in main() logs it
    // but was never going to tell them anything.
    console.error(`[bridge] topic ${threadId}: failed to get/create session:`, e);
    if (telegramEnabled()) {
      await tg
        .sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: `⚠️ Couldn't start a session: ${e.message}` })
        .catch((sendErr) => console.error('[bridge] failed to post session-creation failure notice:', sendErr.message));
    }
    const why = `the agent session could not be started, so this message was never delivered to a model: ${e.message}`;
    stranded(threadId, why);
    return why;
  }
  let sessionId = session.sessionId;

  if (busySessions.has(sessionId)) {
    if (command === 'stop' || command === 'cancel') {
      // HARD stop: abort the turn AND kill what it is currently executing
      // (see interruptTurn above, and killLocalToolProcesses in
      // bridge/backend.js, for why cancel() alone is not "immediate" from
      // the user's side). Background tasks are killed too -- a
      // user-initiated stop means stop EVERYTHING.
      await interruptTurn(sessionId, { killEverything: true });
      const turn = activeTurns.get(sessionId);
      busySessions.delete(sessionId);
      activeTurns.delete(sessionId);
      turn?.streamer?.stop();
      turn?.progress?.stop();
      updateTopicStatus(threadId, 'idle').catch(() => {});
      const queued = store.getQueue(threadId).length;
      const label = `🛑 Cancelled.${queued ? ` ${queued} queued message(s) will run next.` : ''}`;
      if (turn && turnLiveMessageId(turn)) {
        await tg.editMessageText({ chatId: chatOf(threadId), messageId: turnLiveMessageId(turn), text: label }).catch((e) => console.error('[bridge] failed to edit cancelled placeholder:', e.message));
      } else {
        await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: label });
      }
      void drainQueue(threadId);
      return;
    }

    // Busy + ordinary message: queue it. The notice we post becomes the
    // turn's placeholder when the message is dequeued, so the reply lands on
    // the message the user already saw accepted. Rapid consecutive parts
    // merge into the newest entry (Telegram split-message defense). The
    // reason-or-null contract carries a full-queue drop back to the caller.
    return enqueuePrompt(threadId, promptText, `📥 Queued (position ${store.getQueue(threadId).length + 1}) — runs when the current message finishes. /clearqueue to drop.`);
  }

  if (command === 'stop' || command === 'cancel') {
    await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: 'Nothing is running in this topic.' });
    return;
  }

  // MCP-only: no ⌛ placeholder to post -- startTurn runs with a null
  // placeholder and delivers through the MCP reply log alone.
  const placeholder = telegramEnabled()
    ? await tg.sendMessage({ chatId: chatOf(threadId), messageThreadId: threadOf(threadId), text: '⌛ …' })
    : { message_id: null };
  return startTurn(threadId, session, promptText, placeholder.message_id);
}

// Attaches the turn's progress view, per cfg.streamProgress: the milestone
// reporter (bridge/progress.js) or the classic streaming preview
// (bridge/streamer.js). Exactly one of turn.progress / turn.streamer is set.
// THE PARAMETER IS A CONVERSATION KEY; THE VIEWS WANT A TELEGRAM THREAD ID.
// Those are not the same value and were being passed as if they were: chatOf()
// parses the key correctly, and then the very same variable went on to
// ProgressReporter as `threadId`, which sends it verbatim as message_thread_id.
// A key reads "c-100…:t12" -- Telegram cannot parse that as an integer, drops
// it, and the message lands in the group's General topic instead of the
// session's own. Measured on a live fleet: progress and milestone posts from
// subagent turns arriving in #General while ordinary replies (which go through
// threadOf()) landed correctly.
//
// It is invisible on a fleet whose configured chat IS the forum group, because
// keyFor() then returns a bare numeric string that happens to be a valid thread
// id. Only a fleet whose TELEGRAM_CHAT_ID is something else -- a DM, a stale id
// -- takes the "c<chat>:t<thread>" form and shows the bug.
function attachTurnView(turn, { placeholderMessageId, threadId }) {
  // MCP-only: the progress views exist to post Telegram messages; without a
  // transport the turn simply has no view (turn.progress/turn.streamer stay
  // unset -- every consumer already treats them as optional) and delivery is
  // finalizeTurn's MCP reply log alone.
  if (!telegramEnabled()) return;
  const common = { tg, chatId: chatOf(threadId), threadId: threadOf(threadId), minEditIntervalMs: cfg.streamEditIntervalMs };
  if (cfg.streamProgress === 'messages') {
    turn.progress = new ProgressReporter({ ...common, seedMessageId: placeholderMessageId, editIntervalMs: cfg.streamEditIntervalMs });
  } else if (cfg.streamProgress !== 'off') {
    turn.streamer = new ReplyStreamer({ ...common, messageId: placeholderMessageId, heartbeatMs: cfg.streamHeartbeatMs });
  }
}

// The message id currently representing a live turn (for /stop labels,
// drain notifications): in milestone mode the newest milestone message,
// otherwise the placeholder.
function turnLiveMessageId(turn) {
  return turn?.progress?.currentMessageId() ?? turn?.placeholderMessageId ?? null;
}

// Send one turn's prompt to its session and own every failure path of the
// send -- including the one-shot fresh-session retry for the known zcode
// "resumed session rejects sends" quirk (see getOrCreateSession). Split out
// of handleMessage so the queue drain starts turns through the exact same
// code path a live-typed message takes.
//
// Same reason-or-null contract as dispatchUserPrompt: null once session/send
// has accepted the prompt (the turn owns delivery from here), the reason
// when the prompt was never handed to the model.
async function startTurn(threadId, session, text, placeholderMessageId) {
  const sessionId = session.sessionId;
  busySessions.add(sessionId);
  const turn = {
    placeholderMessageId,
    textBuffer: '',
    startedAt: Date.now(),
    toolNames: new Map(), // toolCallId -> toolName (result events don't repeat the name)
  };
  attachTurnView(turn, { placeholderMessageId, threadId });
  activeTurns.set(sessionId, turn);
  updateTopicStatus(threadId, 'busy').catch(() => {});

  try {
    await backendForSession(sessionId).sendMessage(sessionId, text);
    return null; // accepted -- the normal event-driven flow takes it from here
  } catch (e) {
    // sendMessage itself rejecting outright (as opposed to the turn later
    // completing with status "failed") is a different failure mode --
    // finalizeTurn() is never reached for it, so without this catch
    // busySessions/activeTurns for this session would stay set for the
    // rest of the process's life and the topic would be stuck on the
    // placeholder forever. (In practice this call site is effectively
    // unreachable for zcode's -32010 "already running": the busySessions
    // guard above and main()'s strictly-sequential per-update processing
    // already prevent two concurrent sends on the same session within one
    // process. This catch remains as a backstop for whatever else could
    // make the send itself reject, e.g. the backend's subprocess dying
    // mid-call.)
    busySessions.delete(sessionId);
    activeTurns.delete(sessionId);
    turn.streamer?.stop();
    turn.progress?.stop();
    updateTopicStatus(threadId, 'idle').catch(() => {});

    if (session.resumed) {
      // This retry is generic (any backend, any reason a resumed session's
      // first send might reject) -- but the failure mode it was built for is
      // zcode-specific and documented in bridge/backends/zcodeBackend.js:
      // a cold-resumed session can report resume AND subscribe as
      // successful, yet still reject the first send with "the historical
      // task's model is no longer available", and nothing short of a fresh
      // session unsticks it (confirmed by direct testing -- see git
      // history). Rather than leave the topic permanently broken, fall back
      // once to a fresh session (conversation history is lost) and retry
      // this same message before giving up.
      console.error(`[bridge] topic ${threadId}: send failed on a resumed session, retrying once with a fresh session (history lost):`, e.message);
      let freshSessionId;
      try {
        const fresh = await getOrCreateSession(threadId, { forceFresh: true });
        freshSessionId = fresh.sessionId;
        busySessions.add(freshSessionId);
        const freshTurn = {
          placeholderMessageId,
          textBuffer: '',
          startedAt: Date.now(),
          toolNames: new Map(),
        };
        attachTurnView(freshTurn, { placeholderMessageId, threadId });
        activeTurns.set(freshSessionId, freshTurn);
        await backendForSession(freshSessionId).sendMessage(freshSessionId, text);
        return; // retry accepted -- the normal event-driven flow takes it from here
        return null; // retry accepted -- the normal event-driven flow takes it from here
      } catch (retryErr) {
        // Clears the FRESH session's routing state -- the original
        // sessionId was already cleared above. (The pre-queue version of
        // this path cleared the original id twice and never the fresh one,
        // leaving the fresh session in busySessions forever: a latent
        // topic-wedging bug this restructure fixes.) Stopping the fresh
        // turn's streamer/progress here matters for the same reason: once
        // it's out of activeTurns nothing else will ever stop it, and the
        // heartbeat timer runs unconditionally from construction.
        if (freshSessionId) {
          busySessions.delete(freshSessionId);
          const freshTurn = activeTurns.get(freshSessionId);
          activeTurns.delete(freshSessionId);
          // Stop the fresh turn's views explicitly -- they're no longer
          // reachable through activeTurns for anything else to stop, and
          // since the heartbeat timer (added 2026-09-01) runs
          // unconditionally from construction, an unstopped one would keep
          // firing forever and periodically clobber the "Failed to send"
          // notice below with a stale re-render of a turn that never
          // actually started.
          freshTurn?.streamer?.stop();
          freshTurn?.progress?.stop();
        }
        console.error(`[bridge] topic ${threadId}: retry with a fresh session also failed:`, retryErr);
        e = retryErr;
      }
    }

    // BEFORE THE TELEGRAM EDIT, NOT AFTER. That edit is a network round trip,
    // and on the path this most often fires for -- the runtime dying -- the
    // process is already counting down to exit behind it.
    const why = `the prompt could not be handed to the model, so this turn never ran and nothing will answer it: ${e.message}`;
    stranded(threadId, why);
    if (telegramEnabled()) {
      await tg
        .editMessageText({ chatId: chatOf(threadId), messageId: placeholderMessageId, text: `⚠️ Failed to send: ${e.message}` })
        .catch((editErr) => console.error('[bridge] failed to edit failure notice:', editErr.message));
    }
    // The message behind this failed one doesn't deserve to wait forever
    // just because its predecessor's send was rejected.
    void drainQueue(threadId);
    return why;
  }
}

// Runs the next queued message for a topic, if any -- called from every path
// that marks a topic's session not-busy (turn finished, failed, cancelled,
// watchdog-timed-out, send rejected), and once at startup for queues
// restored from disk. Callers `void` it: draining must never block the
// delivery of the outcome the user is currently reading.
async function drainQueue(threadId) {
  // A turn ending during a drain window must not be replaced by a fresh
  // one -- see shutdown()'s waitForDrain, which polls activeTurns.size to
  // know when it's safe to restart. The queued item stays queued; it runs
  // after the next boot picks it up (drainQueue also runs once at startup
  // for exactly this reason).
  if (draining) return;
  const queue = store.getQueue(threadId);
  if (!queue.length) return;
  const [next, ...rest] = queue;
  store.setQueue(threadId, rest);

  let session;
  try {
    session = await getOrCreateSession(threadId);
  } catch (e) {
    console.error(`[bridge] topic ${threadId}: failed to get/create session for a queued message:`, e);
    if (telegramEnabled()) {
      await tg
        .editMessageText({ chatId: chatOf(threadId), messageId: next.placeholderMessageId, text: `⚠️ Couldn't start a session: ${e.message}` })
        .catch(() => {});
    }
    stranded(threadId, `this message reached the front of the queue and the agent session could not be started, so nothing will answer it: ${e.message}`);
    await drainQueue(threadId); // give the one behind it the same chance
    return;
  }
  if (busySessions.has(session.sessionId)) {
    // Only reachable if something re-busied the session between the turn
    // ending and this drain. Put the item back at the front rather than
    // risk a concurrent session/send (-32010).
    store.setQueue(threadId, [next, ...store.getQueue(threadId)]);
    return;
  }
  if (telegramEnabled()) {
    await tg
      .editMessageText({ chatId: chatOf(threadId), messageId: next.placeholderMessageId, text: '⌛ …' })
      .catch((e) => console.error('[bridge] failed to promote queued notice to placeholder:', e.message));
  }
  await startTurn(threadId, session, next.text, next.placeholderMessageId);
}

async function handleCallbackQuery(cq) {
  if (cq.from?.id !== cfg.allowedUserId) {
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Not authorized.', showAlert: true });
    return;
  }
  if (cq.message?.chat?.id !== cfg.chatId) {
    // Mirrors handleMessage's chat_id check. Not currently exploitable
    // (callback tokens are unguessable 48-bit random values, minted only
    // when a permission prompt is sent to cfg.chatId, and Telegram doesn't
    // carry inline keyboards across forwards to another chat) but there's
    // no reason for this check to be asymmetric with handleMessage's.
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Not authorized.', showAlert: true });
    return;
  }
  const token = cq.data;
  const requestId = tokenToRequestId.get(token);
  // 'u_' tokens are AskUserQuestion taps; 'p_' tokens permission prompts.
  if (token?.startsWith('u_')) {
    const input = requestId && pendingUserInputs.get(requestId);
    if (!input) {
      if (cq.message) {
        await tg.editMessageText({ chatId: cq.message.chat.id, messageId: cq.message.message_id, text: '⚠️ Expired.', replyMarkup: { inline_keyboard: [] } }).catch(() => {});
      }
      await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'This question already expired.' });
      return;
    }
    const choice = input.tokenToChoice.get(token);
    if (!choice) {
      await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Unknown option.' });
      return;
    }
    const label = handleUserInputTap(requestId, token, choice);
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: label || 'Recorded' });
    return;
  }
  const pending = requestId && pendingPermissions.get(requestId);
  if (!pending) {
    // Not tracked (already resolved, timed out, or -- for anything sent
    // before the orphan-cleanup/reply_markup fixes existed -- simply never
    // tracked at all). Either way, Telegram hands us the original message on
    // every callback_query regardless of our own state, so we can still
    // clear its now-meaningless buttons right here rather than leave them
    // clickable forever.
    if (cq.message) {
      await tg
        .editMessageText({ chatId: cq.message.chat.id, messageId: cq.message.message_id, text: '⚠️ Expired.', replyMarkup: { inline_keyboard: [] } })
        .catch(() => {}); // best-effort; e.g. text may already be identical if two clicks race
    }
    await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: 'This request already expired.' });
    return;
  }
  const response = pending.tokenMap.get(token);
  const label = response?.decision === 'deny' ? '❌ Denied' : `✅ ${response?.decision ?? 'resolved'}`;
  finishPermission(requestId, response, `${label} by you.`);
  await tg.answerCallbackQuery({ callbackQueryId: cq.id, text: label });
}

// --- main poll loop ---
async function main() {
  console.log(`[bridge] starting. chat=${cfg.chatId} workspace=${cfg.workspaceDir} model=${cfg.defaultModel}`);
  // THE MCP-ONLY BOOT LINE, and the only announcement the mode gets (its
  // legibility is the point -- shared-group design section 6): no token
  // means no Telegram transport, so nothing below may construct one, poll,
  // or post -- zcode/codex are reachable as MCPs and nothing else.
  if (!telegramEnabled()) {
    console.log('[bridge] MCP-only: no Telegram transport configured (TELEGRAM_BOT_TOKEN absent)');
  }

  // THE MCP GATEWAY: lets a second model running on the same host (inside
  // the same agent) drive these conversations over loopback, with every
  // prompt and reply mirrored into the Telegram chat from the bot's
  // identity. The production transport is a PER-FLEET UNIX SOCKET
  // (MCP_UNIX_SOCKET) whose file permissions are the authentication; the
  // TCP listener is a test/dev convenience, off unless MCP_HTTP_PORT is set.
  if (cfg.mcpUnixSocket || cfg.mcpHttpPort != null) {
    mcp = createMcpGateway({
      port: cfg.mcpHttpPort ?? null,
      unixSocket: cfg.mcpUnixSocket,
      host: process.env.MCP_BIND || '127.0.0.1',
      codexMcpModels: CODEX_MCP_MODELS, // the schemas advertise exactly what validateMcpModel enforces
      log: (m) => console.log(`[bridge] ${m}`),
    });
    mcp.wire({
      sessionCreate: async (name, chatIdNum, backendName, modelArg) => {
        const backend = backendName || cfg.defaultBackend;
        if (!KNOWN_BACKENDS.includes(backend)) throw new Error(`unknown backend: ${backend} (known: ${KNOWN_BACKENDS.join(', ')})`);
        getBackend(backend); // fail early (e.g. Codex misconfigured) before creating a Telegram topic for it
        // MODEL IS OTHERWISE STILL LOCKED DOWN, JUST LOOSENED FOR CODEX: zcode
        // keeps the original "no MCP-switchable model at all" rule (refuses a
        // model argument outright rather than silently ignoring it, which
        // would read as accepted); Codex gets a real, but bounded, choice
        // among its three everyday tiers -- see CODEX_MCP_MODELS. Sol and
        // Luna both cost real usage the same as Terra does, so nothing here
        // is "free" to pick; what's refused is specifically Astra, Codex's
        // newest and most expensive model, and any bare model that could
        // resolve to it (only the four exact refs in this map are ever
        // accepted, not arbitrary strings that pattern-match).
        const model = validateMcpModel(backend, modelArg);
        // MCP-ONLY (shared-group design section 6): no transport means no
        // forum chat to pick and no topic to create. The key is a synthetic
        // `m<N>` (see mintMcpOnlySessionKey), the backend session is created
        // exactly as today, and the caller is told `telegram: false` so it
        // knows replies come through replies_get / this tool's wait alone.
        // An explicit chat_id names a Telegram chat, which cannot exist
        // here -- refuse rather than silently ignore it.
        if (!telegramEnabled()) {
          if (chatIdNum != null) throw new Error('session_create: chat_id names a Telegram chat, but this bridge runs MCP-only (no Telegram transport configured)');
          const key = mintMcpOnlySessionKey();
          // `threadId: key` -- the store's threadId field holds the RAW
          // Telegram thread for real topics; for a topic-less session the
          // conversation key is the closest truth, and it is what
          // model_set's workspaceKey derivation reads.
          store.setTopic(key, { name, backend, model, mode: cfg.defaultSessionMode, threadId: key });
          await getOrCreateSession(key);
          const entry = store.getTopic(key);
          return { key, model: entry.model, backend, telegram: false };
        }
        // No chat_id: auto-pick. The old default was the configured home
        // chat, unconditionally -- which turned a stale TELEGRAM_CHAT_ID
        // into Telegram's "the chat is not a forum" (2026-09-10 cage-pod
        // failure). Now the bridge picks the best forum it actually knows:
        // Topics enabled, bot-admin preferred, most recently used first.
        let chatId = chatIdNum;
        let autoPicked = false;
        if (chatId == null) {
          const winner = await pickDefaultForumChat();
          chatId = winner.chatId;
          autoPicked = true;
        }
        const created = await tg.createForumTopic({ chatId, name });
        store.noteChat(chatId, { lastSeenAt: Date.now() }); // a successful create is the strongest "we serve this chat"
        const threadId = created.message_thread_id;
        const key = keyFor(chatId, threadId);
        store.setTopic(key, { chatId, threadId, name, backend, model, mode: cfg.defaultSessionMode });
        await getOrCreateSession(key);
        const entry = store.getTopic(key);
        return { key, chat_id: chatId, thread_id: threadId, model: entry.model, backend, auto_picked: autoPicked };
      },
      sessionClose: async (key) => {
        const t = store.getTopic(key) ?? {};
        // MCP-only: there is no topic to close -- the session itself is the
        // whole lifecycle, and marking it closed is what replies_get and
        // message_send key off.
        if (telegramEnabled()) await tg.closeForumTopic({ chatId: chatOf(key), messageThreadId: Number(t.threadId) }).catch(() => {});
        store.setTopic(key, { closed: true });
        return { ok: true };
      },
      messageSend: async (key, text, wait) => {
        // Mirror the prompt into the topic (the bot's identity, per the MCP
        // contract), then dispatch through the SAME pipeline a Telegram
        // message uses: queue/deploy-drain semantics, session creation, the
        // turn, and the reply delivered back to the topic by the ordinary
        // reply flow.
        //
        // THE MIRROR IS A SIDE EFFECT; THE AGENT TURN IS THE POINT. Measured
        // live (2026-09-12): a burst of message_sends 429'd the mirror
        // sendMessage, and since it was awaited before anything else, the
        // whole tool call failed -- the prompt never reached any agent. So
        // the mirror is best-effort now: sendMessage already retries within
        // its 429 budget, and past that a dropped mirror costs one log line,
        // never the prompt.
        if (store.getTopic(key)?.closed) throw new Error(`session ${key} is closed`);
        // MCP-only: the mirror IS the skipped part (silently -- it is
        // best-effort even in Telegram mode); the prompt goes to the agent
        // and the reply comes back through this tool's wait / replies_get.
        if (telegramEnabled()) {
          try {
            await tg.sendMessage({ chatId: chatOf(key), messageThreadId: threadOf(key), text });
          } catch (e) {
            console.error(`[bridge] message_send: prompt mirror into ${key} dropped (delivering to the agent anyway): ${e.message}`);
          }
        }
        if (!wait) {
          // queued:true is a promise that the agent has the prompt. The
          // dispatch returns WHY NOT when the message was dropped or its
          // turn could not be started -- surface that as the tool error
          // instead of a lying ack that leaves the caller waiting on a
          // reply that will never come.
          const notDelivered = await dispatchUserPrompt(key, text);
          if (notDelivered) throw new Error(notDelivered);
          return { queued: true, key };
        }
        // Register the waiter BEFORE dispatching: finalizeTurn's noteReply
        // fires the moment the turn lands, which can beat a waiter
        // registered only after dispatch resolves.
        const pending = mcp.waitReply(key);
        try {
          // RACED, NOT SEQUENCED -- see raceReply. Awaiting the dispatch first
          // and the waiter second means a waiter FAILED by failWaiters (the
          // runtime died, the bridge is restarting) cannot be reported until
          // the dispatch has finished unwinding, which on that exact path
          // includes a Telegram round trip while the process is already
          // counting down to exit.
          const reply = await raceReply(pending, dispatchUserPrompt(key, text));
          return { reply: reply.text, at: reply.at };
        } catch (e) {
          pending.catch(() => {}); // an abandoned waiter must not go unhandled
          throw e;
        }
      },
      // The key guard lives here (repliesForTopic): unknown and closed keys
      // are errors, not a hollow [] a caller reads as "quiet session".
      repliesGet: (key, afterSeq) => repliesForTopic({ getTopic: (k) => store.getTopic(k), repliesSince: (k, s) => mcp.repliesSince(k, s), key, afterSeq }),
      // The liveness probe: working vs wedged, from the same activity log
      // the Telegram progress views are fed (see bridge/progress.js).
      progressGet: (key) => progressForTopic({ getTopic: (k) => store.getTopic(k), activeTurns, key }),
      // Now backend-aware: a session can run zcode or Codex, and reporting
      // just "the model" without which backend it's on is no longer the
      // whole answer (the same model NAME could plausibly exist under two
      // providers). `key` is optional for backward compatibility with a
      // caller that predates backend choice -- omitted, this reports the
      // bridge's own defaults, same as before this tool learned about a
      // second backend.
      modelGet: (key) => {
        const entry = key ? store.getTopic(key) : null;
        if (key && !entry) throw new Error(`unknown session: ${key}`);
        const backend = entry?.backend || cfg.defaultBackend;
        const model = entry?.model || defaultModelFor(backend);
        return { backend, model, switchable: backend === 'codex' };
      },
      // Mirrors the Telegram /model command's own switch path (store the new
      // model, invalidate any per-workspace cache, push it to the live
      // session if one is already subscribed) but through validateMcpModel's
      // narrower allowlist instead of /model's "anything listModels() names".
      modelSet: async (key, modelArg) => {
        const entry = store.getTopic(key);
        if (!entry) throw new Error(`unknown session: ${key}`);
        const backend = entry.backend || cfg.defaultBackend;
        const model = validateMcpModel(backend, modelArg);
        if (model === undefined) throw new Error('model is required for model_set');
        store.setTopic(key, { ...entry, model });
        const b = getBackend(backend);
        // Same workspaceKey shape /model's own switch path uses (see its
        // `tg-topic-${threadId}` above) -- NOT the MCP `key` itself, which
        // is a different string (keyFor's composite chat/thread encoding).
        b.invalidateModelCache?.(`tg-topic-${entry.threadId}`);
        if (entry.sessionId && subscribedSessions.has(entry.sessionId)) {
          await b.setModel(entry.sessionId, model);
        }
        return { backend, model, switchable: true };
      },
      usageGet: () => usageGetForMcp(),
    });
    // A failed listener (socket bind, chmod) must be LOUD: a silently dead
    // MCP endpoint inside a healthy-looking bridge is exactly how this went
    // unnoticed for days (2026-09-10 handout). Telegram keeps serving; the
    // MCP gateway is dropped so noteReply/waitReply skip cleanly.
    mcp.ready.catch((e) => {
      console.error(`[bridge] MCP gateway failed to start: ${e.message} -- the junior-agent MCP is DEAD while Telegram continues`);
      mcp = null;
    });
  }
  restoreTopicStatuses();
  refreshUsagePercentages(); // warm the selected usage cache so the first status write has figures
  if (telegramEnabled()) {
    // Warm the own-identity cache too: a suffixed command arriving before getMe
    // answers is dropped as not-ours (never assumed ours), so the answer should
    // be in hand well before the first owner message. Fire-and-forget -- a getMe
    // failure costs the username, never the boot; the next ensureBotUserId
    // call retries it.
    ensureBotSelf().catch((e) => console.error('[bridge] getMe failed (suffixed commands stay unclaimed until it answers):', e.message));
    await cleanupOrphanedPermissionRequests();

    // Command autocomplete: idempotent, safe on every boot. The chat scope is
    // the one forum group this bridge serves (so the list shows exactly there);
    // the default scope covers a 1:1 chat with the bot. Failure is logged and
    // non-fatal -- the commands still work typed out in full.
    try {
      await tg.setMyCommands({ commands: BOT_COMMANDS, scope: { type: 'chat', chat_id: cfg.chatId } });
      await tg.setMyCommands({ commands: BOT_COMMANDS });
    } catch (e) {
      console.error('[bridge] setMyCommands failed (no / autocomplete; commands still work):', e.message);
    }
  }

  // Queues persisted by a previous process instance: their "📥 Queued"
  // Telegram messages are still sitting in their topics -- resume draining.
  // This also picks up whatever got queued during the previous process's
  // graceful shutdown drain (see shutdown()/draining in this file) -- those
  // messages were deliberately never started, precisely so they'd run here,
  // once, cleanly, instead of being started and then killed.
  // (A message whose turn was killed MID-FLIGHT by an UNplanned death --
  // crash, OOM, SIGKILL -- is in no queue and is simply gone; its
  // placeholder stays "⌛" forever. Known gap, listed in README's known
  // issues. Does not apply to an ordinary SIGTERM/SIGINT redeploy anymore.)
  const restoredQueues = store.getQueues();
  const restoredThreadIds = Object.keys(restoredQueues);
  if (restoredThreadIds.length) {
    console.log(`[bridge] restoring queues: ${restoredThreadIds.map((t) => `topic ${t} (${restoredQueues[t].length})`).join(', ')}`);
    for (const threadId of restoredThreadIds) await drainQueue(threadId);
  }

  // MCP-only stops here: with no transport there is nothing to poll, and
  // main() returning leaves the process alive on the MCP listener (and any
  // backend subprocesses). The loop below is the only getUpdates there is.
  if (!telegramEnabled()) return;

  let offset = store.getOffset();
  for (;;) {
    let updates;
    try {
      updates = await tg.getUpdates({ offset, timeout: 30 });
    } catch (e) {
      console.error('[bridge] getUpdates failed, retrying in 5s:', e.message, '— cause:', e.cause?.code || e.cause?.message || '(none)');
      await sleep(5000);
      continue;
    }
    for (const update of updates) {
      try {
        if (update.my_chat_member) handleMyChatMember(update.my_chat_member);
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallbackQuery(update.callback_query);
      } catch (e) {
        console.error('[bridge] error handling update:', e);
      }
      // Persist per-update, not once per batch: if the process dies partway
      // through a batch, only the update actually in flight gets redelivered
      // and reprocessed on restart, not everything already handled before it.
      offset = update.update_id + 1;
      try {
        store.setOffset(offset);
      } catch (e) {
        // Unlike the try/catch around message handling two lines up, a
        // failure here (e.g. a transient disk write error) used to be
        // completely unguarded and would propagate all the way out of
        // main(), taking down the whole process over what could be one
        // transient write failure -- inconsistent with the deliberate
        // catch-and-continue policy for everything else in this loop.
        console.error('[bridge] failed to persist update offset (will retry next update):', e.message);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});
