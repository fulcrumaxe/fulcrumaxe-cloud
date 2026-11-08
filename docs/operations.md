# Operations

How to get a working dev environment, what CI runs and where, and the settings an operator has to know about. What `scripts/check.sh` runs is on [the testing page](testing.md#the-check). See [the security model](security.md) for the guarantees these checks protect.

Sources:
- `flake.nix`
- `scripts/check.sh`
- `scripts/check-globalsetup-env.sh`
- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `packages/db/test/globalSetup.ts`
- `packages/db/scripts/check-migration-order.sh`
- `scripts/ci/affected.mjs`
- `apps/web/env-manifest.ts`
- `packages/github/src/handledEventNames.js`
- `infra/sandbox-image/versions.lock.json`
- `packages/runner/src/sandboxRuntime.ts`
- `package.json`

## Dev shell

`flake.nix` defines the one dev environment every developer, CI job and worktree uses (`nix develop`). Its `devShells.${system}.default` provides Node 24, `pnpm`, PostgreSQL (`initdb`/`pg_ctl` for the throwaway test clusters `packages/db` provisions), `git`, `jq`, `sqlite`, `duckdb`, and a pinned Python 3.12 closure (`pythonEnv`) covering `requirements.txt` for the autonomous-team backend tooling. It also vendors Playwright's Chromium browser binaries through the Nix binary cache (`playwrightBrowsers`) rather than letting `@playwright/test` download them over the network at install time, and sets `LD_LIBRARY_PATH` so compiled Python wheels (`duckdb`, etc.) link correctly on NixOS. No Python virtualenv is built on shell entry — `scripts/check.sh` never touches Python, so that cost would be paid on every CI job for no benefit there; a developer who needs the Python-side team tooling runs `scripts/setup-deps.sh --venv` separately.

## Local setup

`nix develop` opens the dev shell described above; `bash scripts/check.sh` from inside it runs the same checks CI runs (below).

## `scripts/check.sh`

The same script runs on a workstation, in CI and as the platform's own check step. It has a full mode and an affected mode (`FX_CHECK_AFFECTED`), and stops at the first failure. The steps, the mode rules and the repository-wide guards are on [the testing page](testing.md#the-check). The test step runs with the model credentials unset and `FX_FORBID_MODEL_CALLS=1` (see [the zero-model-token test rule](security.md#the-zero-model-token-test-rule)).

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on pull requests (opened, synchronize, reopened) and on `merge_group` for GitHub's merge queue. Its jobs:

- `pr-gates` (public pull requests only): the PR link policy and the publish denylist.
- `check`: `nix develop .#ci --command bash scripts/check.sh`, in the scope `scripts/ci/affected.mjs` chose for the pull request. A push to `main` and a merge-queue run are always full.
- `workspace-e2e`: Playwright for `apps/workspace`, once per viewport project (`desktop`, `phone`, `tablet`).
- `e2e-runner`: `pnpm test:e2e-runner`.

Runners: a public repository runs on GitHub-hosted `ubuntu-latest`; the private repository runs on a self-hosted runner (the `CI_RUNS_ON` repository variable can name another). Node, pnpm and PostgreSQL come from the same `flake.nix` dev shell a developer uses, so CI has no separate image. Every job has a timeout. A repository variable `CI_DISABLED=true` skips the jobs, and `CI_FORCE_FULL=true` forces every pull request run to full scope.

Forcing a full run on one pull request: add the `ci:full` label. `.github/workflows/ci-full-label.yml` re-runs the latest CI run for the head, and the scope step reads the label from the API (not from the event payload, which a re-run replays stale). While the label is on, a push runs full too.

Permissions and credentials: the top-level token is `contents: read`. The jobs that read labels or the pull request body add `pull-requests: read`; nothing in the workflow can write to the repository. Checkouts pass `persist-credentials: false`, so no job leaves a token in `.git/config`. `check` fetches two commits of history (`fetch-depth: 2`) so `check-migration-order.sh` can resolve `HEAD^1`, and `MIGRATION_ORDER_BASE: HEAD^1` points that script and `test-neon-shape.sh`'s parity check at the base each run actually merges onto. `FX_FORBID_MODEL_CALLS: "1"` is set at the workflow level.

## Dependabot

`.github/dependabot.yml` configures one `package-ecosystem: "github-actions"` update stream, on the repo root, checked weekly. It does not configure an `npm`/`pnpm` ecosystem entry, so Dependabot does not open update PRs for JavaScript/TypeScript dependencies — only for the versions pinned in `.github/workflows/*.yml`.

## Settings an operator sets

The full list, with what happens when one is missing, is `apps/web/env-manifest.ts`. The ones that change what the pipeline does:

- `FX_GATE1_ATTEST_REPOS`: comma-separated `owner/name` code repositories where the cloud posts `fx-gate1` itself (see [the architecture](architecture.md#the-clouds-own-fx-gate1)). Unset, the cloud never posts it, and a paired item whose public pull request lacks only `fx-gate1` waits and then ends at Needs a person. Only a listed repository is ever labelled or attested, so a customer repository is never touched. A malformed value stops the worker at start with an error.
- `FX_HUMAN_MERGE_ONLY_REPO_IDS`: GitHub ids of repositories that only a person may merge. A malformed value locks every repository to human merges (fail closed).
- `FX_OPERATOR_SUBSCRIPTION`, `FX_OPERATOR_ACCOUNT_IDS`: the operator's own Claude subscription for allow-listed accounts; removing the first turns the feature off (see [the security model](security.md#the-operator-subscription-exception)).

The GitHub App has to be subscribed to the `check_run`, `check_suite` and `status` events as well as the issue and pull request ones: they wake the merge queue and the gate to look again when CI finishes, and map to no work item change. The events the cloud handles are listed in `packages/github/src/handledEventNames.js`; an App created before those three were added needs them added by hand in its settings.

The sandbox image is pinned by digest, `image.repository@image.digest` in `infra/sandbox-image/versions.lock.json`; `packages/runner/src/sandboxRuntime.ts` reads it and refuses to start with an empty or malformed digest. Changing the image (it now carries Postgres 18 server binaries and a Playwright Chromium for the review sandbox) means publishing it and recording the new digest in that file.

## The database tests' self-provisioned cluster

`packages/db/test/globalSetup.ts` runs once per vitest process, before any test file in that project. Unless `DATABASE_URL_TEST` (and its `_APP_USER`/`_PLATFORM_OPS`/`_PARTNER_USER` counterparts) are set, it provisions a throwaway ephemeral Postgres cluster, applies the full migration chain to it, and tears it down afterward — so `pnpm test` needs no pre-existing database. The provisioned connection info is handed to the project's own test workers through vitest's `provide()`/`inject()` mechanism rather than a `process.env` write in `globalSetup` itself, which is exactly the pattern `scripts/check-globalsetup-env.sh` (above) exists to keep from regressing.

## Hosted Postgres

Applying this same migration chain to a real hosted Postgres (Neon) connection, which is never a superuser, has its own owner-shape and privilege-bracket requirements. The operator runbooks that cover it are not part of this public tree.

## Out of scope for these docs

This repository also carries tooling that supports how the project is developed (engine scripts, hooks, templates and team state). None of that is part of the product these docs cover, so it is left out here. `scripts/ci/check-pages.py` and `scripts/run-pr-tests.sh` are part of that tooling: the pages check is one of the per-pull-request review suites, not a step `scripts/check.sh` runs.
