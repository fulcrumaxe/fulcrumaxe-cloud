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
- `scripts/ci/same-tree.mjs`
- `scripts/ci/rollup-position.mjs`
- `apps/web/env-manifest.ts`
- `packages/github/src/handledEventNames.js`
- `infra/sandbox-image/versions.lock.json`
- `packages/runner/src/sandboxRuntime.ts`
- `package.json`

## Dev shell

`flake.nix` defines the one dev environment every developer, CI job and worktree uses (`nix develop`). Its `devShells.${system}.default` provides Node 24, `pnpm`, PostgreSQL (`initdb`/`pg_ctl` for the throwaway test clusters `packages/db` provisions), `git`, `jq`, `procps` (so `ps` is on the minimal `PATH` of the NixOS CI runner, #985), `go` (for the VM helper in `packages/fx-runner/vmhelper`, which is Go with the standard library only; it is in the shared package list, so the CI shell has it too, #986), `sqlite`, `duckdb`, and a pinned Python 3.12 closure (`pythonEnv`) covering `requirements.txt` for the autonomous-team backend tooling. It also vendors Playwright's Chromium browser binaries through the Nix binary cache (`playwrightBrowsers`) rather than letting `@playwright/test` download them over the network at install time, and sets `LD_LIBRARY_PATH` so compiled Python wheels (`duckdb`, etc.) link correctly on NixOS. No Python virtualenv is built on shell entry — `scripts/check.sh` never touches Python, so that cost would be paid on every CI job for no benefit there; a developer who needs the Python-side team tooling runs `scripts/setup-deps.sh --venv` separately.

## Local setup

`nix develop` opens the dev shell described above; `bash scripts/check.sh` from inside it runs the same checks CI runs (below).

## `scripts/check.sh`

The same script runs on a workstation, in CI and as the platform's own check step. It has a full mode and an affected mode (`FX_CHECK_AFFECTED`), and stops at the first failure. The steps, the mode rules and the repository-wide guards are on [the testing page](testing.md#the-check). The test step runs with the model credentials unset and `FX_FORBID_MODEL_CALLS=1` (see [the zero-model-token test rule](security.md#the-zero-model-token-test-rule)).

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on pull requests (opened, synchronize, reopened) and on `merge_group` for GitHub's merge queue. Its jobs:

- `pr-gates` (public pull requests only): the PR link policy and the publish denylist.
- `check`: `nix develop .#ci --command bash scripts/check.sh`, in the scope `scripts/ci/affected.mjs` chose for the pull request. A push to `main` and a merge-queue run are always full for this job (a queue run's scope is computed from the whole group and narrows only `workspace-e2e`, #1048), with one exception: a merge-queue run for a single pull request whose tree is byte-identical to a head that already carries the cloud's `fx-gate1` success skips the test steps (`scripts/ci/same-tree.mjs`, #923). The job's timeout is 90 minutes, because a full-scope run in the queue has passed 60 (#915); it is 175 minutes in a merge-queue run while the repository variable `ROLLUP_ENABLED` is `true` (#939).
- `workspace-e2e`: Playwright for `apps/workspace`, once per viewport project (`desktop`, `phone`, `tablet`). It is skipped on a private pull request that changes only overlay paths (#894) and, like `check`, in a queue run whose tree was already proven. In a queue run its specs are scoped by the whole group's range back to the target branch, not by one pull request (#1048).
- `e2e-runner`: `pnpm test:e2e-runner`.

Merge-queue rollups (#939, dormant): a `Rollup` step in `check`, `e2e-runner` and `workspace-e2e` runs only in a `merge_group` run and only while the repository variable `ROLLUP_ENABLED` is `true`. It runs `scripts/ci/rollup-position.mjs`, which lets an entry that has another entry on top of it in the queue wait instead of running the suites, and ends that entry as a success only once its own pull request is merged; an entry that becomes the last one, hits the wait cap, or meets any doubt or API error runs in full. It waits only when the live merge-queue rule on the branch groups by `HEADGREEN` and gives a check response timeout of at least 150 minutes (#959); otherwise it runs in full at once. While `ROLLUP_ENABLED` is `true`, the merge-queue timeouts of `workspace-e2e` and `e2e-runner` grow from 40 and 30 to 125 and 115 minutes; with the variable unset the step does not run and the timeouts keep their old values (`.github/workflows/ci.yml`). The script's own tests run with the other CI script tests (`scripts/ci/rollup-position.test.mjs`).

Runners: a public repository runs on GitHub-hosted `ubuntu-latest`; the private repository runs on a self-hosted runner (the `CI_RUNS_ON` repository variable can name another). Node, pnpm and PostgreSQL come from the same `flake.nix` dev shell a developer uses, so CI has no separate image. On a hosted runner Nix is installed with `fallback = true`, so a throttled Actions cache falls back to `cache.nixos.org` instead of failing the job, and the Nix store cache action skips the FlakeHub login the project has no account for (#1093). Every job has a timeout. A repository variable `CI_DISABLED=true` skips the jobs, and `CI_FORCE_FULL=true` forces every pull request run to full scope.

Forcing a full run on one pull request: add the `ci:full` label. `.github/workflows/ci-full-label.yml` re-runs the latest CI run for the head, and the scope step reads the label from the API (not from the event payload, which a re-run replays stale). While the label is on, a push runs full too.

Permissions and credentials: the top-level token is `contents: read`. The jobs that read labels or the pull request body add `pull-requests: read`; nothing in the workflow can write to the repository. Checkouts pass `persist-credentials: false`, so no job leaves a token in `.git/config`. `check` fetches two commits of history (`fetch-depth: 2`) so `check-migration-order.sh` can resolve `HEAD^1`, and `MIGRATION_ORDER_BASE: HEAD^1` points that script and `test-neon-shape.sh`'s parity check at the base each run actually merges onto. `FX_FORBID_MODEL_CALLS: "1"` is set at the workflow level.

## Dependabot

`.github/dependabot.yml` configures one `package-ecosystem: "github-actions"` update stream, on the repo root, checked weekly. It does not configure an `npm`/`pnpm` ecosystem entry, so Dependabot does not open update PRs for JavaScript/TypeScript dependencies — only for the versions pinned in `.github/workflows/*.yml`.

## Settings an operator sets

The full list, with what happens when one is missing, is `apps/web/env-manifest.ts`. The ones that change what the pipeline does:

- `FX_QUEUE_JUMP` and `FX_QUEUE_JUMP_MIN_MINUTES`: the jump to the front of GitHub's merge queue for the cloud's own pull requests. On unless `FX_QUEUE_JUMP=off`, and only in a repository listed in `FX_GATE1_ATTEST_REPOS` (a customer's queue is never reordered). GitHub rebuilds every entry already in progress behind a jump, so at most one jump per repository is asked for in `FX_QUEUE_JUMP_MIN_MINUTES` (default 50). If GitHub refuses the jump the pull request is queued at the back and the refusal is reported (`merge_queue_jump_refused`); each enqueue fact records `queue_jump`, `jump_refused` or `jump_throttled`.
- `FX_GATE1_ATTEST_REPOS`: comma-separated `owner/name` code repositories where the cloud posts `fx-gate1` itself (see [the architecture](architecture.md#the-clouds-own-fx-gate1)). Unset, the cloud never posts it, and a paired item whose public pull request lacks only `fx-gate1` waits and then ends at Needs a person. Only a listed repository is ever labelled or attested, so a customer repository is never touched. A malformed value stops the worker at start with an error.
- `FX_HUMAN_MERGE_ONLY_REPO_IDS`: GitHub ids of repositories that only a person may merge. A malformed value locks every repository to human merges (fail closed).
- `FX_OPERATOR_SUBSCRIPTION`, `FX_OPERATOR_ACCOUNT_IDS`: the operator's own Claude subscription for allow-listed accounts; removing the first turns the feature off (see [the security model](security.md#the-operator-subscription-exception)).

- `FX_DEVICE_CODE_KEY`: the secret (at least 32 characters; a shorter value counts as missing) that the short code a person types to link a machine is hashed with. No deploy kind requires it. Unset, `POST /api/runner/device/start` and the lookup, approve and deny routes answer 503 `not_configured` and store nothing, so no machine can be linked by a typed code. Changing it ends every code still waiting, which last 10 minutes (`apps/web/env-manifest.ts`; the trust rules are in [the security model](security.md#the-device-code-flow)).
- `FX_DEVICE_FLOW_GLOBAL_PER_HOUR`: the most device codes that may be started in an hour across all addresses; 1,000 when unset or not a positive whole number. One address may start 10 an hour whatever this says.
- `STRIPE_PRICE_ID_ENGINE`: the Stripe price of one engine on the Engine plan (a comma-separated list like the hosted-plan prices; the first is the one Checkout sells). Unset, the Engine plan is not offered: checkout and quantity changes answer `invalid_plan`, `/api/health` lists `engine_price_unset` for an authenticated caller and the server still starts. The plan data must carry the engine plan's price as well, or health lists `engine_plan_unconfigured`. A blank value, or an id also listed under a hosted plan or a site-kit product, fails the start.
- `STRIPE_PORTAL_CONFIGURATION_ID`: optional pin for the customer-portal configuration every portal session uses. Unset, the app finds or creates its own, which offers the payment method, invoices and cancellation but no plan or quantity change (those go through the app's own routes, which take payment first). A pinned configuration that is inactive or allows item changes is refused, and then no portal opens.
- `FX_DEPLOY_COMMIT`: the commit a deployment made from the command line is running. `/api/health` reports the platform's git commit, which such a deployment does not have, so without this the post-merge verify stage cannot tell what is deployed and ends its row `unverified` with `commit_not_deployed`. The deploy command stamps it (`vercel deploy --env FX_DEPLOY_COMMIT=<commit>`).
- `FX_VERIFY_OWN_HOSTS`: extra custom hostnames of this project that may receive the Deployment Protection bypass header on the verify health read and the sweep kicks. Besides these, only the hosts Vercel names (`VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`) count. Without a match a protected app reads as unreachable. `VERCEL_AUTOMATION_BYPASS_SECRET` is provided by Vercel when Protection Bypass for Automation is on.
- `FX_READER_SLICE_MS`: when set (10,000 to 600,000 ms), a hosted run's log is read by its follower in slices of at most this long instead of by the invocation that started the run.

The GitHub App has to be subscribed to the `check_run`, `check_suite` and `status` events as well as the issue and pull request ones: they wake the merge queue and the gate to look again when CI finishes, and map to no work item change. The events the cloud handles are listed in `packages/github/src/handledEventNames.js`; an App created before those three were added needs them added by hand in its settings.

The sandbox image is pinned by digest, `image.repository@image.digest` in `infra/sandbox-image/versions.lock.json`; `packages/runner/src/sandboxRuntime.ts` reads it and refuses to start with an empty or malformed digest. Changing the image (it now carries Postgres 18 server binaries and a Playwright Chromium for the review sandbox) means publishing it and recording the new digest in that file.

## The database tests' self-provisioned cluster

`packages/db/test/globalSetup.ts` runs once per vitest process, before any test file in that project. Unless `DATABASE_URL_TEST` (and its `_APP_USER`/`_PLATFORM_OPS`/`_PARTNER_USER` counterparts) are set, it provisions a throwaway ephemeral Postgres cluster, applies the full migration chain to it, and tears it down afterward — so `pnpm test` needs no pre-existing database. The provisioned connection info is handed to the project's own test workers through vitest's `provide()`/`inject()` mechanism rather than a `process.env` write in `globalSetup` itself, which is exactly the pattern `scripts/check-globalsetup-env.sh` (above) exists to keep from regressing.

## Hosted Postgres

Applying this same migration chain to a real hosted Postgres (Neon) connection, which is never a superuser, has its own owner-shape and privilege-bracket requirements. The operator runbooks that cover it are not part of this public tree.

## Out of scope for these docs

This repository also carries tooling that supports how the project is developed (engine scripts, hooks, templates and team state). None of that is part of the product these docs cover, so it is left out here. `scripts/ci/check-pages.py` and `scripts/run-pr-tests.sh` are part of that tooling: the pages check is one of the per-pull-request review suites, not a step `scripts/check.sh` runs.
