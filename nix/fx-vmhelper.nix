# NixOS module `services.fx-vmhelper`: the root helper of the local runner's microVM sandboxes (D#587 B-2a).
# It only describes the service; nothing applies it to a host. The unit text comes from ./fx-vmhelper-unit.nix, which reads the
# same hardening.json as the Go and TypeScript renderers, so no hardening value is written here.
{ config, lib, pkgs, ... }:
let
  cfg = config.services.fx-vmhelper;
  pinned = builtins.fromJSON (builtins.readFile ../packages/fx-runner/vmhelper/internal/hardening/hardening.json);
  group = "fx-vmhelper";
  configPath = "/etc/fx-vmhelper/config.json";
  # Looked up so that a missing user or an empty primary group reaches the assertions below, not an evaluation error.
  runner = lib.attrByPath [ cfg.runnerUser ] { uid = null; group = ""; } config.users.users;
  runnerGid = if runner.group == "" then null else lib.attrByPath [ runner.group "gid" ] null config.users.groups;
  unitText = import ./fx-vmhelper-unit.nix {
    inherit pinned group configPath;
    helperPath = cfg.helperPath;
    jailRoot = cfg.jailRoot;
    snapshotDir = cfg.snapshotDir;
  };
  inherit (lib) mkOption mkEnableOption mkIf types;
  required = description: type: mkOption { inherit description type; };
in
{
  options.services.fx-vmhelper = {
    enable = mkEnableOption "fx-vmhelper, the root helper that starts the runner's microVM sandboxes";
    runnerUser = required "The user that runs the local runner. It is the only uid the helper serves; it joins the ${group} group." types.str;
    jailRoot = mkOption { type = types.str; default = "/var/lib/fx-vm"; description = "The one directory every sandbox jail lives under."; };
    snapshotDir = mkOption { type = types.str; default = "/var/lib/fx-vm-snapshots"; description = "Where snapshots are stored (guest memory, so root-owned 0700). Outside jailRoot and not holding it."; };
    uidFirst = required "First uid of the sandbox range (100000 or above, free in passwd, subuid and getent)." types.ints.unsigned;
    uidCount = required "How many uids the sandbox range holds (at least maxSandboxes)." types.ints.positive;
    gidFirst = required "First gid of the sandbox range." types.ints.unsigned;
    gidCount = required "How many gids the sandbox range holds (at least maxSandboxes)." types.ints.positive;
    maxSandboxes = required "How many sandboxes may be prepared at once." types.ints.positive;
    maxVcpus = required "The per-sandbox vCPU ceiling." types.ints.positive;
    maxMemMb = required "The per-sandbox memory ceiling, in MB." types.ints.positive;
    helperPath = required "Absolute path of the helper binary, in a root-owned chain with no symlink." types.str;
    jailerPath = required "Absolute path of the pinned jailer." types.str;
    firecrackerPath = required "Absolute path of the pinned Firecracker." types.str;
    templateManifestPath = required "Absolute path of the root-owned template manifest." types.str;
    templateDir = required "Absolute path of the root-owned directory of template files." types.str;
    capabilities = mkOption {
      type = types.listOf types.str;
      readOnly = true;
      default = map (c: c.name) pinned.capabilities;
      description = "The capability bounding set. It is pinned by hardening.json and cannot be changed here.";
    };
    unitText = mkOption { type = types.str; readOnly = true; internal = true; default = unitText; description = "The generated unit text."; };
  };

  config = mkIf cfg.enable {
    assertions = [
      # The same three-way test as config.Parse: snapshot_dir is not jail_root, not below it and does not hold it.
      { assertion = cfg.snapshotDir != cfg.jailRoot && !(lib.hasPrefix "${cfg.jailRoot}/" cfg.snapshotDir) && !(lib.hasPrefix "${cfg.snapshotDir}/" cfg.jailRoot); message = "services.fx-vmhelper.snapshotDir must be outside jailRoot and must not hold it."; }
      { assertion = runner.uid != null && runner.uid != 0; message = "services.fx-vmhelper.runnerUser needs a fixed, non-zero uid (users.users.<name>.uid)."; }
      { assertion = runner.group != ""; message = "services.fx-vmhelper.runnerUser has no primary group: set users.users.<name>.group to a group with a fixed gid."; }
      { assertion = runnerGid != null && runnerGid != 0; message = "services.fx-vmhelper.runnerUser's primary group needs a fixed, non-zero gid (users.groups.<name>.gid)."; }
    ];
    users.groups.${group} = { };
    users.users.${cfg.runnerUser}.extraGroups = [ group ];
    # A non-symlink entry: the helper opens its config with O_NOFOLLOW and wants a root-owned regular file.
    environment.etc."fx-vmhelper/config.json" = {
      mode = "0444";
      user = "root";
      group = "root";
      text = builtins.toJSON {
        jail_root = cfg.jailRoot;
        runner_uid = runner.uid;
        runner_gid = runnerGid;
        uid_first = cfg.uidFirst;
        uid_count = cfg.uidCount;
        gid_first = cfg.gidFirst;
        gid_count = cfg.gidCount;
        max_sandboxes = cfg.maxSandboxes;
        max_vcpus = cfg.maxVcpus;
        max_mem_mb = cfg.maxMemMb;
        jailer_path = cfg.jailerPath;
        firecracker_path = cfg.firecrackerPath;
        template_manifest_path = cfg.templateManifestPath;
        template_dir = cfg.templateDir;
        snapshot_dir = cfg.snapshotDir;
      };
    };
    # The jail root is root 0711, the mode the helper requires of it (the same value the install plan writes). systemd makes the unit's
    # own state and runtime directories; the helper makes everything below the jail root.
    systemd.tmpfiles.rules = [ "d ${cfg.jailRoot} 0711 root root -" "d ${cfg.snapshotDir} 0700 root root -" ];
    systemd.packages = [ (pkgs.writeTextDir "etc/systemd/system/fx-vmhelper.service" unitText) ];
    systemd.services.fx-vmhelper.wantedBy = [ "multi-user.target" ];
  };
}
