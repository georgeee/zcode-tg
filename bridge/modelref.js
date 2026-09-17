// Pure helpers for the cross-backend /model command: merging per-backend
// model lists into one listing, and resolving a user-typed ref to the
// {backend, ref} pair it names. PLAIN DATA IN, PLAIN DATA OUT -- the Telegram
// handler assembles {backend: [models]} maps from real listModels() calls and
// renders/acts on the resolver's answer; these functions know nothing about
// backends, sessions, or Telegram, which is what makes them unit-testable
// without a bridge boot (see test/modelref.test.js).
//
// WHY THE RESOLVER REFUSES TO GUESS. A bare ref that exists in more than one
// backend's list is refused rather than resolved to "whichever backend the
// topic already runs" -- the live bug recorded at bridge/index.js's
// getOrCreateSession (a Codex model string forced onto a zcode session is a
// real API rejection, caught in testing) is exactly what "apply the model to
// the topic's CURRENT backend by default" produces. The resolver's answer
// ALWAYS carries the backend the ref was found in, and the caller applies the
// pair together, never the ref alone.

// mergeModelLists(lists, backendOrder?) -> [{backend, ref, label?, contextWindow?}]
//
// Flattens {backend: [models]} into one array ordered by backendOrder (the
// bridge passes KNOWN_BACKENDS so the grouping is stable across invocations;
// sorted keys otherwise), then by each list's own order. A backend whose
// listModels() failed simply has no key in `lists` and contributes nothing
// -- the caller reports it as its own one-line note.
export function mergeModelLists(lists, backendOrder) {
  const order = backendOrder ?? Object.keys(lists).sort();
  const out = [];
  for (const backend of order) {
    for (const m of lists[backend] ?? []) {
      out.push({ backend, ref: m.ref, label: m.label, contextWindow: m.contextWindow });
    }
  }
  return out;
}

// qualifyModelRef(backend, ref) -> "backend:ref" -- the form that resolves
// unambiguously even when the bare ref exists on two backends. The split is
// on the FIRST colon; backend names never contain one, model refs may.
export function qualifyModelRef(backend, ref) {
  return `${backend}:${ref}`;
}

// resolveModelRef(input, lists) -> {backend, ref}; throws a user-facing
// Error (the message becomes the Telegram reply) on:
//   - a qualified form naming an unknown backend,
//   - a qualified form whose ref that backend does not offer,
//   - a bare ref no backend offers,
//   - a bare ref offered by more than one backend (the message names every
//     backend that has it and points at the qualified form).
export function resolveModelRef(input, lists) {
  const colon = input.indexOf(':');
  if (colon > 0) {
    const backend = input.slice(0, colon);
    const ref = input.slice(colon + 1);
    if (!Object.prototype.hasOwnProperty.call(lists, backend)) {
      throw new Error(`unknown backend "${backend}" (known: ${Object.keys(lists).join(', ')})`);
    }
    if (!lists[backend].some((m) => m.ref === ref)) {
      throw new Error(`unknown model "${ref}" on backend "${backend}". /model with no argument lists what's available.`);
    }
    return { backend, ref };
  }

  const matches = Object.keys(lists).filter((b) => (lists[b] ?? []).some((m) => m.ref === input));
  if (matches.length === 0) {
    throw new Error(`unknown model "${input}". /model with no argument lists what's available.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `model "${input}" is offered by more than one backend (${matches.join(', ')}); ` +
        `use the qualified form backend:model, e.g. ${qualifyModelRef(matches[0], input)}`,
    );
  }
  return { backend: matches[0], ref: input };
}
