# The zcode-tg Telegram bridge. Zero npm dependencies; the package is the
# repo's own bridge/ sources plus a wrapper that wires the two runtime
# locations that MUST NOT live in the read-only nix store:
#   - STORE_PATH (data/sessions.json by default in-repo) -> ~/.local/state
#   - ZCODE_BIN / ZCODE_NODE_BIN -> the packaged zcode and node, as DEFAULTS
#     only (a real environment always wins, so a deployment can point the
#     bridge at a different runtime without rebuilding).
# NOTE on the ZCODE_BIN default below: the bridge spawns the runtime as
# `node <ZCODE_BIN> app-server` -- the value must be the JavaScript ENTRY
# (bin/zcode.js inside the zcode package), never the package's bin/zcode
# wrapper, which is a shell script; node handed a shell script dies at boot
# with `SyntaxError: Unexpected token 'export'` and the bridge restart-loops.
# Deployments that set ZCODE_BIN themselves must point it at the .js for the
# same reason.
#
# Telegram credentials come from ~/.config/zcode-tg/.env (see README) and
# are never baked in.
{ lib, stdenv, nodejs_22, zcode, src }:

let nodejs = nodejs_22; in
stdenv.mkDerivation {
  pname = "zcode-tg";
  version = "0.1.0";

  inherit src;

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/zcode-tg $out/bin
    cp -r $src/bridge $out/lib/zcode-tg/bridge
    cp $src/package.json $out/lib/zcode-tg/package.json
    install -m 0755 ${./zcode-tg.in.sh} $out/bin/zcode-tg
    substituteInPlace $out/bin/zcode-tg \
      --subst-var-by node ${lib.getExe nodejs} \
      --subst-var-by zcode ${zcode}/lib/zcode-app-cli/bin/zcode.js \
      --subst-var-by libdir "$out/lib/zcode-tg"
    runHook postInstall
  '';

  meta = {
    description = "Telegram bridge for zcode: one forum topic = one zcode session";
    mainProgram = "zcode-tg";
    platforms = lib.platforms.unix;
  };
}
