# Testing

What the check runs, how CI scopes a pull request, the tests that guard the whole repository rather than one package, and how test fakes stay as strict as the real services.

Sources:
- `scripts/check.sh`
- `scripts/check-globalsetup-env.sh`
- `scripts/check-agent-run-columns.sh`
- `scripts/ci/affected.mjs`
- `scripts/ci/lanes.mjs`
- `scripts/ci/lanes.json`
- `scripts/ci/full-run-triggers.json`
- `scripts/ci/same-tree.mjs`
- `scripts/ci/declared-imports.mjs`
- `scripts/ci/declared-imports.test.mjs`
- `.github/workflows/ci.yml`
- `package.json`
- `apps/workspace/playwright.config.ts`
- `apps/workspace/e2e/runner-job-guard.mjs`
- `apps/live-e2e/package.json`
- `packages/db/test/audit-log-guard.test.ts`
- `packages/pipeline/test/build/mergeCallSites.test.ts`
- `packages/pipeline/test/stackedPathsNoRepoGate.test.ts`
- `packages/telemetry/test/errorCodes.test.ts`
- `packages/telemetry/src/errorCodes.ts`
- `packages/telemetry/test/errorCodesBranchBinding.test.ts`
- `packages/runner/test/runStatusWriter.test.ts`
- `packages/api/test/openapi-drift.test.ts`
- `packages/api/test/inventory.test.ts`
- `packages/api-client/test/drift.test.ts`
- `apps/web/test/route-inventory.test.ts`
- `packages/github/test/helpers/`
- `packages/db/test/helpers/`
- `packages/webhooks/test/helpers/selfSignedCert.ts`
- `apps/workspace/e2e/fake-github-authorize.mjs`

## The check

`bash scripts/check.sh` is the one command a developer, CI and the platform's own check step all run. It stops at the first failure. In order: `pnpm install --frozen-lockfile`; `scripts/ci/declared-imports.test.mjs`; lint; typecheck; `scripts/check-globalsetup-env.sh`; `scripts/check-agent-run-columns.sh` (no star select over `agent_runs`, which `app_user` may read only column by column); `pnpm test` with the model credentials unset and `FX_FORBID_MODEL_CALLS=1`; `go vet ./...` and `go test ./...` for the VM helper in `packages/fx-runner/vmhelper` (Go, standard library only, run with `GOTOOLCHAIN=local` so Go never fetches another toolchain); the site kit's browser tier; the migration checks (`packages/db/scripts/test-neon-shape.sh`, `check-migration-order.sh`); the `apps/web` build with its trace and baked-path checks; and `pnpm test:guard`.

Two modes share the script. With nothing set it runs everything. With `FX_CHECK_AFFECTED` set to a comma-separated list of package directories (`none` for a change that touches no package) it lints, typechecks and tests only those packages, and runs the web build, the browser tier and the migration shape test only when their package is in the list, and the Go step only when `packages/fx-runner` is (it says it was skipped otherwise). On a hosted runner CI installs Nix with `fallback = true`, so a throttled Actions cache falls back to `cache.nixos.org` rather than failing a job (#1093). The cheap repository-wide guards always run. An empty variable means full, never narrower. `FX_CHECK_DRY_RUN=1` prints each step without running it.

## How CI scopes a pull request

`scripts/ci/affected.mjs` decides, from the commit range of the pull request, whether the run is `full`, `affected` or (private repository only) `overlay`. The packages a change touches plus everything that depends on them run; `scripts/ci/full-run-triggers.json` is the one list of what forces a full run, and the `ci:full` label forces it too. Beyond the declared dependencies, the trigger file adds two kinds of selection. An `extra_edges` entry of kind `test` says that a package's tests read another package's files; it selects the first package when the second is selected, but never that package's own dependents, and edges do not chain (#974). A `repo_wide_scans` entry names a package whose test walks other packages' files without importing them; the package is selected whenever a changed file matches one of the entry's `watch` globs, however far away (#974). For example `apps/workspace` is selected whenever `packages/runner-cloud` is, because `apps/workspace/test/onboarding-engine.test.mjs` reads `packages/runner-cloud/src/placement.ts` by path (#1287). By contrast `packages/runner-cloud` is selected by any change under `apps/`, any package's `src` or the migrations, because its `sandboxInventory.imports.test.ts` walks all of them for the sandbox inventory tables and host-limit fields (#1066). The label is read from the API when the scope step runs, because a re-run replays the original event with its old labels; if that read fails the run is full. A push to `main` is always full. In the private repository a third scope, `overlay`, covers a pull request that changes only overlay paths: it runs the overlay checks (`scripts/ci/overlay-checks.sh`) and not the product suites. A vitest file that exists only to test an overlay script counts as overlay-only, so it no longer forces a full run (#1260). A merge-queue run (`merge_group`) classifies the whole group, so an entry is tested with everything ahead of it: the script lists the commits from the target branch to the group's head, reads each pull request's labels from its `(#N)` subject, and diffs the whole range. The `check` job still runs its full suite on a queue run; only `workspace-e2e` is narrowed to the group's scope. Anything the script cannot establish (a commit with no `(#N)`, a failed label or compare read, `ci:full` on any pull request in the group) answers `full` (#1048). On the private repository a pull request whose every changed file is an overlay path (`scripts/ci/publish-denylist.local`) answers `overlay`: the product suites skip, including the `workspace-e2e` specs, and each job still ends `success` under its real name.

`scripts/ci/lanes.mjs` and its map `scripts/ci/lanes.json` give every changed file exactly one path lane (anything the map does not match is `hot`, as is everything the full-run triggers name), for deciding which pull requests may sit in the merge queue together. A lane is never an input to the scope above, which always comes from the real diff (#1049). `node scripts/ci/lanes.mjs <file>...` prints the lane of each file. The `runner` lane covers `nix/**` as well as the runner packages, so a change to the VM helper's NixOS files is held to the same lane as the code it installs (#1188).

A merge-queue run can skip the heavy steps too. `scripts/ci/same-tree.mjs` answers "same tree" only when the queue group holds exactly one pull request, the checked-out commit's tree is byte-identical to that pull request's head, and the head already carries an `fx-gate1` success posted by the cloud's own App. Then the `check`, `e2e-runner` and `workspace-e2e` jobs skip `Run checks`, the Node 22 step and the specs, and still end `success`. Any doubt or API error means the full suites run. The `check` job's time limit is 90 minutes, or 175 in a merge-queue run while the dormant rollup switch `ROLLUP_ENABLED` is on (`.github/workflows/ci.yml`; see [operations](operations.md#ci)).

## Gate 1

A pull request needs a green full-scope run of the public CI on its exact head before it merges; the repository's ruleset requires the `fx-gate1` status for it. The cloud posts that status itself for a listed repository, from GitHub's own check-run records (see [the architecture](architecture.md#the-clouds-own-fx-gate1)). The five contexts it requires green are `check`, `e2e-runner` and the three `workspace-e2e` viewport jobs. The team's own scripts for the other ways of satisfying Gate 1 are not part of this tree.

## Repository-wide guard tests

These tests read the source tree, not one package's behaviour. A change that adds the kind of thing they watch for has to update them on purpose, in a change a reviewer reads. Run the ones your change could trip before you open a pull request.

| Guard | What it fails on |
|---|---|
| `scripts/ci/declared-imports.test.mjs` | A workspace package importing another without declaring it in `package.json`. A test-only import of a package that would close a cycle is listed as an explicit extra edge instead. |
| `packages/api-client/test/drift.test.ts` | `packages/api-client/src/generated.ts` differing from what the generator writes for `packages/api/openapi.json`. Fix with `pnpm --filter @fx/api-client gen`. |
| `packages/api/test/openapi-drift.test.ts` | `packages/api/openapi.json` differing, byte for byte, from the document built from the route registry. Fix with `pnpm --filter @fx/api gen-openapi`. |
| `packages/api/test/inventory.test.ts` | The route registry's method and path set differing from the one the dispatcher serves and the one in `openapi.json`. |
| `apps/web/test/route-inventory.test.ts` | A `route.ts` under `apps/web/app/api/**` that is not in `apps/web/app/api/ROUTES.allowlist` (and the reverse). A new route needs its allowlist line. |
| `packages/pipeline/test/notStartedRefusals.test.ts` | A code a run can be refused with that is not in the not-started table, or a table row no source produces any more. A new refusal has to be classified as permanent, person-fixable or self-clearing, and each class has fixed words (#1242 added four for the survey start, all permanent). |
| `packages/worker/test/publicSurface.test.ts` | The worker's public surface growing: a new method on what `createWorker` hands a web route, a way to reach its pools, or another caller of the timeout follower. A new worker method has to be added on purpose. |
| `packages/runner-cloud/test/sandboxInventory.imports.test.ts`, `projectRemoveNeverIssued.static.test.ts` | The first fails when a file outside a short list names the sandbox inventory tables or the host-limit fields. The second fails on any `"project_remove"` string literal outside the protocol's own definition: removing a project runs on the session stop and delete jobs, and that job kind is never issued (#1252). |
| `packages/telemetry/test/errorCodes.test.ts`, `errorCodesBranchBinding.test.ts` | A new stop or error code that is not in the telemetry allowlist. A code missing from it is stored as `other`. Every list that names codes needs the new one. `errorCodes.test.ts` also fails when an app directory under `apps/workspace/apps` or `apps/workspace/shell/apps`, or the shell itself, is missing from the client window ids a browser report may name (#953). The engine bridge added its command and decision refusals to that list (`operate_off`, `engine_not_connected`, `halted`, `too_many_pending`, `already_cancelled`, `expired`, `already_delivered`, `not_asked`, #998, #993), and the Team app's `team` window id (#999). The device flow added its nine (`code_not_found`, `code_gone`, `code_unavailable`, `invalid_pop`, `slow_down`, `runner_limit`, `key_registered`, `denied` and `consumed`, #1034). The microVM work added the four reasons a microVM runner gives for not claiming (`microvm_no_kvm`, `microvm_helper_missing`, `microvm_helper_not_ready`, `microvm_helper_out_of_date`) and the six ways a VM job ends (`vm_admission_refused`, `vm_boot_failed`, `vm_egress_unavailable`, `vm_token_delivery_failed`, `vm_workspace_failed`, `vm_teardown_incomplete`); the first four are also pinned by name in the test, and in the database by `test-neon-shape.sh`. The bridge's Connect and Disconnect refusals (`bridge_pending`, `bridge_not_connected`, `runner_too_old`, `runner_choice_needed`, `root_not_offered`), `engine_required` and the placement codes (`machine_single_project`, `machine_not_eligible`, `no_eligible_machine`, `project_already_placed`, `project_not_placed`, `state_carry_unavailable`, #1167)) are in the list too. The Engine plan added its engine-quantity answers (`no_subscription`, `engine_quantity_in_use`, `invalid_quantity`, `payment_pending`, #1166) and its coverage refusals (`plan_required`, `engine_quantity`, `engine_plan_unavailable`, `account_held`, #1168), and the live view its two (`watch_ended`, `watch_limit`, #1172). Quoting, creating and deleting a Hetzner server added its refusals and failure codes (`token_limit`, `machine_kek_unset`, `not_configured`, `not_connected`, `credential_invalid`, `price_changed`, `price_unavailable`, `unknown_size`, `create_failed`, `cleanup_failed`, `projects_placed`, `server_creating`, `registration_timeout`, `server_outcome_unknown` and a `hetzner_` code for each client error, #1177, #1182, #1240). Confirming a project added `placement_busy`, a deadlock between two placement changes that the caller retries (#1223), and `operate_public_pending` for operating on a public repository (#1220), and the Stripe reconcile added `stripe_mirror_drift` and `subscription_not_paying`. Since then the list has gained the install pull request's `install_pr_blocked`, `install_pr_changed` and `install_pr_files_differ` (#1263), the plan draft's `draft_conflict`, `plan_invalid` and `plan_not_reviewed` (#1269), the interview sessions' `stale_rev`, `session_not_active` and `interview_limit` (#1200), and, from the onboarding and machines train (#1284), the server delete refusals (`project_not_on_server`, `server_deleting`, `delete_failed`, `server_not_in_token_project`, `credential_in_use`), the private twin's four (`twin_exists`, `pairing_exists`, `twin_state`, `twin_repo_not_public`) and the survey's two (`survey_needs_runner_update`, `public_survey_consent_required`). The merge gate's hold on a repository that is not clearly private added `public_repo_clamp` (#1303), and the retry of a failed engine stop added `nothing_to_retry` and `cause_gone` (#1293). |
| `packages/db/test/audit-log-guard.test.ts` | Any `audit_log` identifier in source or SQL under `packages/*/src` and `apps/*/{app,src,lib}`, however it is qualified or quoted. Code calls the `audit_write` functions instead; the table's grants are the real control and this scan is a second layer. |
| `packages/pipeline/test/build/mergeCallSites.test.ts` | A file outside the reviewed list that can call the merge, the queue enqueue, the auto-merge document or the merge endpoint, or mint a merge credential. It scans the production sources. Its list holds the port, the runner and, since #1263, the one install-merge call in `packages/runner-cloud/src/runPullRequest.ts`; a second test pins that call to a single site inside `mergeInstall`, on a client fenced to one pull request and head, with the body exactly a sha and a squash method. |
| `packages/pipeline/test/stackedPathsNoRepoGate.test.ts` | The stacked start and the stacked gate stop naming a repository, a pairing, a plan or an account list: the same code must run for every connected repository. |
| `packages/runner/test/runStatusWriter.test.ts` (and its `.pg.` and `.redaction.pg.` siblings) | The run status writer's refusals before any query, its redaction of what it records, and its lock key for `run_events` sequencing, which the test compares with the one `@fx/discussions` takes. |
| `scripts/check-agent-run-columns.sh` | `agent_runs.*`, an alias star, or a bare `*` select or `RETURNING *` over that table. |
| `packages/db/src/rlsInventory.ts` (run by a `packages/db` test) | A `public` table with row-level security missing or not forced. |

## End-to-end projects

- `apps/workspace` has Playwright projects `desktop`, `phone` (Pixel 7) and `tablet` (1024 by 768, touch), run by the `workspace-e2e` job once per project and shard: each project is split into three Playwright shards (`--shard=<n>/3`), so the shard checks are named `workspace-e2e-shard (<project> <n>/3)` and a `workspace-e2e-required` job reports the required `workspace-e2e (<project>)` names only when every shard passed (#1226). The shard job's timeout is 60 minutes (#1218). A layout change needs the full set, not only the specs it adds. Inside a runner job or the runner's own check (`FX_RUNNER_JOB=1` or `FX_RUNNER_CHECK=1`) the Playwright config prints a skip line and exits 0 before any server starts, so the real-browser specs never hang there; a developer host and CI do not set those variables (`apps/workspace/e2e/runner-job-guard.mjs`).
- `e2e-runner` (`pnpm test:e2e-runner`, defined in `@fx/worker`) runs the runner path end to end in one job.
- `apps/live-e2e` holds the live packs that run against a deployed environment; they are not part of the pull request check. See [the live-e2e page](apps/live-e2e.md).

## Fakes must be as strict as the real service

A fake that accepts more than the real service accepts hides bugs until the first live run. Three
of them got through that way: GitHub refuses a request with no `User-Agent` (a raw `https.request`
sends none), Node 20 and later call a custom `lookup` with `{ all: true }` on the normal connect
path, and Neon ends the client's TLS at its proxy so the backend never sees it. Each fake of an
outside service has to enforce what the real one enforces that our code touches, and a network call
is tested through Node's real connection path, not through a hand-called stub. When a behaviour
cannot be faked faithfully, say so in the pull request.

### GitHub REST (`packages/github/test/helpers/strictGithub.ts`)

Two ways in, one rule set (`checkGithubRequest`):

- `strictGithubFetch(innerFake)` wraps an in-process `fetch` fake. Use it for every code path that
  takes a `fetchImpl`. It adds the `user-agent: node` and `accept: */*` that real `fetch` sends, so
  it does not reject a call real `fetch` would make. Pass `explicitUserAgent: true` for a caller that
  sets its own User-Agent on purpose.
- `startStrictGithubServer(route)` (`localTlsServer.ts`) is a real HTTPS server applying the same
  rules to the raw request. Nothing is added for the client, so a missing User-Agent really is
  missing. Use it for anything built on `https.request`, such as the pinned transport.

Enforced:

| Behaviour | Real GitHub | The fake |
| --- | --- | --- |
| No `User-Agent` | 403, plain-text body "Request forbidden by administrative rules ..." | the same |
| `Accept` that cannot be JSON | 415, JSON error | the same |
| Unpublished `X-GitHub-Api-Version` | 400, JSON error | the same |
| `Authorization` other than `Bearer <t>` / `token <t>` | 401 "Bad credentials" | the same |
| `/app/...` without a valid App JWT (RS256, issuer, expiry in the future and within ten minutes) | 401 | the same |
| `/installation/...` and `/user...` without credentials | 401 "Requires authentication" | the same |
| A request body that is not JSON, or has no JSON content type | 400 "Problems parsing JSON" | the same |
| Error bodies | JSON with `message`, `documentation_url`, `status` | built by `ghError` |
| Listings (`/installation/repositories`, `/user/installations`) | `total_count`, 100 per page at most, `Link: rel="next"` | `pagedListing`; a listing without `total_count` and its array throws |
| Host | `api.github.com` or `github.com` over HTTPS | any other target throws |

Not faked: rate limits and secondary rate limits, abuse detection, the wording of every error, and
the OAuth device and web flows beyond the token exchange. The messages used are the ones the code
under test branches on.

`apps/workspace/e2e/fake-github-authorize.mjs` stands in for the browser-facing authorize page, not
the REST API. It answers 404 without a `client_id`, 422 for a `redirect_uri` that is not an
absolute URL, 400 without the `state` this app requires, and 404 for anything but GET.

### Node's real connection path (`packages/github/test/helpers/localTlsServer.ts`)

`startLocalTlsServer` serves HTTPS on 127.0.0.1 with a throwaway certificate whose names are the
ones the client connects to (`api.github.com`). The certificate goes to the client as its explicit
`ca`. `rejectUnauthorized: false` is not used, so the SNI name, hostname check and chain check all
run. `httpsRoundTrip` makes the request with `autoSelectFamily` left at its default (on) and refuses
to run if the process turned it off. A pinned `lookup` that does not answer `{ all: true }` fails
here with `ERR_INVALID_IP_ADDRESS`; it passed when the test called the lookup by hand.

The gh-proxy tests run the real pinned transport (`createNodeHttpsPinnedRequester({ port, ca })`)
against the strict GitHub server, including the installation-token mint.

### Seeded accounts

The seed helpers in `packages/db/test/helpers/` (`seed.ts`, `members.ts`) and the matching ones in `packages/github`, `packages/model-connection` and `packages/model-router` insert a `starter` account with `hosted_plan_paid = true`. Hosted entitlements read that flag (migration 1048), so a test account that leaves it out is refused as if it paid for engines only.

### Postgres behind TLS (`packages/db/test/helpers/pgTls.ts`)

- `enableClusterTls(admin)` turns TLS on in the local test cluster with a throwaway certificate.
  Clients pass it as `ssl: { ca }`.
- `startTlsTerminatingProxy(upstreamPort)` is the Neon shape: the client negotiates and verifies
  TLS with the proxy, which forwards plain bytes to the cluster, so `pg_stat_ssl` on the backend
  reports no TLS. Checks of "is this connection TLS" must therefore look at the client socket.

Not faked: Neon's SNI-based endpoint routing, its pooler, and its public certificate chain.

### Rule of thumb

If you add a fake of an outside service, list what the real service refuses, make the fake refuse
the same, and add a test that the stricter fake would have caught the bug a lenient one let through.
