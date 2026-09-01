#!/bin/sh
# Runtime wrapper for zcode-tg (installed by nix/zcode-tg.nix).
# All defaults use :- so a real environment always wins.
set -eu

: "${ZCODE_NODE_BIN:=@node@}"
: "${ZCODE_BIN:=@zcode@}"
: "${STORE_PATH:=$HOME/.local/state/zcode-tg/sessions.json}"
export ZCODE_NODE_BIN ZCODE_BIN STORE_PATH

# The bridge's store (topic<->session map, update offset, queues) is durable
# state and must live outside the read-only nix store.
mkdir -p -- "$(dirname -- "$STORE_PATH")"

exec @node@ @libdir@/bridge/index.js "$@"
