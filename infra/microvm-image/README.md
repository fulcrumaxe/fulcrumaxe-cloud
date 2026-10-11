# fx-agent microVM image

The guest side of the Firecracker microVM engine: what runs inside the VM, and the build that makes its root disk.

| Path | What it is |
|---|---|
| `lock.json` | Every download (guest kernel, Firecracker, the agent CLI, node, pnpm, and the build tools), by URL and sha256, for amd64 and arm64. |
| `Dockerfile` | The template image: the sandbox image's user and home, plus pnpm, Postgres, Python, jq, bubblewrap and iproute2. It reads `lock.json`; it holds no URL of its own. |
| `guest/init` | PID 1 of the guest. Mounts the pseudo file systems, writes `/etc/hosts`, brings up loopback, starts the agent. The guest has no network device. |
| `guest/agent.py` | The in-guest agent: ping, exec, put, get and counters over vsock, for the host only. |

## Building a root disk

`fx-runner vm build-image --template fx-agent --image <repository@sha256:...> --out <dir>` (code in `packages/fx-runner/src/vm`,
started by `packages/fx-runner/scripts/vm-main.mjs`) exports the image by digest, adds `guest/init` and `guest/agent.py`, and makes
`<dir>/<arch>/rootfs.ext4`. It needs `crane`, GNU `tar` and `mke2fs` 1.47.1 or newer. No root, no mount.

- `mke2fs` reads the tar through libarchive, which it loads when it runs. Build it with native language support (not
  `--disable-nls`): otherwise it cannot convert a non-ASCII link target and fails, and a disk that was never written must never be used.
- The same image digest and the same `mke2fs` give the same bytes. `lock.json` names the version the pins were made with.

The hosted workflow `microvm-image.yml` does all of this, twice, and boots the amd64 disk under Firecracker; `microvm-image-release.yml`
publishes the files and signs their digests.

## Changing a pin

Edit the URL and the sha256 in `lock.json` together. The guest's `claude` must stay at or above the runner's minimum version
(`MIN_CLAUDE_VERSION` in `packages/fx-runner/src/engines/claude/pin.ts`); a test checks it. A new base image digest goes in `lock.json`
and in both `FROM` lines of the `Dockerfile`; a test checks that they agree.

## Withdrawing a released image

Before the release workflow's `sign` job has run, undo is deleting the draft release. After it, deleting the release is **not** an
undo: the image's digests are in the signed update metadata, and the boot gate treats them as bootable until they are signed out.
Withdraw an image (a bad or vulnerable one, or an old one nobody should boot any more) with

    node packages/fx-runner/scripts/tuf-release.mjs release --dir <metadata dir> --trusted-root <1.root.json> --drop <vm tag> \
      --targets-key-env TUF_TARGETS_KEY --online-key-env TUF_ONLINE_KEY

where `<vm tag>` is the release name, `vm-<template>-<12 hex>`. It removes every kernel, root disk and agent entry of that image from
the next targets version, which then has to be published like any other (`docs/release-keys.md`). After a targets or online key
rotation the earlier entries must be checked against `--artifacts`; an old root disk is about 1 GiB, so drop old images instead of
keeping their disks around.

The release notes of each image record the template image digest and the commit that built it. The apt layer of the template is not
pinned, so rebuilding the same commit does not give the same root disk; the digest in the release is the only trace of what was built.
