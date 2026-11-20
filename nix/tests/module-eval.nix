# Evaluates services.fx-vmhelper inside a real NixOS evaluation (no build, nothing applied to any host):
#
#   nix eval --impure --json --file nix/tests/module-eval.nix
#
# The result's `unit` must equal packages/fx-runner/vmhelper/internal/hardening/testdata/with-group.unit for the same parameters
# (nixModule.test.ts compares the pure unit function with those goldens; this file proves the module wires it in).
let
  flake = builtins.getFlake (toString ../..);
  sys = flake.inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      ../fx-vmhelper.nix
      ({ ... }: {
        boot.loader.grub.enable = false;
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        system.stateVersion = "25.05";
        users.groups.runner.gid = 1000;
        users.users.runner = { isNormalUser = true; uid = 1000; group = if builtins.getEnv "FX_EMPTY_GROUP" == "1" then "" else "runner"; };
        services.fx-vmhelper = {
          enable = true;
          runnerUser = "runner";
          uidFirst = 165536;
          uidCount = 8;
          gidFirst = 165536;
          gidCount = 8;
          maxSandboxes = 8;
          maxVcpus = 4;
          maxMemMb = 4096;
          helperPath = "/opt/fx-vmhelper/bin/fx-vmhelper";
          jailerPath = "/opt/fx-vmhelper/bin/jailer";
          firecrackerPath = "/opt/fx-vmhelper/bin/firecracker";
          templateManifestPath = "/opt/fx-vmhelper/template-manifest.json";
          templateDir = "/opt/fx-vmhelper/templates";
          # FX_SNAPSHOT_DIR lets a test try a bad snapshot directory.
          snapshotDir = let s = builtins.getEnv "FX_SNAPSHOT_DIR"; in if s == "" then "/var/lib/fx-vm-snapshots" else s;
        };
      })
    ];
  };
in
{
  unit = sys.config.services.fx-vmhelper.unitText;
  config = builtins.fromJSON sys.config.environment.etc."fx-vmhelper/config.json".text;
  extraGroups = sys.config.users.users.runner.extraGroups;
  capabilities = sys.config.services.fx-vmhelper.capabilities;
  # Evaluating the system's derivation path fails when any assertion fails (nothing is built).
  # It is asked for with FX_TOPLEVEL=1, so the other attributes can be read from a configuration that fails an assertion.
  toplevelDrv = if builtins.getEnv "FX_TOPLEVEL" == "1" then sys.config.system.build.toplevel.drvPath else null;
  tmpfiles =sys.config.systemd.tmpfiles.rules;
  assertionMessages = map (a: a.message) (builtins.filter (a: !a.assertion) sys.config.assertions);
}
