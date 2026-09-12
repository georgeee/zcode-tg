// The runtime preferences the zcode app-server asks its CLIENT for, over the
// server-initiated request `session/requestRuntimePreferences`.
//
// WHY THE BRIDGE ANSWERS THIS AT ALL. Until it did, zcodeClient's blanket
// "unregistered method" reply was the answer -- and that reply is JSON-RPC
// -32601, which is one of the two codes the app-server treats as "this client
// is too old to ask", falling back to its own hardcoded defaults. Read out of
// the vendored bundle (zcode-3.10.2-18, vendor/zcode.cjs):
//
//	catch(o){ if(o.code===-32601||o.code===-32020)
//	  return {..., nativeSearchEnhancementsEnabled:!0}; throw o }
//
// So not implementing this method is not neutral: it silently selects
// nativeSearchEnhancementsEnabled, and that one flag is what makes the
// runtime write a per-session bash prelude --
// `bash-startup/<session>/embedded-search-startup-<hash>.sh`, which shadows
// find/grep with bfs/ugrep -- at mode 0600, and then `source` it at the head
// of EVERY bash tool call.
//
// THAT FILE IS UNREADABLE WHEREVER COMMANDS RUN AS A DIFFERENT ACCOUNT FROM
// THE AGENT. agent-cage's privilege split is the case in hand: the file
// belongs to the agent, every shell command runs as the executor, and
// `source` needs read permission. The result is one line before every
// command's real output, for ever:
//
//	/bin/bash: line 1: .../embedded-search-startup-<hash>.sh: Permission denied
//
// It is cosmetic -- the prelude only swaps find/grep for faster equivalents,
// each with a built-in fallback to the plain tool -- and it cannot be fixed
// from the outside: the runtime passes mode 0600 to writeFileSync AND
// re-asserts it with chmodSync immediately after, so no umask helps, and a
// POSIX ACL does not survive that chmod either (measured: chmod rewrites the
// ACL mask from the group bits, and 0600's group bits are zero, so a
// named-user grant comes back `#effective:---`).
//
// DEFAULT ON, DELIBERATELY. A standalone deployment -- one account, agent and
// shell the same uid -- reads that file perfectly well and genuinely profits
// from bfs/ugrep. The deployment that provably cannot use it is the one that
// should say so, rather than this file assuming nobody can.
export function runtimePreferences(env = process.env) {
  return {
    nativeSearchEnhancementsEnabled: env.NATIVE_SEARCH_ENHANCEMENTS !== 'false',
  };
}
