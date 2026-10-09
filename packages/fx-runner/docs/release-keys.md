# Release keys: the owner's runbook

This is the owner's runbook for the keys that sign `fx-runner` updates. It covers the steps marked OWNER in the release plan: **O1** (the offline root key), **O2** (the targets and online keys, and where they live) and **O3** (the production job-signing key). It names no secret value and no private host. Every command below uses throwaway placeholders such as `<dir>`.

## How the trust works

The runner checks every update against signed metadata (The Update Framework, TUF). Four roles sign:

| Role | Key | Where it lives | Lifetime | Signs |
|---|---|---|---|---|
| root | offline root key | your machine, offline, never on a server | 365 days | the list of keys for the other three roles |
| targets | targets key | `release` environment secret `TUF_TARGETS_KEY` | 90 days | each release: version, size and SHA-256 of every file |
| snapshot | online key | `release` and `tuf-timestamp` secrets `TUF_ONLINE_KEY` | 14 days | which targets version is current |
| timestamp | online key (same) | same | 14 days | which snapshot is current |

The first `1.root.json` is compiled into the runner. A new root is accepted by a runner only when it is signed by the root key the runner already trusts. The keyring never changes any other way.

If the timestamp expires, the runner **pauses updates** and says so. It never stops jobs.

## The tools

All of them are in `packages/fx-runner/scripts/` and need only the repository's dependencies (`pnpm install`).

- `node scripts/tuf-keygen.mjs --out <path>` makes an Ed25519 key. The private half goes to `<path>` with mode 0600. The path must be outside every git working tree and must not exist; the tool refuses otherwise. A path that passes through a symbolic link is refused too (on macOS, where `/tmp` and `/var` are links, give the real path, for example `/private/tmp/...`, or a directory under your home). **Only the public key is printed**, as a JWK.
- `node scripts/tuf-release.mjs <command> --dir <dir> ...` signs metadata in one directory. Commands: `init-root`, `release`, `refresh-timestamp`, `rotate-root`, `check`.
- A private key is always named by a **file path** (`--root-key`, `--targets-key`, `--online-key`, `--new-root-key`) or by an **environment variable name** (the same flag plus `-env`). Key text on the command line is refused.

**The trusted root.** `release`, `refresh-timestamp`, `rotate-root` and `check` all **require** `--trusted-root <file>`: the `1.root.json` you hold from O1 (later, the root compiled into the runner build), written `<root>` in the commands below. Before they sign or report anything they verify everything in `<dir>` against it: `1.root.json` must be byte-for-byte that file, every later `N.root.json` must be signed by the previous root and by itself, and the targets, snapshot and timestamp they build on must verify and agree. A directory filled from downloaded assets is never trusted on its own: if anyone altered an asset, the tools refuse and sign nothing. Keep your copy of `1.root.json` somewhere that is not the downloaded directory.

No key may hold two roles: `init-root` and `rotate-root` refuse any key shared between the root, targets and online roles.

The metadata directory holds `N.root.json`, `N.targets.json`, `N.snapshot.json` and `timestamp.json`. Old versions stay in it. It contains no secret, and it is what gets published as the assets of the `tuf-metadata` release.

## O1. The offline root key (once, then once a year)

Do this on a machine that is not connected to anything you do not trust, ideally one you can switch off afterwards.

1. Make the root key: `node scripts/tuf-keygen.mjs --out <root key path>`. Keep the path outside the repository. Make two encrypted copies on two separate offline media. Losing the root key with no copy means every installed runner would need reinstalling.
2. Make the targets and online keys (O2, step 1) and keep their **public** JWKs next to you.
3. Sign the first root: `node scripts/tuf-release.mjs init-root --dir <dir> --root-key <root key path> --targets-pubkey <targets public file> --online-pubkey <online public file>`.
4. Confirm `<dir>/1.root.json` exists, and keep a copy of it as your trusted root (`--trusted-root`, below). There is nothing else to check yet: there is no targets metadata until the first release.
5. Hand `1.root.json` and the three public JWKs (root, targets, online) to the Team Lead. The Team Lead commits the root into the build (the wiring step). The private root key never leaves your offline machine.

The root key signs nothing else, and no workflow ever sees it.

## O2. The targets and online keys, and the environments

1. Make two keys, anywhere you like that is not a working tree: `tuf-keygen.mjs --out <targets key path>` and `--out <online key path>`.
2. In the release repository, create two GitHub environments:
   - `release`: add yourself as **required reviewer**, so every release waits for your approval. Add secrets `TUF_TARGETS_KEY` (the whole targets private key file) and `TUF_ONLINE_KEY` (the whole online private key file).
   - `tuf-timestamp`: no reviewer. Add only the secret `TUF_ONLINE_KEY`. This environment is what lets the weekly re-sign run unattended.
   - **Restrict both environments to protected `main`.** In each environment's settings set *Deployment branches and tags* to **Selected branches and tags** and add only `main`, and make sure `main` is a protected branch (pull request required). Without this, a workflow on any branch pushed by anyone with write access could name `environment: tuf-timestamp` and read `TUF_ONLINE_KEY`; with that key an attacker can freeze clients on old metadata indefinitely. `TUF_TARGETS_KEY` stays out of `tuf-timestamp`.
   - Put your trusted root where the workflows can read it from `main` (the compiled-in `1.root.json`, once the wiring step lands) so `--trusted-root` never comes from the downloaded assets.
3. Delete the local private key files you no longer need, or keep them offline.

If you prefer the stricter setup, keep the targets key offline and run `release` yourself on your machine (below). Nothing about the metadata changes.

## O3. The production job-signing key

This is a different key from the ones above: it signs jobs the cloud sends to runners, not updates. Make it with `tuf-keygen.mjs` if you wish (it is also Ed25519), put the **private half** into the Vercel production environment as the job signing key setting, and give the Team Lead only the **public JWK** (the wiring step pins its hash). The private half is never given to the Team Lead or to any agent.

## Publishing a release

Each release is, in order:

1. The release workflow builds the four files and writes `release-manifest.json` (`scripts/release-manifest.mjs`).
2. Download the current metadata directory (the assets of the `tuf-metadata` release) into `<dir>`.
3. **Before signing**, verify what you downloaded: `node scripts/tuf-release.mjs check --dir <dir> --trusted-root <trusted 1.root.json>`. It must print `ok`. If it fails, stop: an asset was changed or the download is incomplete, and nothing must be signed. (`release` runs the same verification itself and refuses, but this makes the failure visible before the approval step.)
4. Sign: `node scripts/tuf-release.mjs release --dir <dir> --trusted-root <trusted 1.root.json> --manifest <release-manifest.json> --targets-key-env TUF_TARGETS_KEY --online-key-env TUF_ONLINE_KEY`. This lists the new files as `v<x.y.z>/fx-runner-<platform>`, keeps every earlier listed release that verified, and writes the next `N.targets.json`, `N.snapshot.json` and `timestamp.json`. If it prints a `note:` that the earlier targets verified under an older root, a key was rotated: read the `listed:` files before publishing.
5. Check the result, with the artifacts: `node scripts/tuf-release.mjs check --dir <dir> --trusted-root <trusted 1.root.json> --artifacts <artifacts>`, where `<artifacts>` holds `v<x.y.z>/fx-runner-<platform>` for the files you can see. It must print `ok`.
6. Upload the new files to the `tuf-metadata` release **timestamp last**, and the artifacts to the version's release.

A released file is never replaced: re-releasing the same version with different bytes is refused. Release a new version instead.

## Re-signing: when, with what

Every expiry has a command that renews it. Run them before the expiry, not at it.

| What | How often | Command | Key | Approval |
|---|---|---|---|---|
| timestamp and snapshot | **weekly** (lifetime 14 days, so one missed run is survivable) | `refresh-timestamp --dir <dir> --trusted-root <root> --online-key-env TUF_ONLINE_KEY` | online | none (`tuf-timestamp`) |
| targets | at least every **60 days** (lifetime 90), and with every release | `release --dir <dir> --trusted-root <root> --renew --targets-key-env TUF_TARGETS_KEY --online-key-env TUF_ONLINE_KEY` | targets and online | yours (`release`) |
| root | every **11 months** (lifetime 365 days) | `rotate-root` (below), with the same keys if you are not changing them | root | offline, yours |

`refresh-timestamp` also re-signs the snapshot, because the same online key signs both and the snapshot has its own 14-day lifetime. It refuses when the targets or the root are expired, since no online key can fix that; it says which. The lifetimes are changed with `--root-days`, `--targets-days`, `--snapshot-days` and `--timestamp-days`.

If the weekly job fails, updates pause on clients once the timestamp expires and resume at the next successful run. Jobs are not affected.

## Undo 1: withdraw a bad release

Sign a new targets version without it:

`node scripts/tuf-release.mjs release --dir <dir> --trusted-root <root> --drop <x.y.z> --targets-key-env TUF_TARGETS_KEY --online-key-env TUF_ONLINE_KEY`

Clients stop being offered that version at their next check; the earlier good versions stay listed. A runner that already installed the bad version rolls back with `fx-runner update --rollback`. Then release a fixed higher version; never re-release the same number.

## Undo 2: rotate keys

**Rotate the root key** (planned, or after the offline media may have been exposed):

1. On the offline machine make the new root key (`tuf-keygen.mjs`).
2. `node scripts/tuf-release.mjs rotate-root --dir <dir> --trusted-root <root> --root-key <old root key> --new-root-key <new root key>`. This writes `N+1.root.json` signed by **both** keys. A runner that trusts the old root accepts it, then trusts only the new key.
3. Publish `N+1.root.json` with the other metadata. Destroy the old root key. Runners that have been offline for a long time walk every root version, so keep all `N.root.json` files published.

**Rotate the targets or online key** (a leak of an environment secret): make the new key, then run `rotate-root --dir <dir> --trusted-root <root> --root-key <root key> --targets-pubkey <new targets public> --online-pubkey <new online public>` (either or both), then `release --dir <dir> --trusted-root <root> --renew --artifacts <artifacts>` with the **new** keys (`<artifacts>` from a reproducible rebuild of the release tags or from copies kept outside GitHub, never the release assets; see below), and replace the environment secrets. Until the renew is published, clients refuse the old metadata, which is the point: the leaked key cannot sign anything a client accepts. The tool tells you which roles need the renew.

**Why that renew needs `--artifacts`.** After a rotation the earlier list can only be vouched for by the older root, and an attacker holding the leaked key may have added entries to it before you rotated. So the renew refuses unless `<artifacts>` holds `v<x.y.z>/fx-runner-<platform>` for **every** release still listed, and the length and SHA-256 of each must match its entry. A missing or differing file is refused, and the error names the entry (for example `v9.9.9/fx-runner-linux-x64`). **`<artifacts>` must come ONLY from a reproducible rebuild of each release tag, or from copies you kept outside GitHub. Never take them from the release assets themselves:** whoever holds a leaked targets key can usually replace those assets too, and the check would then compare a forged file with a forged entry. For any entry you did not publish or cannot supply, add `--drop <x.y.z>` and it is removed instead of re-signed. A renew with no key rotation needs none of this.

**If the root key itself leaks**, no rotation helps: an attacker with it can sign a new root. Installed runners would have to be reinstalled with a new compiled-in root. Keep the root offline for this reason.

## What to check after any step

- `node scripts/tuf-release.mjs check --dir <dir> --trusted-root <root> [--artifacts <artifacts>]` prints `ok` and the listed files. It verifies the root chain from your trusted root 1 (every link), then every signature, threshold, expiry and cross-reference of the timestamp, snapshot and targets, as a runner does. It cannot catch a rollback of the directory: a directory restored to an older but genuinely signed state passes, and a later `release` would re-list a version you had dropped. A runner catches that against its own cache and refuses to go backwards, so the worst case for runners is paused updates. Keep your own record of the newest versions you published. With `--artifacts` it also compares the length and SHA-256 of every listed file it finds there, and it names the files it did not find ("not checked"); without it, it says the artifacts were not checked.
- The environment secrets exist, `release` has you as its required reviewer, and both environments are restricted to protected `main`.
- No private key file is inside a clone of the repository. `tuf-keygen.mjs` refuses to put one there, but a copied file is not checked.
