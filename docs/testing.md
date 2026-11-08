# Testing

What the check runs, how CI scopes a pull request, the tests that guard the whole repository rather than one package, and how test fakes stay as strict as the real services.

Sources:
- `scripts/check.sh`
- `scripts/check-globalsetup-env.sh`
- `scripts/check-agent-run-columns.sh`
- `scripts/ci/affected.mjs`
- `scripts/ci/full-run-triggers.json`
- `scripts/ci/declared-imports.mjs`
- `scripts/ci/declared-imports.test.mjs`
- `.github/workflows/ci.yml`
- `package.json`
- `apps/workspace/playwright.config.ts`
- `apps/live-e2e/package.json`
- `packages/db/test/audit-log-guard.test.ts`
- `packages/pipeline/test/build/mergeCallSites.test.ts`
- `packages/pipeline/test/stackedPathsNoRepoGate.test.ts`
- `packages/telemetry/test/errorCodes.test.ts`
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

`bash scripts/check.sh` is the one command a developer, CI and the platform's own check step all run. It stops at the first failure. In order: `pnpm install --frozen-lockfile`; `scripts/ci/declared-imports.test.mjs`; lint; typecheck; `scripts/check-globalsetup-env.sh`; `scripts/check-agent-run-columns.sh` (no star select over `agent_runs`, which `app_user` may read only column by column); `pnpm test` with the model credentials unset and `FX_FORBID_MODEL_CALLS=1`; the site kit's browser tier; the migration checks (`packages/db/scripts/test-neon-shape.sh`, `check-migration-order.sh`); the `apps/web` build with its trace and baked-path checks; and `pnpm test:guard`.

Two modes share the script. With nothing set it runs everything. With `FX_CHECK_AFFECTED` set to a comma-separated list of package directories (`none` for a change that touches no package) it lints, typechecks and tests only those packages, and runs the web build, the browser tier and the migration shape test only when their package is in the list. The cheap repository-wide guards always run. An empty variable means full, never narrower. `FX_CHECK_DRY_RUN=1` prints each step without running it.

## How CI scopes a pull request

`scripts/ci/affected.mjs` decides, from the commit range of the pull request, whether the run is `full`, `affected` or (private repository only) `overlay`. The packages a change touches plus everything that depends on them run; `scripts/ci/full-run-triggers.json` is the one list of what forces a full run, and the `ci:full` label forces it too. The label is read from the API when the scope step runs, because a re-run replays the original event with its old labels; if that read fails the run is full. A push to `main` is always full, and a merge-queue run (`merge_group`) is full scope too.

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
| `packages/telemetry/test/errorCodes.test.ts`, `errorCodesBranchBinding.test.ts` | A new stop or error code that is not in the telemetry allowlist. A code missing from it is stored as `other`. Every list that names codes needs the new one. |
| `packages/db/test/audit-log-guard.test.ts` | Any `audit_log` identifier in source or SQL under `packages/*/src` and `apps/*/{app,src,lib}`, however it is qualified or quoted. Code calls the `audit_write` functions instead; the table's grants are the real control and this scan is a second layer. |
| `packages/pipeline/test/build/mergeCallSites.test.ts` | A file outside the reviewed list that can call the merge, the queue enqueue, the auto-merge document or the merge endpoint, or mint a merge credential. It scans the production sources. |
| `packages/pipeline/test/stackedPathsNoRepoGate.test.ts` | The stacked start and the stacked gate stop naming a repository, a pairing, a plan or an account list: the same code must run for every connected repository. |
| `packages/runner/test/runStatusWriter.test.ts` (and its `.pg.` and `.redaction.pg.` siblings) | The run status writer's refusals before any query, its redaction of what it records, and its lock key for `run_events` sequencing, which the test compares with the one `@fx/discussions` takes. |
| `scripts/check-agent-run-columns.sh` | `agent_runs.*`, an alias star, or a bare `*` select or `RETURNING *` over that table. |
| `packages/db/src/rlsInventory.ts` (run by a `packages/db` test) | A `public` table with row-level security missing or not forced. |

## End-to-end projects

- `apps/workspace` has Playwright projects `desktop`, `phone` (Pixel 7) and `tablet` (1024 by 768, touch), run by the `workspace-e2e` job once per project. A layout change needs the full set, not only the specs it adds.
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
