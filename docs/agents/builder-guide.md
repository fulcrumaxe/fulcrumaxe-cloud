# Builder guide

What a builder, reviewer or planning agent needs to know before changing this repository: how to run
the check, which repository-wide guards a change can trip and how to satisfy each one, the rules for
migrations, database tests, fakes and UI work, how to write the pull request, and when to stop and
report instead of guessing.

Read this page in full before your first change. [Testing](../testing.md) has the longer reference
for the check and the guard tests; this page is the working checklist built on it.

Sources:
- `scripts/check.sh`
- `package.json`
- `flake.nix`
- `vitest.workspace.ts`
- `.github/workflows/ci.yml`
- `scripts/ci/affected.mjs`
- `scripts/ci/declared-imports.test.mjs`
- `scripts/ci/check-migration-compat.mjs`
- `scripts/ci/pr-link-policy.sh`
- `packages/db/migrations/README.md`
- `packages/db/scripts/check-migration-order.sh`
- `packages/db/scripts/test-neon-shape.sh`
- `packages/db/scripts/neon-shape-entries.sh`
- `packages/db/test/support/ephemeral-pg.ts`
- `packages/test-guard/src/setup.ts`
- `packages/api/test/contract.test.ts`
- `apps/workspace/playwright.config.ts`
- `apps/workspace/e2e/helpers/boot.ts`
- `apps/workspace/e2e/helpers/pixel.ts`
- `lint/no-silent-catch.mjs`

## 1. Before you write code

- Read the task's Spec and its acceptance criteria. The criteria are the contract. Implementation
  hints are advice: you may take a better route, and you say why in the pull request.
- Read the criteria again against the code on the current default branch, not against the Spec's
  description of it. Specs are written earlier than you build. Re-prove every claim the Spec makes
  about existing code (a function name, a file, a column, a route) before you build on it.
- Write down the files you expect to touch and compare them with the task's file list. If they
  differ, read section 10 before you start.
- Read the package page under `docs/packages/` or `docs/apps/` for every package you will touch, and
  the existing tests next to the code. Reuse the helpers those tests already use.
- Use the names that already exist. Search for a type, error code or column before you add one; a
  second name for the same thing is a defect.

## 2. The environment

- Work inside the Nix dev shell. `nix develop` gives Node 24, pnpm, the Postgres binaries
  (`initdb`, `pg_ctl`) the database tests start, and the Playwright browsers. CI runs every step
  inside `nix develop .#ci`; use that shell when you need to reproduce a CI result exactly.
- Install with `pnpm install --frozen-lockfile`. Never change `pnpm-lock.yaml` unless the task adds
  or removes a dependency, and never symlink `node_modules` from another checkout: an install then
  writes through the link into the other tree.
- Run tests in a clean checkout of this repository. A tree that holds extra files (a private
  overlay, an old build, leftover output) can make a test pass that fails in CI.
- Some guards list files through git (for example `scripts/ci/declared-imports.test.mjs` and the
  worker login-reader scans). In a tree extracted without `.git`, run `git init -q && git add -A`
  first, or the scan fails or sees nothing.
- Never set `FX_PLAN_DATA` for a test. `packages/test-guard/src/setup.ts` loads the scaled test
  fixture (`packages/plan-data/fixtures/plan-data.scaled.fixture.json`) when it is unset. Tests use
  fixture values only, never real plan figures.
- Tests run with the model credentials unset and `FX_FORBID_MODEL_CALLS=1`. No test may call a model
  or start an agent CLI; the test guard fails it.
- If a guard about the environment fails locally but passes in CI, check your shell for variables
  your tooling injected (`VERCEL_PLUGIN_BOOTSTRAP_HINTS` is a known one) and rerun with `env -u`.
- Run one heavy suite at a time, in the foreground. Two full suites at once on one machine produce
  timeouts that look like failures. Do not kill a database suite with an outside timeout: the
  throwaway Postgres cluster outlives it (the harness reaps stale clusters on its next start).

## 3. The check

`bash scripts/check.sh` is the one command a developer, CI and the platform's own check step run.
It stops at the first failure. In order it runs: install, the declared-imports test, lint,
typecheck, `scripts/check-globalsetup-env.sh`, `scripts/check-agent-run-columns.sh`, `pnpm test`,
the site kit's browser tier, the migration shape and order checks, the `apps/web` build with its
trace and baked-path checks, and `pnpm test:guard`.

- Full: `bash scripts/check.sh`. Run it before you report a change as done whenever you can.
- Affected: `FX_CHECK_AFFECTED=packages/db,apps/web bash scripts/check.sh` lints, typechecks and
  tests only those workspace directories (comma-separated, `none` for a change that touches no
  package). The cheap repository-wide guards still run. An empty variable means full.
- Dry run: `FX_CHECK_DRY_RUN=1 bash scripts/check.sh` prints each step without running it.
- One test file: `pnpm exec vitest run <path>` from the root, for example
  `pnpm exec vitest run packages/db/test/audit-log-guard.test.ts`.
- One package's projects: `node scripts/ci/vitest-projects.mjs packages/api` prints the vitest
  project names, then `pnpm exec vitest run --project <name>`.
- Lint the files you changed with `pnpm exec eslint <files>`, as `check.sh` runs it. Typecheck with
  `pnpm typecheck`, which runs every package.

The affected list is not "the packages I edited". A guard test lives in one package and scans the
whole tree, so it does not run when only your package is listed. When you use affected mode, add
the packages that own the guards in section 4 that your change can trip, plus every package that
imports the one you changed. Run the whole suite of every package you change, including its
Postgres tests and static scans; hand-picked test files miss the ones you did not think of.

How CI scopes a pull request: `scripts/ci/affected.mjs` picks `full` or `affected` from the commit
range, and `scripts/ci/full-run-triggers.json` lists the paths that force a full run. The `ci:full`
label forces one too. A push to the default branch always runs full.

## 4. Repository-wide guards

These tests read the source tree, not one package's behaviour. Find the rows your change matches,
run those tests before you report, and name them (or "not affected" with the reason) in the pull
request.

| If your change... | Run | And do |
|---|---|---|
| imports another workspace package, in source or in a test | `node --test scripts/ci/declared-imports.test.mjs` and `pnpm typecheck` | Declare it in `package.json` (`devDependencies` for a test-only import). A test import compiles the other package under your package's flags, so typecheck everything, not just your package. |
| adds or changes an API route or schema | `packages/api/test/openapi-drift.test.ts`, `packages/api/test/inventory.test.ts`, `packages/api-client/test/drift.test.ts`, `packages/api/test/contract.test.ts` | Regenerate with `pnpm --filter @fx/api gen-openapi`, then `pnpm --filter @fx/api-client gen`, and commit `packages/api/openapi.json` and `packages/api-client/src/generated.ts`. Never edit either by hand. |
| adds `apps/web/app/api/**/route.ts` | `apps/web/test/route-inventory.test.ts` | Add its line to `apps/web/app/api/ROUTES.allowlist`. Run every test that enumerates routes or `vercel.json`: `git grep -l "vercel.json\|ROUTES.allowlist" -- '*.test.*'`. |
| adds a cron to a `vercel.json` | `apps/live-e2e/test/platform-pack.test.ts` | Declare its probe; the test fails on a scheduled cron no probe covers. |
| adds an error or stop code | `packages/telemetry/test/errorCodes.test.ts`, `errorCodesBranchBinding.test.ts` | Add it to `OWN_ERROR_CODES` in `packages/telemetry/src/errorCodes.ts`; an unlisted code is stored as `other`. Then add it to every other list that names codes: grep for a sibling code. Queue and stop sentences are checked by `apps/workspace/test/queue-wait-sentences.test.mjs` and `apps/workspace/test/pipeline-insight.test.mjs`. |
| reads or writes audit rows | `packages/db/test/audit-log-guard.test.ts` | Never name `audit_log` in source or SQL under `packages/*/src` or `apps/*/{app,src,lib}`, however it is quoted. Call the `audit_write` functions. |
| merges, enqueues, pushes or mints a merge credential | `packages/pipeline/test/build/mergeCallSites.test.ts` | Only the reviewed files may do this. A new call site is a design question: stop and report. |
| touches the stacked start or stacked gate path | `packages/pipeline/test/stackedPathsNoRepoGate.test.ts` | Never branch on a repository, pairing, plan or account list there: the same code runs for every connected repository. |
| writes run events or run status | `packages/runner/test/runStatusWriter.test.ts` and its `.pg.` siblings | Exactly two files insert into `run_events`, with the same per-run lock key. Do not add a third writer. |
| adds a pipeline stage writer | `packages/core/test/unit/halt-writers.test.ts` | Each writer names `WorkItemHaltedError` or is on the exempt list with a reason. Include `packages/core` in an affected run. |
| selects from `agent_runs` | `bash scripts/check-agent-run-columns.sh` | Name columns. No `*`, alias star or `RETURNING *`. |
| edits `packages/worker/src/compositionRoot.ts` | `packages/worker/test/compositionRootShape.test.ts` | Keep one top-level property per line in what `buildWorker` returns. |
| touches the worker's database logins | `packages/worker/test/runnerLoginReader.test.ts`, `receiptLoginReader.test.ts` | Only `pools.ts` names those variables or imports worker internals. |
| changes which GitHub calls a client may make | `apps/web/test/localOnlyHttp.test.ts` | It enumerates the allowed and refused paths; a new path is a new line there, reviewed. |
| adds a table, policy, view or function | `packages/db/test/rls-inventory.test.ts`, `packages/db/test/partners-isolation.test.ts`, `packages/github/test/ghProxyNarrowLogin.pg.test.ts` | Enable and force row-level security. A policy that mentions `app.user_id` must also join `account_members` or `partner_members`. Revoke `EXECUTE` from `PUBLIC` on a new function. |
| adds a `catch` | `pnpm exec eslint <file>` | `fx-catch/no-silent-catch` refuses a catch that swallows. Rethrow, report the error, log it, or add `// fx-swallow-ok: <reason>`. |
| adds a `globalSetup.ts` | `bash scripts/check-globalsetup-env.sh` | Never write `process.env` there and never pick a port with `Math.random()`. Use `provide()` and the bind-test-env setup file. |
| adds UI files to `apps/workspace` | `apps/workspace/test/boot-budget-constants.test.mjs`, `apps/workspace/e2e/boot-budget.spec.ts` | The boot file budget in `apps/workspace/build/budget.mjs` is a hard limit. Put new UI in an existing file; if it cannot fit, stop and report. |
| changes the `apps/web` build or reads a file at run time | `pnpm --filter web build`, then `node apps/web/scripts/check-next-trace.mjs` and `node apps/web/scripts/check-baked-paths.mjs` | A runtime path must work from the built output moved to another directory. Never weaken either check. |

When a guard fails, fix the code, not the guard. Changing a guard's list or exemption is allowed
only as a deliberate part of the change, with the reason in the pull request, so a reviewer reads
it. A green run of your own package's tests says nothing about these guards.

## 5. Migrations

The rules live in `packages/db/migrations/README.md`. In short:

- Number a new file one above the highest number on the current default branch:
  `git ls-tree --name-only origin/main packages/db/migrations/` (fetch first). A number written in
  a Spec is advisory; take the next free one and say so in the pull request. If another open
  change has taken that number, take the next and say which one you stepped over.
- Name it `NNNN_snake_case.sql`. One file per number. No symlinks.
- Never edit, rename or delete a migration that is already on the default branch. Databases that
  applied it record its checksum and refuse an edited file. Change the schema with a new file.
- Make it expand-only: add and widen, never drop, rename, retype or add `NOT NULL` without a
  default. The previous deploy must still run on the new schema. `node
  scripts/ci/check-migration-compat.mjs` enforces this; a contract step needs a marker comment
  naming the expand step it follows.
- A new `SECURITY DEFINER` function needs an exact entry in
  `packages/db/neon-shape.d/<migration>.conf` (the grammar is in
  `packages/db/scripts/neon-shape-entries.sh`), a pinned `search_path`, an owner that matches its
  kind, and `EXECUTE` granted to the one role that calls it. "The same as an older migration" is
  not proof: older files may be exempt from checks a new one must pass.
- Run before you report: `bash packages/db/scripts/check-migration-order.sh --base origin/main`,
  `bash packages/db/scripts/test-neon-shape.sh`, `node scripts/ci/check-migration-compat.mjs`, and
  the whole `packages/db` suite (`pnpm --filter @fx/db test`), including the inventory tests above.
- Many tests read migration files by name. A test that counts or lists functions, roles or grants
  may need its expected list extended: that is part of the change, not a reason to loosen it.
- Two changes that touch the same tables can each pass and still break together. Before you report,
  check whether an open change touches the tables yours does, and say so if one does.

## 6. Tests against Postgres

- Database tests run against a real Postgres with the real migrations applied, never a mock of the
  database. The harness is `packages/db/test/support/ephemeral-pg.ts`: each package's
  `globalSetup.ts` starts a throwaway cluster, runs the migration chain, and hands the URLs to the
  workers through `provide()` and `test/support/bind-test-env.ts`.
- Name a database test `*.pg.test.ts` and copy the setup from a sibling in the same package. Use
  the seed and helper files under `packages/db/test/helpers/` (`seed.ts`, `throwaway-db.ts`,
  `pgErrors.ts`) instead of writing your own.
- Connect as the role the code really uses (`app_user`, `platform_ops`, `partner_user`), through
  `withTenant` or `withPartner`, so row-level security and grants are part of what is tested. A test
  run as the superuser proves nothing about access.
- Test races with real transactions: open two, commit them in both orders, and assert the result.
- Never depend on the wall clock. Pass the time in, or force every case (each slot, each boundary).
  A test that reads the real clock fails at some hour of the day.
- Avoid wall-time assertions ("under 900 ms"); CI machines are loaded. Assert counts or order.

## 7. Fakes, fixtures and contracts

- A fake of an outside service must refuse what the real service refuses. Use the strict GitHub
  fakes in `packages/github/test/helpers/` (`strictGithub.ts`, `localTlsServer.ts`) and the TLS
  helpers in `packages/db/test/helpers/pgTls.ts`. [Testing](../testing.md#fakes-must-be-as-strict-as-the-real-service)
  lists what each enforces.
- Test a network call through Node's real connection path (a local TLS server), not a hand-called
  stub. Bugs that shipped this way: no `User-Agent` on a GitHub call, a custom DNS lookup that did
  not answer `{ all: true }`, and TLS that ends at a proxy.
- If you add a fake, list what the real service refuses, make the fake refuse the same, and add a
  test the strict fake catches and a lenient one would not.
- API response shapes come from `packages/api/fixtures/v1/<operationId>/<status>-<name>.json`,
  which `packages/api/test/contract.test.ts` validates against `openapi.json`. UI tests and the
  workspace fixture server use these files. Never invent a response shape in a test.
- A fixture server must reject what the real route rejects (a missing field, an empty body). One
  that accepts anything lets a broken button through.
- When a behaviour cannot be faked faithfully, say so in the pull request, and say what you did not
  exercise.

## 8. What the tests must prove

- Every acceptance criterion has at least one test, and the test asserts the whole criterion. "A
  differs from B only in X" needs both halves: the X difference, and sameness everywhere else.
- Mutation-check every new branch. Break it (invert the condition, drop the filter, remove the
  call), run the tests, and confirm a named test goes red. Restore it. Report each mutation and the
  test that caught it. A branch no mutation catches is untested; add the test.
- Test the undo path and every state, not only the happy path. For anything a person adds,
  connects or turns on, cover remove, disconnect, expire, uninstall and the mistake (wrong input,
  a second click, a stale page), and check the data, every screen that shows it, and what refreshes.
- Prefer state derived from current truth over a stamped copy, and say which you chose and why.
- A screen never shows `null`, `undefined`, an empty bracket or an internal label. Pickers show
  names a person knows, never ids.
- Every route that calls an outside service, starts compute or writes on each call needs a
  server-side limit for every kind of caller, browser sessions included.
- Never trim, fold or merge tests to fit a size line. Tests do not count toward it. If the change
  is too big with its tests, stop and report.
- Report each suite you ran with its pass and fail counts and its exit code. A summary line from
  the end of a noisy run is not a result.

## 9. UI work in apps/workspace

- The workspace has three Playwright projects: `desktop`, `phone` and `tablet`. CI runs the whole
  suite once per project. Run it the same way:
  `pnpm --filter workspace e2e --project=phone` (and `desktop`, `tablet`). The script builds
  `dist/` first.
- For any change to layout, the shell, shared CSS, or anything always on screen, run the full suite
  on all three projects, not only your own specs. A fixed strip or overlay can cover other apps'
  buttons on one viewport and nowhere else.
- Locally, Playwright reuses a server already listening on the default ports and may serve an old
  build. Run on free ports after a fresh build: `E2E_PORT=4419 E2E_FIRST_PARTY_PORT=4420`.
- Pages run on a fake clock (`apps/workspace/e2e/helpers/boot.ts` installs it). Derive test dates
  from the page clock, never from `Date.now()` in the test process.
- A visual claim needs a number. Use `pixelDiff` in `apps/workspace/e2e/helpers/pixel.ts` against
  the same layout on the default branch, on a high-contrast backdrop, with a negative control that
  must differ. File sizes are not a diff.
- Test a flow through the real controls: click, type, save, reload, check what persisted, then
  undo and check again. A test that only proves a window opens is a render check.
- Touch targets, focus order and labels are part of the change. Check them on the phone project.
- A job that times out on your change and not on others is your regression. Never raise a timeout
  to make it pass.
- `pnpm test:e2e-runner` runs the runner path end to end; run it if you change the job path, the
  runner protocol or the routes the runner calls.

## 10. Scope and the file list

- Change only what the task asks for. Do not refactor nearby code, rename things, or fix an
  unrelated defect you noticed; report it instead.
- Keep to the task's file list. Some files are derived from the ones you edit and are expected to
  change with them: `openapi.json` and `generated.ts`, API fixtures, a `ROUTES.allowlist` line, a
  telemetry code, a `neon-shape.d` entry. If the list is fixed and a guard needs a derived file
  that is not on it, stop and report which file, which guard needs it and the one-line change. Do
  not leave the guard red and do not widen the change silently.
- A file outside the list that is not derived (a new module, a migration the Spec did not plan, a
  change to another package's behaviour) is a scope question. Stop and report it with a
  recommendation.
- Respect the task's size line. It counts source lines; tests, fixtures and generated files are
  reported, not counted. If you are heading past it, stop and report before you push.
- Do not touch lockfiles, CI workflows or secrets unless the task says so.
- Any code that creates, deletes, renames or links files under a state, install or cache
  directory checks each path with `lstat`, refuses symlinks and the wrong file type, uses lexical
  containment (not `realpath`), and refuses a delete at a root it did not validate. Test each
  refused case and assert nothing outside the tree changed.
- A change to runner job settings (permissions, sandbox, hooks) needs a test that runs a real
  sandboxed shell under those settings, as `packages/fx-runner/test/engines/claude/bashSandbox.bwrap.test.ts`
  does. A test that compares rule strings cannot see a rule that disables the shell.
- Security changes start from the threat model: who the adversary is, what is at risk, what is out
  of scope. Prefer an allowlist and a fail-closed default to a growing denylist.

## 11. The pull request

The pull request is public. Write it for a reader who has only this repository.

- Start the body with the provenance line your task gives you: the issue it closes, or a bare
  `Refs D#N` / `Closes D#N` reference. Never a URL to a private repository, and never a
  Discussion title, quote or Spec text. `scripts/ci/pr-link-policy.sh` refuses the wrong form.
- Say in your own words what changed, why, and anything you did differently from a hint in the
  Spec.
- List the tests and guards you ran with their exit codes, the mutations you checked and what
  caught each, and what you did not run or could not fake.
- Name every migration number you took and every derived file you regenerated.
- No plan prices or limits, hostnames, secrets, tokens, customer names or private identifiers in
  the title, body, commit message or code. Tests use fixture values.
- Write commit messages as a person would: what changed and why, no process references.
- In a fix round, fix every finding on the same branch, rerun what the finding touched plus the
  guards, and never open a second pull request.

## 12. When to stop and report

Stop, push nothing, and report with options and a recommendation when:

- a criterion is ambiguous, contradicts another, or cannot be met as written. Quote the criterion
  number. Never redefine it, and never write a test for a weaker reading;
- a claim the Spec makes about existing code is false on the default branch;
- the true fix goes past the size line, needs a schema change, a migration, a new credential or a
  new outside call the task did not plan, or touches a file outside the list (section 10);
- a guard in section 4 would have to be loosened for your change to pass;
- an open change touches the same files or tables and the order matters;
- the environment blocks a step the check needs (a missing binary, a refused command). Say which
  step and what you saw; do not work around it.

Phrases like "nothing requires...", "interpreted as..." or "treated as a design choice" in a report
usually hide a missed criterion. If you are about to write one, stop and report instead.

Guess only where the answer is reversible, cheap and inside the task: a local variable name, the
order of two independent statements, the wording of a test title. Say what you guessed.

## 13. Reviewing a change

Reviewers use the same checklist:

- For each criterion, find the test and check that it asserts the whole criterion.
- Run the guards from section 4 that the diff matches, the lint step on the changed files, and the
  whole suite of each changed package. Do not accept "tests are green" without the exit codes.
- Repeat at least one reported mutation and confirm the named test goes red.
- Check the undo path and every state, the strictness of each new fake, and the scope against the
  file list.
- A CI run that failed at an early step proves nothing about the later steps.
- Flag wording that turns a criterion gap into a choice.
