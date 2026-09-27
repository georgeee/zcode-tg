// Telegram command parsing and @-addressing, as pure functions. index.js
// exports nothing, so this file is the testable seam for both.

// '/usage arg'        -> { name: 'usage', suffix: null }
// '/usage@SomeBot arg' -> { name: 'usage', suffix: 'SomeBot' }
// Anything that isn't a command (no leading '/', a bare '/', no boundary)
// -> null. Only the bridge's OWN command names are acted on by the caller;
// anything else starting with '/' (zcode's /init, /memo, ...) passes through
// to the model as ordinary input.
export function parseCommandText(text) {
  const m = String(text ?? '').match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/);
  return m ? { name: m[1].toLowerCase(), suffix: m[2] ?? null } : null;
}

// Is a parsed command addressed to US? The predicate behind the @-suffix
// comparison (shared-group design, section 1: in a group with more than one
// bot, a command carrying @somename belongs to somename or nobody):
//   no suffix          -> ours -- the whole pre-shared-group world, unchanged
//   suffix == username -> ours, case-insensitively (Telegram usernames are)
//   anything else      -> not ours, INCLUDING an unknown own username: until
//                         getMe has answered, a suffixed command is never
//                         assumed ours.
export function commandIsOurs(suffix, ownUsername) {
  if (suffix == null) return true;
  if (!ownUsername) return false;
  return suffix.toLowerCase() === String(ownUsername).toLowerCase();
}

// The proxied-mode refusal (relay-owned-group design, section 4: "what the
// bridge must still refuse, in proxied mode"). When TELEGRAM_API_ROOT is a
// unix: root (cfg.proxied), a relay stands in for Telegram and a topic's
// provider is FIXED by its fleet/model binding -- the agent behind the topic
// holds one provider's credential -- so a switch to another backend would
// move the conversation to a provider the relay's binding does not name,
// and the relay would keep filing the messages under the old agent: a
// divergence nothing downstream catches. One comparison decides, on the
// triple both surfaces present:
//
//   proxied            -- cfg.proxied
//   topicBackend       -- the backend the topic runs on now
//   otherBackend       -- the backend the command would land on (/backend's
//                         argument; /model's resolveModelRef answer)
//
// Returns null = allow (send nothing, fall through): not proxied -- today's
// behavior byte for byte, cross-backend switch included -- or the switch
// does not actually cross backends (within-backend switches stay legal and
// stay invisible to the relay). The non-null answer is THE reply both
// /backend and the cross-backend /model send, verbatim: one function so the
// two surfaces cannot drift, and the sentence always names the provider the
// user was reaching for.
export function proxiedBackendSwitchRefusal(proxied, topicBackend, otherBackend) {
  if (!proxied || otherBackend === topicBackend) return null;
  return `⚠️ this topic's provider is fixed by its fleet/model binding; create a topic for ${otherBackend} instead`;
}
