# fx-vmhelper

The root service behind the local runner's Firecracker microVM sandboxes (runner v2). Go, standard
library only. Linux only.

This directory holds the protocol and the server. The sandbox lifecycle (jail, cgroup, jailer launch,
uid/gid allocator, registry, reaping) is a separate change; until it lands `prepare` answers
`unavailable` and the helper creates nothing.

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

`scripts/check.sh` runs the same when `packages/fx-runner` is affected. Nothing here needs root; the
real-root tests (real jailer, Firecracker, cgroup v2) belong to the sandbox lifecycle change.
