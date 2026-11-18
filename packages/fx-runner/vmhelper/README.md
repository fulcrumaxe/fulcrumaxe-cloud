# fx-vmhelper

The root service behind the local runner's Firecracker microVM sandboxes (runner v2). Go, standard
library only. Linux only.

This directory holds the protocol, the server and the sandbox registry (`internal/sandbox`): id allocation,
the jail and vsock directories with their permissions, and start-up reaping. The real jailer launch,
cgroups and uid/gid drop are a separate change: `start` drives a `Launcher`, and this build's launcher
answers `unavailable`.

## Protocol

One request per line: a JSON object, then `\n`, at most 4096 bytes including the newline. One response
line per request. Verbs and their only fields:

| verb | fields |
|---|---|
| `prepare` | `sandbox_id`, `template`, `vcpus`, `mem_mb` |
| `start`, `destroy` | `sandbox_id` |
| `list` | none |

Ids match `^[a-z0-9][a-z0-9-]{0,39}$` (no leading dash, so an id can never be read as an option). Integers are plain digits. Duplicate keys, `__proto__`, unknown fields,
nulls, booleans, arrays and nested objects are refused. A response is
`{"ok":true,"protocol":1,...}` or `{"ok":false,"protocol":1,"code":"<code>"}`; the code is from the
closed list in `internal/protocol`, and no input is ever echoed. A refused frame ends the connection.

## Replies and the vsock directory

`prepare` and `start` answer `{"ok":true,"protocol":1,"vsock_dir":"<abs path>","sandbox_gid":<gid>}`. A `list` entry is
`{"sandbox_id":..,"created":<unix seconds, omitted when unknown>,"vsock_dir":..,"sandbox_gid":..}`. These are additive fields of
protocol 1. The helper builds `vsock_dir` as `<jail_root>/vsock/<id>` from its root-owned config and the
validated id; a caller never supplies a path.

A consumer (the daemon, the egress proxy) must check the path before use. `sandbox.ValidateVsockDir` is the
lexical part (absolute, clean so no `..`, no NUL, basename equals the id). `sandbox.OpenVsockDir(policy, path, id,
sandbox_gid)` is the full one and returns the verified descriptor: the path must be exactly
`<jail_root>/vsock/<id>`; `jail_root` is opened one component at a time with `O_NOFOLLOW`; `jail_root` and `vsock`
must be `0711` with the policy's root owner and no ACL; `vsock/<id>` must be a real directory owned by the runner
uid, group `sandbox_gid` (from the reply), mode `0710`, no ACL. All later access goes through `openat` on the
returned descriptor, never through the path again.

| path | mode | owner |
|---|---|---|
| `<jail_root>` | 0711 | root:root |
| `<jail_root>/jails` | 0700 | root:root |
| `<jail_root>/jails/<id>` | 0700 | sandbox uid:gid |
| `<jail_root>/vsock` | 0711 | root:root |
| `<jail_root>/vsock/<id>` | 0710 | runner uid : sandbox gid |
| `<jail_root>/vsock/<id>/<uds>_<port>` (made by the launcher) | 0660 | runner uid : sandbox gid |

The sandbox's own uid reaches its directory through the group's `x` bit. Another sandbox has neither `x` nor
`r`; the runner (the owner) can list its own directories. The jail root is 0711 rather than 0700 so that the
runner can reach its vsock directory; the per-sandbox jail directories sit under the 0700 `jails` directory.
Each sandbox gets the lowest free uid and gid of the configured ranges; none free answers `over_cap`. The
registry is in memory only: at start-up `Reap` removes any entry in `jails` or `vsock` that is named like an id
and unowned (a symlink is unlinked, never followed), and leaves differently named entries alone.

## ACLs, mount points, removal

- **ACLs.** A default ACL on a parent is inherited by every directory made below it, and an access ACL grants
  named users and groups bits the mode does not show. Start-up refuses a `jail_root`, `jails` or `vsock` that
  carries `system.posix_acl_access` or `system.posix_acl_default`; each directory the helper creates is stripped
  of both (by descriptor, `ENODATA` is fine) before its owner and mode are set; and the owner and mode check
  (so `OpenVsockDir` too) fails on a directory that carries either. A probe error other than "not there" fails
  closed.
- **Mount points.** `st_dev` does not see a bind mount from the same filesystem. Removal and reaping open each
  directory with `openat2(RESOLVE_NO_XDEV|RESOLVE_NO_SYMLINKS)`; if the kernel or a seccomp filter refuses that
  call, they compare the `statx` mount id of the child with its parent's, and where neither tells they refuse.
  `st_dev` is compared as well. A mount point answers an error before anything below it is touched; `destroy`
  then answers `internal` and keeps the sandbox registered.
- **Depth.** Removal walks the tree iteratively with a descriptor per level, up to 2048 levels, so a guest that
  nests deep cannot make `destroy` fail for good at a small limit. Past the bound, or on any failure, `destroy`
  answers `internal`, the entry stays registered and its uid and gid stay allocated (the old jail directory
  is still owned by that uid, so it must not reach the next sandbox). The helper raises its soft descriptor
  limit to 8192 (within the hard limit) at start-up to cover the bound.
- **Id ranges.** The uid and gid ranges must end below 2^32-1; the allocator never reaches it. Start-up
  refuses a gid range that holds a group listed in `/etc/group` with members, since every member would hold
  that group's bits on a sandbox's directory, and a gid range that holds the primary group of any user in
  `/etc/passwd`. Only those two local files are read: users and groups that come from other NSS sources (LDAP,
  sssd, systemd-userdbd) are not visible to the helper, so a host that has them must keep the sandbox id ranges
  out of their id space (the installer is to check that). The next change must clear supplementary groups on
  the sandbox process.

## Who may connect

Only the uid the kernel reports for the connecting process (`SO_PEERCRED`) and only if it equals
`runner_uid` in the root-owned config. The socket file's mode and the caller's groups play no part. A frame
must complete in 5 s (an idle connection is cut at the same time) and 8 connections are served at once;
the ninth gets `too_busy`. A temporary `accept` error (out of descriptors, for example) is retried with a
back-off; any other ends the service.

## Config ranges

`runner_uid` and `runner_gid` are the runner's ids (neither is 0). The per-sandbox uid and gid ranges start
at 100000 or above, never hold 65534, never hold the runner's uid (uid range) or gid (gid range), and the
gid range must not hold the group of the socket directory or the helper's own gid (checked at start).

## Start-up self-check

Before it reads the config the helper checks `/proc/self/status`: `CapEff` and `CapBnd` equal the pinned
set, `CapAmb` is empty, `NoNewPrivs` is 1 and `Seccomp` is 2. Any difference is one fatal line and exit 1.

## Socket lifetime

The listener never unlinks its socket on close: it is bound through a descriptor path that no longer
means the same directory after start-up. A stale socket is replaced (after an lstat and owner check) by
the next start, and systemd removes the runtime directory when the unit stops.

## Pinned values

`internal/hardening/hardening.json` is the one file of unit hardening values and capabilities (each with
its reason). The unit generator (`hardening.RenderUnit`), the start-up capability check and the tests read
it; so will the NixOS module.

## Test

    cd packages/fx-runner/vmhelper && go vet ./... && go test ./...

`scripts/check.sh` runs the same when `packages/fx-runner` is affected. Nothing here needs root. The one
real-permission test (`TestRealRootPermissions`, a real chown and real uid switch) runs only with
`FX_VMHELPER_REAL_ROOT=1` as root; the real jailer, Firecracker and cgroup tests belong to the next change.
