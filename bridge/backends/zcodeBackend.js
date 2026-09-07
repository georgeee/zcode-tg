// The zcode Backend: wraps ZcodeClient (bridge/zcodeClient.js, the thin
// "ZCode Protocol" transport -- unchanged by this refactor) and everything
// that used to be zcode-specific free functions directly in bridge/index.js:
// the model-catalog warm-up + the resumed-session
// ZCODE_RUNTIME_MODEL_UNAVAILABLE workaround (see README's "Restart
// continuity" section -- this is THE zcode-intrinsic bug this backend exists
// to hide from the generic orchestration layer), the mode enum, and the
// /proc-based hard-kill of a session's in-flight tool processes.
//
// Everything here is a straight extraction, not a rewrite: every RPC call,
// every comment about a past bug, and every field name is unchanged from
// the pre-refactor bridge/index.js -- only the *shape* (a Backend subclass
// instead of free functions closed over module-level state) is new.

import { readdirSync, readFileSync } from 'node:fs';
import { Backend, makeSessionId, rawSessionId } from '../backend.js';
import { ZcodeClient } from '../zcodeClient.js';
import { readZaiProvider } from '../usage.js';

// The runtime's mode enum (observed against a live app-server). Only a sane
// subset is advertised in the /mode listing, but any enum value is accepted.
const MODES = ['default', 'plan', 'edit', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'autoEdit', 'build', 'yolo'];
const MODE_NOTES = {
  default: 'confirm risky tool calls',
  yolo: 'auto-approve everything (bridge default)',
  plan: 'read-only planning',
  edit: 'plan + apply edits',
};

function parseModelRef(ref) {
  const [providerId, modelId] = ref.split('/');
  return { providerId, modelId };
}

function processCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function collectTree(rootPid) {
  const children = new Map();
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[1]);
      if (Number.isFinite(ppid)) {
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(Number(pid));
      }
    } catch {}
  }
  const out = [];
  const walk = (p) => {
    out.push(p);
    for (const c of children.get(p) ?? []) walk(c);
  };
  walk(rootPid);
  return out;
}

export class ZcodeBackend extends Backend {
  constructor({ nodeBin, zcodeBin, cwd, zaiConfigPath }) {
    super('zcode');
    this.cwd = cwd;
    this.zaiConfigPath = zaiConfigPath;
    this.client = new ZcodeClient({ nodeBin, zcodeBin, cwd });
    // workspaceKey -> runtimeModel object, cached per process -- see
    // resumeConversation() for what this fixes and the two traps recorded
    // there.
    this._runtimeModelCache = new Map();

    // Pass through every raw protocol event, but rewrite params.sessionId to
    // our PREFIXED id first -- everything downstream (index.js's sessionId-
    // keyed Maps) expects the prefixed form uniformly across backends.
    this.client.on('event', (msg) => {
      const sessionId = msg.params?.sessionId;
      if (sessionId != null) {
        this.emit('event', { ...msg, params: { ...msg.params, sessionId: makeSessionId('zcode', sessionId) } });
      } else {
        this.emit('event', msg);
      }
    });
    this.client.on('exit', (info) => this.emit('exit', info));
    this.client.on('stderr', (text) => this.emit('stderr', text));
    this.client.on('parseError', (info) => this.emit('parseError', info));
  }

  async start() {
    this.client.start();
    return this;
  }

  async stop() {
    this.client.stop();
  }

  onPermissionRequest(handler) {
    // interaction/requestPermission's params ALREADY are the normalized
    // shape documented in backend.js ({sessionId, requestId, toolName,
    // riskLevel, reason, input, options: [{name, response:{decision,
    // permissionUpdates?}}]}) -- zcode's own protocol IS that contract. Only
    // the sessionId needs prefixing on the way in; the handler's return
    // value (one option's `response`, verbatim) is already what zcode's own
    // protocol expects back, so it needs no translation on the way out
    // either.
    this.client.onServerRequest('interaction/requestPermission', async (params) => {
      const normalized = { ...params, sessionId: makeSessionId('zcode', params.sessionId) };
      return handler(normalized);
    });
  }

  onUserInputRequest(handler) {
    this.client.onServerRequest('interaction/requestUserInput', async (params) => {
      const normalized = { ...params, sessionId: makeSessionId('zcode', params.sessionId) };
      return handler(normalized);
    });
  }

  async createConversation({ workspaceDir, workspaceKey, model, mode }) {
    const created = await this.client.call('session/create', {
      workspace: { workspacePath: workspaceDir, workspaceKey },
    });
    const rawId = created.session.sessionId;
    try {
      await this.client.call('session/setModel', { sessionId: rawId, model: parseModelRef(model) });
      await this.client.call('session/setMode', { sessionId: rawId, mode });
    } catch (e) {
      // Session exists server-side but we're about to throw before ever
      // recording it anywhere -- best-effort close it rather than leak an
      // abandoned, never-subscribed session on every retry of what might be
      // a persistent misconfiguration (e.g. a typo'd model ref this account
      // isn't entitled to).
      await this.client.call('session/close', { sessionId: rawId }).catch(() => {});
      throw e;
    }
    return { sessionId: makeSessionId('zcode', rawId), model, mode };
  }

  // --- workspace model-catalog warm-up + explicit runtimeModel (the actual
  // fix for resumed sends -- see README's "Restart continuity" section for
  // why warming the catalog ALONE, which this used to do, is not sufficient)
  // ---
  // A brand-new `zcode app-server` process starts with an EMPTY model
  // catalog for every workspace key: the per-workspace catalog is only ever
  // filled by `workspace/updateProviderRegistry`, which is part of the
  // desktop app's workspace-open flow -- a flow this bridge never runs.
  // Without it, `session/resume` (no runtimeModel param, persisted model not
  // in the catalog) takes its "deferred model adapter" path: resume reports
  // success, and every subsequent `session/send` on that session rejects
  // with ZCODE_RUNTIME_MODEL_UNAVAILABLE ("历史任务使用的模型已不可用").
  // session/setModel does NOT clear it.
  //
  // Two traps found empirically while building this, both costly to
  // discover, worth recording:
  // - The registry push must carry source:"user" -- the registry handler
  //   silently filters out pushes that claim source:"builtin".
  // - `runtimeModel.provider` must be OUR OWN provider object (the one we
  //   just pushed, which still has the real `apiKey`), not the one echoed
  //   back in updateProviderRegistry's response: the server converts our
  //   inline apiKey into an internal `apiKeyRef` pointer for its own
  //   bookkeeping, and (a) `apiKeyRef` isn't even a field runtimeModel.provider's
  //   schema accepts -- passing it verbatim is a validation error -- and
  //   (b) if you strip it without restoring a real `apiKey`, resume succeeds
  //   but the *next* send fails with "Model provider is missing an API key"
  //   -- a different, easy-to-mistake-for-progress failure mode.
  async _warmWorkspaceCatalog(workspaceDir, workspaceKey, modelRef) {
    const cached = this._runtimeModelCache.get(workspaceKey);
    if (cached) return cached;
    const workspace = { workspacePath: workspaceDir, workspaceKey };
    try {
      const state = await this.client.call('workspace/readState', { workspace });
      const models = state.modelCatalog?.providers?.find((p) => p.providerId === 'zai')?.models;
      const zai = readZaiProvider(this.zaiConfigPath);
      if (!models?.length) throw new Error('readState returned no zai models');
      const provider = {
        providerId: zai.providerId,
        kind: zai.kind,
        source: 'user',
        label: zai.label,
        baseURL: zai.baseURL,
        apiKey: { source: 'inline', value: zai.apiKey },
        models,
      };
      const res = await this.client.call('workspace/updateProviderRegistry', {
        workspace,
        registry: { revision: `bridge-warm-${Date.now()}`, generatedAt: Date.now(), providers: [provider] },
      });
      if (res.status !== 'applied' || res.providerCount < 1) throw new Error(`registry push not applied (status=${res.status}, providerCount=${res.providerCount})`);
      const runtimeModel = {
        revision: res.appliedProviderRevision,
        generatedAt: Date.now(),
        model: parseModelRef(modelRef),
        provider, // ours, not res.workspaceState's echoed version -- see comment above
      };
      this._runtimeModelCache.set(workspaceKey, runtimeModel);
      return runtimeModel;
    } catch (e) {
      // Not fatal: sends on resumed sessions may still fail with
      // ZCODE_RUNTIME_MODEL_UNAVAILABLE and the caller falls back to a fresh
      // session -- the pre-fix behavior, degraded but working.
      this.emit('warn', `failed to warm model catalog for workspace key ${workspaceKey} (resumed sessions may still fail): ${e.message}`);
      return null;
    }
  }

  // Drop a workspace's cached runtimeModel -- called when the topic's model
  // changes, so the next resume warms with the new one instead of resuming
  // against a runtimeModel built for the old one.
  invalidateModelCache(workspaceKey) {
    this._runtimeModelCache.delete(workspaceKey);
  }

  async resumeConversation(sessionId, { workspaceDir, workspaceKey, model }) {
    const rawId = rawSessionId(sessionId);
    const runtimeModel = await this._warmWorkspaceCatalog(workspaceDir, workspaceKey, model);
    await this.client.call('session/resume', {
      sessionId: rawId,
      // Both fields are required together for the fix to actually take:
      // runtimeModel is what bypasses the broken deferred-adapter check, but
      // the runtime still needs `workspace` on this same call to know which
      // workspace's (just-warmed) catalog to resolve it against.
      ...(runtimeModel ? { workspace: { workspacePath: workspaceDir, workspaceKey }, runtimeModel } : {}),
    });
    return { sessionId };
  }

  async subscribe(sessionId) {
    await this.client.call('session/subscribe', { sessionId: rawSessionId(sessionId), deliveryKind: 'web-remote-replayable' });
  }

  async sendMessage(sessionId, text) {
    await this.client.call('session/send', { sessionId: rawSessionId(sessionId), content: text });
  }

  async cancel(sessionId) {
    await this.client.call('session/stop', { sessionId: rawSessionId(sessionId) });
  }

  async closeConversation(sessionId) {
    await this.client.call('session/close', { sessionId: rawSessionId(sessionId) });
  }

  async cancelBackgroundTask(sessionId, taskId) {
    await this.client.call('session/cancelBackgroundTask', { sessionId: rawSessionId(sessionId), taskId });
  }

  async setModel(sessionId, model) {
    await this.client.call('session/setModel', { sessionId: rawSessionId(sessionId), model: parseModelRef(model) });
  }

  async setMode(sessionId, mode) {
    await this.client.call('session/setMode', { sessionId: rawSessionId(sessionId), mode });
  }

  async listModels({ workspaceDir, workspaceKey }) {
    const state = await this.client.call('workspace/readState', { workspace: { workspacePath: workspaceDir, workspaceKey } });
    const available = state.modelCatalog?.available ?? [];
    return available.map((m) => ({
      ref: `${m.ref.providerId}/${m.ref.modelId}`,
      label: m.label || m.ref.modelId,
      contextWindow: m.contextWindow,
    }));
  }

  listModes() {
    return MODES.map((name) => ({ name, note: MODE_NOTES[name] }));
  }

  // --- /stop is a HARD interrupt (owner ask 2026-09-06) ---
  // session/stop (cancel(), above) aborts the turn's AbortController, which
  // interrupts the model stream and FUTURE steps -- but a tool that is
  // EXECUTING right now (a blocking TaskOutput, a long bash) does not check
  // that signal, so the turn idles until the tool returns on its own. This
  // is the stronger stop: find every process whose command line embeds this
  // session's raw id (the shell-snapshot/bootstrap paths the runtime spawns
  // name sess_<id> on the bash command line) and kill the whole tree --
  // SIGTERM first, SIGKILL for stragglers -- so nothing is orphaned.
  killLocalToolProcesses(sessionId) {
    const rawId = rawSessionId(sessionId);
    try {
      for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
        const p = Number(pid);
        if (p === process.pid) continue;
        if (!processCmdline(pid).includes(rawId)) continue;
        const tree = collectTree(p);
        for (const t of tree) {
          try { process.kill(t, 'SIGTERM'); } catch {}
        }
        this.emit('warn', `/stop: SIGTERM ${tree.length} process(es) of session ${rawId} (root ${p})`);
        setTimeout(() => {
          for (const t of tree) {
            try { process.kill(t, 0); process.kill(t, 'SIGKILL'); } catch {}
          }
        }, 400).unref();
      }
    } catch (e) {
      this.emit('warn', `/stop: tool-process sweep failed: ${e.message}`);
    }
  }
}
