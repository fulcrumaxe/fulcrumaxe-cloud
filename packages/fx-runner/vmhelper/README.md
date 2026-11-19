# fx-vmhelper

The root service behind the local runner's Firecracker microVM sandboxes (runner v2). Go, standard
library only. Linux only.

This directory holds the protocol, the server, the sandbox registry (`internal/sandbox`: id allocation, the jail
and vsock directories with their permissions, start-up reaping) and the real launcher
(`internal/sandbox/launcher.go`): `start` runs the pinned jailer, which builds the chroot, puts Firecracker in its
own cgroup below this unit's `vms` subtree and drops to the sandbox's uid and gid.

## Launch

- The process is started with `os/exec` from an argument list (no shell) built from validated values, with an
  empty environment. The id is two elements, `--id` and `<id>`: the jailer's parser takes the value after a flag
  and has no `--flag=value` form, so `--id=<id>` is refused by the jailer itself. The id pattern forbids a
  leading dash, and the launcher refuses one again.
- The jailer and Firecracker come from `jailer_path` and `firecracker_path` in the root config. At start-up and at
  every launch each path must be a regular executable that only root can change, reached through directories
  only root can change, with no symlink on the way.
- The jail directory is handed to root (mode stays 0700) just before the launch, through an `O_PATH`
  descriptor: the helper's own file operations run without `CAP_DAC_OVERRIDE`, so it cannot open a directory
  that belongs to the sandbox uid.
- Capabilities. The pinned set is `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_SETGID`, `CAP_SETUID`, `CAP_SYS_ADMIN`
  and `CAP_MKNOD`. `CAP_DAC_OVERRIDE` is for the jailer: the jailer chowns the chroot root to the sandbox uid
  (0700) and then creates `/dev` and more inside it, which root cannot do without it. The helper holds it
  permitted and inheritable and not effective: `serve` drops it from the effective set of every thread
  first, before anything else, and the start-up check reads the status of the process and of each thread.
  Exactly two operations raise it, through `hardening.WithCaps` on one locked thread and no other: the dial of
  the Firecracker API socket and the handover of `v.sock` (a test lists the callers). Both open their last
  path component `O_PATH|O_NOFOLLOW`, check type and owner on the descriptor and act through
  `/proc/self/fd/N`. If the thread's set cannot be restored the helper exits at once with one fatal line.
  What this does and does not do: it keeps the helper's other file operations from ever running with the
  override (a bug in them fails instead of reaching through permissions). It does not stop the jailer from
  having it: an exec at euid 0 gets the whole bounding set whatever the parent's effective set was, so the
  jailer child runs with the override until it drops to the sandbox uid, as Firecracker's supported production
  setup has it run as root. The launcher also puts it in the child's ambient set (`SysProcAttr.AmbientCaps`);
  that is redundant today and is kept so the child keeps it if the exec ever stops getting the bounding set
  by being root. A compromised helper could raise the capability again, so none of this is a boundary against
  a compromised helper.
- Before the launch, `start` stages `<jail>/<exec name>/<id>/root/{kernel,rootfs,vsock}`. The files are copies
  from `template_dir/<template>/<kind>`, opened through the same root-owned-chain check as the binaries and
  hashed while copied against the root-owned manifest at `template_manifest_path` (`{id: {kernel, rootfs}}`
  with sha256 digests, written by the install from the signed release metadata; the helper only reads it, at
  every prepare and start). A template id the manifest lacks answers `unknown_template`; a mismatch or any
  other failure removes everything staged and answers `internal`. The vsock directory is bind-mounted
  (`nosuid,nodev,noexec`) on `vsock` by descriptor: `open_tree` + `move_mount`, or, on a kernel before 5.2,
  `mount(2)` on two `/proc/self/fd` links (the only reason for the fallback). Destroy and start-up reaping
  unmount it first and delete nothing while it is mounted.
- A start or destroy reserves its sandbox id; the registry lock is never held across a launch, so `list` and
  other ids do not wait.
- `memory.max` is the guest's memory plus 256 MiB for Firecracker itself; `cpu.max` is `vcpus * 100000 / 100000`.
- A launch succeeds only when `/proc/<pid>/status` shows all four uids and gids equal to the sandbox's and no
  supplementary group (the jailer clears them before it execs Firecracker; the helper checks the result).
- Destroy writes `1` to the sandbox's `cgroup.kill`, waits for the process and for the cgroup to empty, removes
  the cgroup, then removes the directories: each directory is taken back to root with `fchownat`
  (`AT_SYMLINK_NOFOLLOW`) before it is opened and emptied, so no capability beyond `CAP_CHOWN` is needed.
  Directory modes are set before the owner is changed (a chmod after the chown would need `CAP_FOWNER`).
- At start-up the helper moves itself into `<unit>/helper`, enables `cpu` and `memory` for the unit and for
  `<unit>/vms`, and kills and removes any sandbox cgroup left there by an earlier run.
- Not in this change: the template copy and hash, the Firecracker configuration (boot source, drives, the vsock
  device) and the path by which the daemon reaches the API socket, and making the vsock directory visible inside
  the jail.

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
uid, group `sandbox_gid` (from the reply), mode `01770` (sticky), no ACL. All later access goes through `openat` on the
returned descriptor, never through the path again.

| path | mode | owner |
|---|---|---|
| `<jail_root>` | 0711 | root:root |
| `<jail_root>/jails` | 0700 | root:root |
| `<jail_root>/jails/<id>` | 0700 | sandbox uid:gid |
| `<jail_root>/vsock` | 0711 | root:root |
| `<jail_root>/vsock/<id>` | 01770 | runner uid : sandbox gid |
| `<jail_root>/vsock/<id>/v.sock` (made by Firecracker, then handed over by the helper) | 0700 | runner uid : sandbox gid |
| `<jail_root>/vsock/<id>/v.sock_<port>` (runner-side listeners, made by the runner) | runner's | runner uid |

The sandbox's own uid reaches its directory through the group's `rwx` bits (Firecracker, running as that uid, makes `v.sock` there); the sticky bit stops it deleting or renaming the runner's own files. Another sandbox has no bits at all; the runner (the owner) can list its own directories. The jail root is 0711 rather than 0700 so that the
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

After the capability drop, and before it reads the config, the helper checks `/proc/self/status`: `CapEff` is the
pinned set without the jailer-only capability, `CapPrm` and `CapBnd` are the whole set, `CapInh` is the jailer-only
capability, `CapAmb` is empty, `NoNewPrivs` is 1 and `Seccomp` is 2. Any difference is one fatal line and exit 1.

## Socket lifetime

The listener never unlinks its socket on close: it is bound through a descriptor path that no longer
means the same directory after start-up. A stale socket is replaced (after an lstat and owner check) by
the next start, and systemd removes the runtime directory when the unit stops.

## Pinned values

`internal/hardening/hardening.json` is the one file of unit hardening values and capabilities (each with
its reason). A directive may hold a list (`DeviceAllow` is `/dev/kvm rwm`, `/dev/net/tun m` and
`/dev/userfaultfd m`: the jailer makes those nodes inside each jail and fails the launch if a mknod is refused,
and only `/dev/kvm` may be opened). The unit generator (`hardening.RenderUnit`), the start-up capability check and the tests read
it; so will the NixOS module.

## Build

Build with `CGO_ENABLED=0` (the module is standard library only). The capability drop changes every thread with
`syscall.AllThreadsSyscall`, which Go refuses in a cgo binary; the helper then stops with one fatal line.

## Test

    cd packages/fx-runner/vmhelper && go vet ./... && go test ./...

`scripts/check.sh` runs the same when `packages/fx-runner` is affected. Nothing here needs root. The one
real-permission test (`TestRealRootPermissions`, a real chown and real uid switch) and `TestRealJailer` (the real jailer and Firecracker)
run only with `FX_VMHELPER_REAL_ROOT=1` as root. `.github/workflows/vmhelper-real-root.yml` runs the second inside a
systemd service that carries the pinned properties.
