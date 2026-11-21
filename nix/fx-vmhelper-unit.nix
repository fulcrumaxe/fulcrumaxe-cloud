# The systemd unit text of fx-vmhelper, built from the one pinned file (hardening.json) with nothing but builtins, so a test can
# evaluate it without nixpkgs. It is the Nix twin of hardening.Pinned.RenderUnit (Go) and renderUnit (TypeScript): the golden
# files under packages/fx-runner/vmhelper/internal/hardening/testdata are written by the Go one and compared with this text.
# No directive, capability, directory or mode is written in this file; every one comes from `pinned`.
{ pinned, helperPath, configPath, jailRoot, snapshotDir, group ? "" }:
let
  join = builtins.concatStringsSep;
  # A token may not carry a character that could add a directive (the Go safeToken's set), and a path must be clean and absolute.
  safeToken = s: builtins.match "[^ \t\r\n%\"'\\\\$;[:cntrl:]]+" s != null;
  safePath = s:
    safeToken s
    && builtins.match "(/[^/]+)+" s != null
    && !(builtins.elem "." (builtins.filter builtins.isString (builtins.split "/" s)))
    && !(builtins.elem ".." (builtins.filter builtins.isString (builtins.split "/" s)));
  checked =
    if safePath helperPath && safePath configPath && safePath jailRoot && safePath snapshotDir && (group == "" || safeToken group)
    then true
    else throw "unit parameters must be clean absolute paths and a plain group name";
  directiveLines = k:
    let v = pinned.directives.${k};
    in map (line: "${k}=${line}\n") (if builtins.isList v then v else [ v ]);
in
assert checked;
# No User= line: a system unit runs as root without one, and with User=root written out systemd 255 starts the helper with a reduced effective set.
"[Unit]\nDescription=fx-vmhelper: root service for the local runner's microVM sandboxes\nAfter=local-fs.target\n\n[Service]\nType=simple\n"
+ (if group != "" then "Group=${group}\n" else "")
+ "ExecStart=${helperPath} -config ${configPath}\nRestart=on-failure\n"
+ "RuntimeDirectory=${pinned.runtime_directory}\nRuntimeDirectoryMode=${pinned.runtime_directory_mode}\n"
+ "StateDirectory=${pinned.state_directory}\nStateDirectoryMode=${pinned.state_directory_mode}\n"
+ "ReadWritePaths=${join " " (pinned.read_write_paths ++ [ jailRoot snapshotDir ])}\n"
+ "CapabilityBoundingSet=${join " " (map (c: c.name) pinned.capabilities)}\n"
+ join "" (map (k: join "" (directiveLines k)) (builtins.attrNames pinned.directives))
+ "\n[Install]\nWantedBy=multi-user.target\n"
