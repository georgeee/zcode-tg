{
  description = "zcode-tg: Telegram bridge for zcode (one forum topic = one zcode session), plus the zcode CLI runtime it drives";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in
        rec {
          zcode = pkgs.callPackage ./nix/zcode.nix { };
          zcode-tg = pkgs.callPackage ./nix/zcode-tg.nix {
            inherit zcode;
            src = self;
          };
          default = zcode-tg;
        });

      apps = forAllSystems (system: {
        default = self.apps.${system}.zcode-tg;
        zcode-tg = {
          type = "app";
          program = "${self.packages.${system}.zcode-tg}/bin/zcode-tg";
        };
        zcode = {
          type = "app";
          program = "${self.packages.${system}.zcode}/bin/zcode";
        };
      });

      # Consumed the same way agent-cage consumes claude-code-nix:
      #   inputs.zcode-tg-flake.url = "github:georgeee/zcode-tg";
      #   inputs.zcode-tg-flake.inputs.nixpkgs.follows = "nixpkgs";
      #   ... overlays = [ zcode-tg-flake.overlays.default ];
      #   ... buildEnv { paths = [ zcode-tg zcode ]; }
      # (Do not name the input `zcode-tg` as a function argument -- see the
      # shadowing note in agent-cage's flake.nix; alias it zcode-tg-flake.)
      overlays.default = final: _prev: {
        zcode = final.callPackage ./nix/zcode.nix { };
        zcode-tg = final.callPackage ./nix/zcode-tg.nix {
          zcode = final.zcode;
          src = self;
        };
      };

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system}; in
        {
          # The bridge has zero npm dependencies -- a shell with Node is the
          # whole toolchain. Node >= 22.19 (package.json engines).
          default = pkgs.mkShellNoCC { packages = [ pkgs.nodejs_22 ]; };
        });
    };
}
