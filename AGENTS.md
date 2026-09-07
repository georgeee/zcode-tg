# zcode-tg — agent notes

This file exists because `bridge/backends/codexBackend.js` in this very
repo can run Codex sessions against this repo's own workspace (see
`ZCODE_WORKSPACE_DIR` in `CLAUDE.md`) — Codex CLI and other tools follow
the `AGENTS.md` convention, not `CLAUDE.md`. **`CLAUDE.md` is the canonical,
maintained reference; this file is a thin pointer to it, not a fork.** If
you're an agent (Codex or otherwise) working on this repo and only read one
file, read `CLAUDE.md` — its content applies regardless of which agent CLI
is doing the reading. `README.md` is the full reference behind both.

The one thing worth restating here rather than just pointing at: **if
you're Codex, reading this because you're running inside a session this
bridge itself created (a Telegram topic on the `codex` backend), you are
the thing under test, not just a tool working on the code.** Be extra
careful editing `bridge/backends/codexBackend.js` and `bridge/codexClient.js`
from inside such a session — a bug you introduce there can affect the very
process driving your own turn.
