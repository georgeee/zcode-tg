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
