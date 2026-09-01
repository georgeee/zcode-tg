# The zcode-tg Telegram bridge. Zero npm dependencies; the package is the
# repo's own bridge/ sources plus a wrapper that wires the two runtime
# locations that MUST NOT live in the read-only nix store:
#   - STORE_PATH (data/sessions.json by default in-repo) -> ~/.local/state
#   - ZCODE_BIN / ZCODE_NODE_BIN -> the packaged zcode and node, as DEFAULTS
#     only (a real environment always wins, so a deployment can point the
#     bridge at a different runtime without rebuilding).
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
    mkdir -p $out/lib/zcode-tg
    cp -r $src/bridge $out/lib/zcode-tg/bridge
    cp $src/package.json $out/lib/zcode-tg/package.json
    install -m 0755 ${./zcode-tg.in.sh} $out/bin/zcode-tg
    substituteInPlace $out/bin/zcode-tg \
      --subst-var-by node ${lib.getExe nodejs} \
      --subst-var-by zcode ${lib.getExe zcode} \
      --subst-var-by libdir "$out/lib/zcode-tg"
    runHook postInstall
  '';

  meta = {
    description = "Telegram bridge for zcode: one forum topic = one zcode session";
    mainProgram = "zcode-tg";
    platforms = lib.platforms.unix;
  };
}
