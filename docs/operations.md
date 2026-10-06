# Operations

How to get a working dev environment, what `scripts/check.sh` runs, and what CI and Dependabot do around it. See [the security model](security.md) for the guarantees these checks protect.

Sources:
- `flake.nix`
- `scripts/check.sh`
- `scripts/check-globalsetup-env.sh`
- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `packages/db/test/globalSetup.ts`
- `packages/db/scripts/check-migration-order.sh`
- `package.json`

## Dev shell

`flake.nix` defines the one dev environment every developer, CI job and worktree uses (`nix develop`). Its `devShells.${system}.default` provides Node 24, `pnpm`, PostgreSQL (`initdb`/`pg_ctl` for the throwaway test clusters `packages/db` provisions), `git`, `jq`, `sqlite`, `duckdb`, and a pinned Python 3.12 closure (`pythonEnv`) covering `requirements.txt` for the autonomous-team backend tooling. It also vendors Playwright's Chromium browser binaries through the Nix binary cache (`playwrightBrowsers`) rather than letting `@playwright/test` download them over the network at install time, and sets `LD_LIBRARY_PATH` so compiled Python wheels (`duckdb`, etc.) link correctly on NixOS. No Python virtualenv is built on shell entry — `scripts/check.sh` never touches Python, so that cost would be paid on every CI job for no benefit there; a developer who needs the Python-side team tooling runs `scripts/setup-deps.sh --venv` separately.

## Local setup

`nix develop` opens the dev shell described above; `bash scripts/check.sh` from inside it runs the same checks CI runs (below).

## `scripts/check.sh`

Runs in order, exiting non-zero on the first failure (`set -euo pipefail`):

1. `pnpm install --frozen-lockfile` — installs from the committed lockfile exactly, never resolving new versions.
2. `pnpm lint` (`eslint .`, per `package.json`).
3. `pnpm typecheck` (`pnpm -r --if-present run typecheck` — runs each workspace package's own typecheck script, skipping any package that doesn't define one).
4. `bash scripts/check-globalsetup-env.sh` — fails, naming the offending file and line, if any `packages/*/test/globalSetup.ts` or `apps/*/test/globalSetup.ts` writes to `process.env.*` or builds a port with `Math.random()`. `vitest.workspace.ts` runs every project's `globalSetup` in one shared orchestrator process before any project's workers fork, so a `process.env` write in one project's setup can be silently overwritten by another's before the first project's own tests ever read it back; this script is a static guard against that class of bug recurring.
5. `pnpm test` (`vitest run`), with `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` explicitly unset and `FX_FORBID_MODEL_CALLS=1` set — see [the zero-model-token test rule](security.md#the-zero-model-token-test-rule).
6. `bash packages/db/scripts/test-neon-shape.sh` — proves the migration chain applies under a role shaped like Neon's non-superuser connection owner, both as a fresh install and as an incremental upgrade of an already-migrated database, and (D#94) that the current PR's own new migration files apply safely as an upgrade against the resolved base ref's chain. See [`docs/ops/hosted-postgres.md`](ops/hosted-postgres.md).
7. `bash packages/db/scripts/check-migration-order.sh` — refuses a new `packages/db/migrations/*.sql` file that doesn't sort strictly after every migration already on the base ref (`MIGRATION_ORDER_BASE`, default `origin/main`), refuses a rename/edit of an existing migration file, and refuses two files sharing a four-digit prefix; fails closed (exit 2) if the base ref can't be resolved. See `packages/db/migrations/README.md` for the numbering rule (R1-R3) this enforces.
8. `pnpm --filter web build` — a real Next.js production build of `apps/web`.
9. `pnpm test:guard` (`vitest run packages/test-guard/test/guard-violation.fixture.test.ts`) — the guard's own fixture test, which deliberately trips `installModelCallGuard` to prove the guard itself still catches a violation rather than having silently become a no-op.

## CI

`.github/workflows/ci.yml` triggers on push to `main` and on every pull request, running a single `check` job on a `self-hosted` runner (chosen because private-repo Actions minutes on a hosted runner are capped; node/pnpm/PostgreSQL all come from the same `flake.nix` devShell a developer uses locally, rather than a separately assembled CI image). The job declares `permissions: contents: read` — it only needs to read the checked-out tree, and since `scripts/check.sh` runs `pnpm install` (which executes arbitrary lockfile lifecycle scripts), a broader token would hand a malicious postinstall write access it has no reason to need. The checkout step passes `persist-credentials: false`, so the job's `GITHUB_TOKEN` is never left as a git credential helper on the (persistent, not ephemeral) self-hosted machine for a later job to find — the job never pushes, comments or calls the GitHub API, so there is no reason for it to be there at all. It also passes `fetch-depth: 2` (D#94) — one commit of parent history, just enough for `check-migration-order.sh` to resolve `HEAD^1` as the merge/push commit's own base tip, without fetching the repo's full history. `FX_FORBID_MODEL_CALLS: "1"` is also set at the job-env level, on top of `scripts/check.sh`'s own narrower `env -u ... FX_FORBID_MODEL_CALLS=1` around the test step, so every step in the job runs under the same guarantee. `MIGRATION_ORDER_BASE: HEAD^1` is set for the same run so `check-migration-order.sh` (and `test-neon-shape.sh`'s D#94 parity check) resolve the base each PR actually merges onto, rather than the `origin/main` default those scripts fall back to locally. The one step, `nix develop --command bash scripts/check.sh`, is exactly what a developer runs on a workstation — CI cannot drift from local behavior by having its own separate setup.

## Dependabot

`.github/dependabot.yml` configures one `package-ecosystem: "github-actions"` update stream, on the repo root, checked weekly. It does not configure an `npm`/`pnpm` ecosystem entry, so Dependabot does not open update PRs for JavaScript/TypeScript dependencies — only for the versions pinned in `.github/workflows/*.yml`.

## The database tests' self-provisioned cluster

`packages/db/test/globalSetup.ts` runs once per vitest process, before any test file in that project. Unless `DATABASE_URL_TEST` (and its `_APP_USER`/`_PLATFORM_OPS`/`_PARTNER_USER` counterparts) are set, it provisions a throwaway ephemeral Postgres cluster, applies the full migration chain to it, and tears it down afterward — so `pnpm test` needs no pre-existing database. The provisioned connection info is handed to the project's own test workers through vitest's `provide()`/`inject()` mechanism rather than a `process.env` write in `globalSetup` itself, which is exactly the pattern `scripts/check-globalsetup-env.sh` (above) exists to keep from regressing.

## Hosted Postgres

Applying this same migration chain to a real hosted Postgres (Neon) connection, which is never a superuser, has its own owner-shape and privilege-bracket requirements. See [`docs/ops/hosted-postgres.md`](ops/hosted-postgres.md) for the full detail rather than repeating it here.

## Out of scope for these docs

This repository also carries a separate autonomous-team engine that runs its own development loop — `backend/`, `hooks/`, most of `scripts/`, `templates/`, `testsupport/`, `tests/`, `archive/`, `.autonomous-team/` and `.claude/`. None of that is part of the product these docs cover, so it is left out here. `scripts/ci/check-pages.py` and `scripts/run-pr-tests.sh` fall under that same "most of `scripts/`" exclusion: they are the autonomous team's own PR-review routing (the `docs` suite `check-pages.py` implements is one of that system's Gate 1 suites, invoked per-PR, not a step `scripts/check.sh` runs) rather than part of this product's build or CI.
