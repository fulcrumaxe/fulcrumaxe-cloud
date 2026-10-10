# This repo inside the runner's sandbox (D#6 R7e)

What the repo's full `scripts/check.sh` needs from a job's host sandbox, found by running it inside that sandbox. The repo's allowance
file is `.fulcrumaxe/runner-sandbox.json`. **Status: discovery done on a Linux host, and re-verified after the C39 fixes (below); the live
staging runs are pending** (the repo is not connected to staging yet), so every "live" column below reads `pending`. macOS (acceptance
item 12) is tracked with the macOS sandbox workflow (D#587 B-10) and is not covered here.

**Result in one line:** one allowance (the npm registry) is the whole minimal set. The six blockers found first (B1 to B6) are resolved by
the runner fix (#145) and the repo fix (#146), as ruled in C39. Run again at the tip that holds both, `check.sh` passes every step except
three test files (7 failures out of about 20,000 tests), and each of those has a cause in the repo's own tests or dev shell, listed as N1 to
N3 below. None was worked around, and no allowance was added for any of them.

## Re-verified after C39 fixes

Same method as the first run (next section), run on the repo tip with #145 (runner side) and #146 (repo side) merged. Nothing was patched:
the harness ran the repo exactly as committed, and the job environment came from the runner's own code, so it now carries what the fixes add:
`FX_RUNNER_JOB=1` (from `cleanEnv`), `PLAYWRIGHT_BROWSERS_PATH` (a store path, through `filterDevEnv`), `pnpm_config_store_dir` (from `jobEnvFor`),
and the sandbox's proxy variables. `check.sh`'s own commands ran in its own order, one segment at a time, with `CI=1`; load was 3 to 13 at the
start of each segment. The only allowance was `registry.npmjs.org`.

| Segment (`check.sh` steps) | Result | Time |
|---|---|---|
| `pnpm install --frozen-lockfile`, declared imports, `pnpm lint`, `pnpm typecheck`, `check-globalsetup-env.sh`, `check-agent-run-columns.sh` | all 6 pass | 82 s |
| `pnpm test` shard 1/4 | pass: 259 files passed, 1 skipped; 4955 tests passed, 3 skipped | 223 s |
| `pnpm test` shard 2/4 | pass: 256 files passed, 4 skipped; 5363 tests passed, 16 skipped | 209 s |
| `pnpm test` shard 3/4 | **fail**: 2 files, 5 tests (N1, N2); 256 files passed, 2 skipped; 5038 tests passed, 119 skipped | 103 s |
| `pnpm test` shard 4/4 | **fail**: 1 file, 2 failures (N3); 258 files passed, 1 skipped; 5327 tests passed, 31 skipped | 127 s |
| sitekit-checks browser tier (real Chromium, 11 tests), `test-neon-shape.sh`, migration order, `pnpm --filter web build`, next-trace check, baked-path check, `pnpm test:guard` | all 7 pass | 78 s |

Skipped on purpose inside a job (C39 B1 and B4): the tmux watch and attach tests (14 tests), and the runner's real-Nix and real-bubblewrap
suites (`nixShell*.real`, `nixView.bwrap`, `sandboxAllowances.bwrap`, `seaReal`, `updateSea`). CI and developer hosts still run them.

One more change landed on main while the run was under way (the release signing tools, #144, with the new `tufRelease.test.ts`); that file and
the probe test were run again on the merged tree in the same sandbox: 42 of 42 pass, and fx-runner typecheck and eslint are clean.

Proxy denials in the whole run: **zero** (no host other than the registry and the model host was contacted). No process carrying a run's tag
was left after any segment.

### Denial log (this run, Linux, local, the sandbox the runner builds)

| # | Where | Denial as seen | Cause |
|---|---|---|---|
| N1 | `fx-runner` `test/release/seaTamper.test.ts` (3 tests) | `build-sea: EROFS: read-only file system, mkdtemp '/tmp/fx-sea-XXXXXX'` | the test starts `build-sea.mjs` with an environment of its own (`PATH`, CA file, mirror URL) and no `TMPDIR`, so `os.tmpdir()` falls back to the read-only `/tmp`. Same class as B2, in a test that landed after C39 |
| N2 | `fx-runner` `test/release/installSh.test.ts` (2 tests: "the shells and checkers ... are present", "dash was available") | `expected [ 'dash', 'shellcheck' ] to deeply equal []` | under `CI=1` the test requires `dash` and `shellcheck` on `PATH`; the dev shell holds neither (91 of its 189 tests skip for lack of `dash`). Not a sandbox denial |
| N3 | `gh-proxy` `test/strippedBuild.test.ts` (2 failures: `next build output`, `next start: raw request lines`) | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` from `pnpm exec next build`, then `next start did not come up` | the test builds an environment from a fixed name list. #146 added the proxy variables, but the list has neither `CI` nor `pnpm_config_store_dir`, which #145 now sets. `pnpm exec` then sees a different store than the one `node_modules` was installed with, wants to reinstall, and aborts without a terminal. Checked in the sandbox: the same command with the test's list fails the same way, and with `pnpm_config_store_dir` added it goes past that point |

Everything B1 to B6 named is gone from the log: no Unix-socket denial (Postgres clusters on TCP, `node --import tsx`), no `/tmp` write denial
outside N1, the browser tier and the live-e2e browser tests find Chromium, the nix and bwrap suites skip, and the pnpm store is the per-repo
one. Chromium started its own sandbox nested inside bubblewrap (`chromiumSandbox: true` in the repo's driver) and the browser tests passed, so
C15b ruling 2 (sandbox off) is not needed on this host and no entry or flag was added; live: pending.

### What fails without the entry (acceptance 3), re-run

| Entry removed | Step that fails | Observed locally | Live |
|---|---|---|---|
| `registry.npmjs.org` (replaced by another host, so allowances stay), full `check.sh`, fresh checkout, empty store | `pnpm install`, the first step | the proxy logs `Connection blocked to registry.npmjs.org:443`; no package downloads; pnpm prints `GET https://registry.npmjs.org/... error (0). Will retry in 1 minute` until the 480 s limit killed it; no later step header was reached | pending |
| `registry.npmjs.org` (set empty) | `pnpm install` | `pnpm: command not found`, exit 127: no allowances, so no dev shell (first run; the runner code is unchanged for this case) | pending |

## Blockers from the first run: now resolved

| # | Was | Resolved by | Seen in the re-run |
|---|---|---|---|
| B1 | Unix-domain sockets blocked by seccomp (Postgres clusters, the `tsx` command, tmux) | repo, C39 ruling (b): #146 puts test Postgres on TCP 127.0.0.1, scripts use `node --import tsx`, tmux tests skip inside a job | Postgres suites, neon-shape and the `tsx` users pass; tmux tests skip |
| B2 | `/tmp` read-only except the job's own directories | repo: #146 (`tmpRoot()`, `TMPDIR` passed to children) | `sandboxAllowances*` and live-e2e `run.test.ts` pass; one more test of the same class turned up (N1) |
| B3 | `PLAYWRIGHT_BROWSERS_PATH` never reached the job | runner: #145 (`NIX_TOOL_VARS`, store path only); repo: #146 (the flake exports it as a `mkShell` attribute) | present in the job as a `/nix/store` path; browser tier and live-e2e fence tests pass |
| B4 | runner's real-Nix and real-bubblewrap tests cannot run in a job | runner: #145 (`FX_RUNNER_JOB=1` marker, the suites skip inside a job) | those suites skip |
| B5 | tests that scrub the environment drop the proxy variables | repo: #146 (proxy variables pass through) | proxy variables reach `strippedBuild`; it now fails for a different reason (N3) |
| B6 | R7b defect: pnpm 11 ignores `npm_config_store_dir` and `npm_config_verify_store_integrity` | runner: #145 (`pnpm_config_` names) | `pnpm_config_store_dir` is set in the job and `pnpm install` uses the per-repo store |

Rulings: C39 (the owner may override). Item 5 of the probe is reworded there; see the probe section.

## Remaining blockers (acceptance 13)

**N1. `seaTamper` runs `build-sea.mjs` without `TMPDIR`.** Fix in the test: pass `TMPDIR` (`os.tmpdir()`) in the child's environment. Weakens nothing; same ruling as B2.

**N2. `installSh` needs `dash` and `shellcheck` under `CI=1`.** The dev shell has neither. Options: add both to the flake's dev shell
(small, keeps the check byte-for-byte the CI one), or skip those cases inside a job. **Question: add to the dev shell (recommended)?**

**N3. `strippedBuild` drops `CI` and the pnpm store variable.** Fix in the test: add `CI` and the `pnpm_config_` names to the list it
passes on. No ruling needed.

All three are repo changes (a follow-up to #146); none needs a sandbox allowance.

## How the denials were found

No model was involved. A small harness, kept outside the repo, builds the job's sandbox with the runner's own code: `checkedAllowances` and
`grantsOf` (the floor), `sandboxSettings`, `applyNixView`, `cleanEnv` with `jobEnvFor`, `claimScratch` and `filterDevEnv`. It then runs the
block through `@anthropic-ai/sandbox-runtime` 0.0.79, the library the agent CLI (2.1.295 here) embeds: real bubblewrap, real socat bridge, real
egress proxy, real seccomp filter. Differences from a live job, so none is hidden:

- The harness starts the command itself; the CLI's Bash tool, the model and the daemon are not involved (`command_timeout_s` is not exercised).
- The Nix dev shell comes from `nix print-dev-env` run outside the sandbox and filtered by `filterDevEnv`, not from the daemon's step with its mirror.
- The workspace is a local clone of the repo tip. The host `PATH` is the NixOS system profile only.
- The foreground limit of the tooling here is 10 minutes, so `check.sh` ran in segments with the script's own commands in its own order (table above).
  A segment's later steps still ran after an earlier one failed, which `check.sh` itself (`set -e`) would not do.

## Allowances

### Allowance: `domain` `registry.npmjs.org` `connect`

1. **What:** the host `registry.npmjs.org`, access `connect` (through the egress proxy, HTTPS).
2. **Step and denial:** step 1 of `check.sh`, `pnpm install --frozen-lockfile`. Without it the proxy logs `Connection blocked to
   registry.npmjs.org:443` (first run: `No matching config rule, denying: registry.npmjs.org:443`, 1926 times), and pnpm prints `GET
   https://registry.npmjs.org/... error (0). Will retry in 1 minute` until the wall clock kills it. (With no allowance at all the job has no dev
   shell either, so it stops one step earlier with `pnpm: command not found`.)
3. **Why it weakens nothing:** one plain host name, no wildcard, no address; reads no credential and no home path. It is the registry the lock file names.
4. **Live:** pending.

Not entries, because the runner supplies them to any job that carries allowances: the read of `/nix/store`, the per-repo package store, the
per-job `XDG_CACHE_HOME`, and `command_timeout_s` 1800 (the longest the protocol allows; the sharded test step took 1.7 to 3.7 minutes per
shard at this load, up to 18 minutes in the first run, so a shorter limit would be a guess). No other host was contacted: with this one entry,
every segment of the re-run produced **zero** proxy denials. Loopback needs no entry on Linux (a TCP listener on 127.0.0.1 works in the job's private network).

What `check.sh` needs from Nix: `node` 24, `pnpm` 11.27, PostgreSQL (`initdb`, `pg_ctl`, `createdb`, `psql`), `jq`, `git`, python 3 with PyYAML for the workflow tests, and
the Playwright browsers (and, per N2, `dash` and `shellcheck`). The job's `PATH` held only the dev shell's store paths after the system profile; `AR AS CC CXX LD NM OBJCOPY OBJDUMP RANLIB READELF SIZE STRINGS STRIP PLAYWRIGHT_BROWSERS_PATH` came through; nothing else did.

## First-run denial log (before #145 and #146, for the record)

| # | Where | Denial as seen | Cause |
|---|---|---|---|
| D1 | `pnpm test` global setup; `test-neon-shape.sh` | `could not create Unix socket ... Operation not permitted` | B1 |
| D2 | roles card map, runtime scripts; browser tier fixture build | `listen EPERM: operation not permitted /tmp/claude/tsx-1000/<pid>.pipe` | B1 |
| D3 | watch and attach tests (2 files) | tmux server socket cannot be created | B1 |
| D4 | fx-runner `sandboxAllowances*.test.ts` (3 files) | `EROFS ... mkdtemp '/tmp/r7b-...-XXXXXX'` | B2 |
| D5 | live-e2e `run.test.ts` | `EROFS ... '/tmp/playwright-transform-cache-1000/...'` | B2 |
| D6 | browser tier | `FAILED browser tier: PLAYWRIGHT_BROWSERS_PATH unset under CI` | B3 |
| D7 | live-e2e fence, fetch-guard | `browserType.launch: Executable doesn't exist at <XDG_CACHE_HOME>/ms-playwright/...` | B3 |
| D8 | `nixShell.real`, `nixShell.hostConf.real` (4 tests) | `nix_view_unavailable` where `nix_failed` is expected | B4 |
| D9 | gh-proxy `strippedBuild` (2 tests) | `GET https://registry.npmjs.org/... error (ENETUNREACH)` | B5 |

## Probe (acceptance 4 to 8), `scripts/self-build-probe.sh`

`plant` (outside) puts a canary in each credential location of the floor; `run` is the job's command; `verify` and `unplant` run outside afterwards. It
prints one JSON document and never a canary value. A `plant` that fails part way undoes itself (an exit trap runs `unplant`, which removes only the
manifest's canaries and the directories the plant made), so a stray file in one location cannot leave canaries in the others. The three single-file
locations (`.netrc`, `.npmrc`, `.claude.json`) are planted too when absent (noclobber, same manifest and `unplant` rules); one that already exists is
never touched and is read as it is, and an existing empty one is reported by `verify` as `not_covered` (inconclusive), because a read of it proves nothing.
Re-run in the real sandbox after the C39 fixes, with the registry entry and canaries planted in `~/.ssh`, `~/.aws`,
`~/.config/gh`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.claude`, `~/.config/fx-runner` and `~/.local/share/keyrings`: `run` 35 of 35 pass, `verify` 16 of 16 pass
(the logs given to `verify` were the probe's own and two of the `check.sh` segments). That sandbox run used the probe before the review changes (plant
rollback, planting of the single-file locations, the egress id, the topmost-mount test); those are covered by tests on a throwaway home, and the live run
exercises them in a sandbox.

| Item | Result (local) | Live |
|---|---|---|
| 4 reads: 9 canaries, 3 file locations, listings, `~`, `~/.bashrc` | 25 of 25 refused or empty; canaries intact afterwards; no canary in any log | pending |
| 5 neither file exists on the host after the job, and no write reaches the real home or `/etc` (wording from C39). **Needs both steps:** `run` alone is not enough | `/etc/fx-probe` write refused; `~/fx-probe` write lands in the private tmpfs the sandbox lays over the hidden home and `verify` finds both files absent on the host (`absent_home`, `absent_system`) | pending |
| 6 egress: example.com, example.org, 1.1.1.1 (with and without proxy) | all refused; `registry.npmjs.org` and `api.anthropic.com` reached | pending |
| 7 Nix daemon socket | refused (`EPERM` from seccomp; with sockets enabled, `ENOENT`: the socket directory is hidden) | pending |
| 8 leftovers | the decoy process the job started (seen running inside) is gone after the job, and the account-wide `pgrep -u <user> -f 'postgres\|chrom'` diff against the baseline taken at `plant` shows nothing new | pending |

The `write_home` check used to report a fail for the tmpfs case (the criterion then read "refused"); under the C39 wording it reports a pass
with the detail `write_stayed_in_private_tmpfs` when the topmost mount at the home directory is a tmpfs, and a write that succeeds anywhere else is
still a fail. That `run` verdict alone can be fooled: a tmpfs mounted at the home and then shadowed by a bind of the real home makes `run` pass while
the file reaches the disk. `verify` is the gate for item 5, because it looks at the host afterwards (`absent_home`, `absent_system`); the item is met
only when both steps pass.

Item 8 is the account-wide diff, not a per-run tag. The decoy has a fixed name (`postgres: fx-probe-sentinel`) and `verify` checks that no process of that
name is alive and that no `postgres` or Chromium process of the user is new since `plant`. That diff errs towards false fails, not false passes (a
false pass would need a reused process id). On a host where other sessions start test clusters at the same time it can report `new_processes_alive`
for processes that are not the job's (seen once here; the immediate re-run was clean), so run the probe on a quiet account. The harness used for these
local runs also checks, separately, that no process still carries the run's environment tag; that found nothing in every run, and is an extra, not the
criterion.
