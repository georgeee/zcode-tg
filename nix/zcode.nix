# The zcode CLI runtime, packaged straight from the published npm tarball.
#
# The tarball is complete as shipped and needs NO `npm install` (which is
# broken upstream for this package anyway): bin/zcode.js is a dependency-free
# launcher, and everything else -- the app-server runtime bundle and the TUI
# -- is vendored under vendor/. Confirmed by running app-server from the bare
# unpacked tarball with the top-level node_modules deleted: fully functional,
# clean stderr.
#
# Versions are pinned deliberately, not auto-updated: the bridge is written
# against observed protocol behavior of a specific runtime, and zcode can
# change that behavior in any release. Bumping = change `version` and
# `hash` below (get the hash with `nix store prefetch-file
# https://registry.npmjs.org/zcode-app-cli/-/zcode-app-cli-<version>.tgz`
# or `nix-prefetch-url <same>`), then re-verify the bridge against the new
# runtime before deploying it anywhere.
{ lib, stdenv, nodejs_22, fetchurl, makeWrapper }:

stdenv.mkDerivation rec {
  pname = "zcode";
  version = "3.10.2-18";

  src = fetchurl {
    url = "https://registry.npmjs.org/zcode-app-cli/-/zcode-app-cli-${version}.tgz";
    sha256 = "37e90b514b1c4cfb9ae087426c0e7817dc9edd72e17b8f0384b59efc2e524c2e";
  };

  nodejs = nodejs_22;

  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/zcode-app-cli
    tar -xzf $src -C $out/lib/zcode-app-cli --strip-components=1
    makeWrapper ${lib.getExe nodejs} $out/bin/zcode \
      --add-flags "$out/lib/zcode-app-cli/bin/zcode.js" \
      --set ZCODE_DISABLE_UPDATE_CHECK 1 \
      --set NO_UPDATE_NOTIFIER 1
    runHook postInstall
  '';

  meta = {
    description = "Z.ai zcode coding-agent CLI runtime (drives app-server mode)";
    mainProgram = "zcode";
    platforms = lib.platforms.unix;
  };
}
