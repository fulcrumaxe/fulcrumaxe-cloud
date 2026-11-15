# apps/live-e2e

Live end-to-end packs that run against a deployed app: staging today, and a read-only production smoke for the packs that list production. `apps/live-e2e` holds the pack manifest and selection, the targets with their production guards, the needs checks, the `plan` and `run` commands, signed-in session storage, the janitors that reset the test account and repos, issue reporting, and the scrub that gates artifact upload. `run` starts Playwright's Chromium for each selected pack; `plan` never loads a browser or touches the network.

Sources:
- `apps/live-e2e/package.json`
- `apps/live-e2e/bin/live-e2e.mjs`
- `apps/live-e2e/src/manifest.ts`
- `apps/live-e2e/src/select.ts`
- `apps/live-e2e/src/targets.ts`
- `apps/live-e2e/src/client.ts`
- `apps/live-e2e/src/needs.ts`
- `apps/live-e2e/src/needs-network.ts`
- `apps/live-e2e/src/plan.ts`
- `apps/live-e2e/src/run.ts`
- `apps/live-e2e/src/limits.ts`
- `apps/live-e2e/src/routing.ts`
- `apps/live-e2e/src/ledger.ts`
- `apps/live-e2e/src/affected.ts`
- `apps/live-e2e/routing-ledger.json`
- `apps/live-e2e/src/cli.ts`
- `apps/live-e2e/src/probes.ts`
- `apps/live-e2e/src/staging-only.ts`
- `apps/live-e2e/src/workflow-routes.ts`
- `apps/live-e2e/src/store.ts`
- `apps/live-e2e/src/sessions.ts`
- `apps/live-e2e/src/sessions-cli.ts`
- `apps/live-e2e/src/last-tested.ts`
- `apps/live-e2e/src/issues.ts`
- `apps/live-e2e/src/janitor/cli.ts`
- `apps/live-e2e/src/janitor/account.ts`
- `apps/live-e2e/src/janitor/repo.ts`
- `apps/live-e2e/src/janitor/repos.ts`
- `apps/live-e2e/pw/config.ts`
- `apps/live-e2e/src/report.ts`
- `apps/live-e2e/src/scrub.ts`
- `apps/live-e2e/src/mask.ts`
- `apps/live-e2e/targets/staging.json`
- `apps/live-e2e/targets/production.json`
- `apps/live-e2e/packs/platform/pack.json`
- `apps/live-e2e/packs/auth-negative/pack.json`
- `apps/live-e2e/packs/auth/pack.json`
- `apps/live-e2e/packs/auth-scripted/pack.json`
- `apps/live-e2e/packs/api-contract/pack.json`
- `apps/live-e2e/packs/shell/pack.json`

## Using it

```
pnpm --filter live-e2e exec live-e2e plan --target staging --tier smoke
pnpm --filter live-e2e exec live-e2e run  --target staging --tier smoke
```

`plan` writes `plan.json` (ignored by git) and prints one line per selected pack: `RUN`, `SKIPPED-NEED <need>` (green, listed) or `REFUSED <reason>`. A refusal of a pack named with `--pack` exits non-zero; an empty selection exits non-zero with `EMPTY-SELECTION`. `run` takes the same flags (`--target`, `--tier`, `--pack`, `--tag`, `--trigger`, `--changed-from`, `--out`), builds the same plan, then runs the selected packs through Playwright one after another and writes `results.json`, `summary.md` and a scrubbed log per pack next to the plan (`apps/live-e2e/src/run.ts`). `--budget-usd` is not accepted.

The other commands in `apps/live-e2e/src/cli.ts`:

- `scrub --dir <folder>`: the upload gate, described below.
- `issues --results <file> --repo <owner/name>`: opens, comments on or closes one issue per failing pack and target, labelled `live-e2e` (a production failure also gets `needs-owner`). It reads `GITHUB_TOKEN` and posts a scrubbed team-log line for an unattended run that failed (`apps/live-e2e/src/issues.ts`).
- `last-tested record|show --target <name>`: a small JSON store in the run user's home with the last commit tested per target, its tier and outcome (`apps/live-e2e/src/last-tested.ts`).
- `workflow-routes --build-dir <apps/web/.next>`: lists the Workflow SDK routes from the built output, which every probe list in the `platform` pack must cover (`apps/live-e2e/src/workflow-routes.ts`).
- `capture-session` and `sessions keep-alive|status|forget`: see Sessions.
- `janitor account|repo|repos`: see Janitors.

## Packs

A pack is a folder under `apps/live-e2e/packs/` with a `pack.json` and a Playwright spec. At HEAD there are six:

| Pack | Tier | Targets | Needs |
|---|---|---|---|
| `platform` | smoke | staging, production | `bypass` |
| `auth-negative` | smoke | staging, production | `bypass` |
| `auth` | standard | staging | `bypass`, `session:owner` |
| `shell` | standard | staging | `bypass`, `session:owner` |
| `api-contract` | standard | staging | `bypass`, `session:owner` |
| `auth-scripted` | standard | staging | `bypass`, `signin:scripted` (destructive) |

`platform` also declares 21 refusal probes: requests that must be answered with a 4xx. Only `auth-scripted` is destructive, and its `signin:scripted` need is never met, because the list of roles allowed to sign in by script is empty (`SCRIPTED_SIGNIN_ROLES` in `apps/live-e2e/src/needs.ts`); its selection is skipped.

## Rules the code enforces

- A pack's `pack.json` has a closed set of keys and a closed set of needs.
  A `@ui` pack must list all three device projects; `model_spend` is allowed
  only on tier `full`.
- Selection is a union of the tier, the named packs and changed-file
  routing, narrowed by `--tag`. A model-spending pack runs only for the
  `dispatch` and `weekly` triggers.
- A target file carries no destructive switch; its loader rejects any key
  outside the schema. On the production target the runner refuses every
  destructive pack and every pack that does not list production (layer 1, in
  `targets.ts`). There is no `--force`.
- A target file names, rather than holds, its deployment origin and Vercel project id (`origin_env`, `project_id_env`). The loader reads those variables when the target is selected (`LIVE_E2E_STAGING_ORIGIN` and `LIVE_E2E_STAGING_PROJECT_ID` for staging; the `PRODUCTION` pair for production) and refuses, naming the variable, if one is unset. There is no default host.
- Env-only needs: `bypass` (the target is protected and the bypass secret is
  present), `stripe-test` (a restricted test-mode key, never a live one) and
  `host-capacity` (load under 18 and at least 4 GiB available). Network needs
  (`session:<role>`, `model-key`, `test-repo`, `caps-set`, `sandbox`,
  `github-app:<name>`, `fresh-state:<name>`) are probed only by `run`, with GET
  requests, for the packs about to start; `plan` is offline, so it counts them
  as unmet. An unproven need skips the pack, except `caps-set`: a spend limit
  above the ceiling, or caps that cannot be read, is `REFUSED caps` and fails
  the run (`apps/live-e2e/src/needs-network.ts`).
- Before any pack that is not production-safe runs, the origin is asked who it
  is (`/api/health`): `deploy_env` must be `staging` and the project id must
  match the staging target file (layer 2, `identityGuard` in `targets.ts`).
- The API client is the fence (`apps/live-e2e/src/client.ts`): the bypass secret
  goes only to the exact target origin, redirects are followed by hand and
  re-checked at every hop, a write to the production host is refused, a
  staging run may not reach the production host at all, and a 3xx answer to a
  non-read is an error. The only writes allowed on production are declared
  refusal probes (`probes.ts`), sent with no credentials and expected to be
  answered 4xx.
- A test titled `@staging-only` is listed as skipped by `plan` on production
  and filtered out of the Playwright run with `--grep-invert`
  (`apps/live-e2e/src/staging-only.ts`).
- Playwright is configured in `apps/live-e2e/pw/config.ts`: the same three
  device projects as the workspace app, trace, video and HAR off, service
  workers blocked, and 2 workers by default (4 at most, `LIVE_E2E_WORKERS`). Each
  pack runs in a child process that gets only the variables its needs call for.

## Changed-files routing

`plan --changed-from <base>..<head>` diffs the two commits and adds packs; it
never removes one the tier or a name already selected, and never adds a `full`
pack.

- Each changed file selects every pack whose `paths` glob matches it, and
  `plan.json` records every (file, pack, glob) match under `routing`.
- A file that no selectable pack claims selects every pack at or below
  `standard`, unless `apps/live-e2e/routing-ledger.json` exempts it. A ledger
  entry is a glob (at least two directory levels deep, or one file) plus a
  written reason; a test fails when an entry matches no tracked file or matches
  a file a pack now claims.
- Documentation and team-state paths select nothing. That list, and the glob
  matcher, are read from `scripts/ci/affected.mjs` and
  `scripts/ci/full-run-triggers.json` (the CI scope classifier); routing keeps
  no copy of either. The classifier's other lists answer a different question
  (which CI packages to test) and are not used.
- Anything routing cannot judge (an unresolvable commit, a git error, a shallow
  clone, an unreadable ledger or classifier) selects every pack at or below
  `standard` and says why in `routing_fallback`.
- Both refs are validated (a hex commit id or a plain ref name) before git is
  run, and git is run with an argument list, never a shell. A malformed range is
  a usage error (exit 2).

## Sessions

Signed-in packs use stored sessions, not a password flow. `live-e2e capture-session --target <name> --role <role>` opens a headed browser on the owner's machine, the owner signs in by hand, and only the `__Host-fx_session` cookie is kept. The store is one AES-256-GCM file per target under `$HOME/.local/state/live-e2e/`, keyed by `LIVE_E2E_SESSION_KEY`, and the roles are `owner`, `member`, `outsider`, `revoke` and `canary` (`apps/live-e2e/src/store.ts`). `sessions keep-alive` makes one request per stored role and writes the refreshed cookie back, warns three days ahead of a lapse and files one issue per lapsed role. The commands are in `apps/live-e2e/src/sessions-cli.ts`.

## Janitors

`live-e2e janitor account --target staging [--apply]` puts the staging owner account back to a fixed spend baseline through the product's own API: it only lowers limits (per-run dollars, model calls, run minutes), the monthly model budget and each role's model, and refuses to write anything if the account has a repository outside the test org. `janitor repo` resets the fixture repository to its `e2e-baseline` tag. Both run automatically before a destructive pack and are dry-run by default for the commands (`apps/live-e2e/src/janitor/account.ts`, `apps/live-e2e/src/janitor/repo.ts`). `janitor repos --org <name> [--apply]` deletes `e2e-tmp-*` repositories more than a day old in the test org; it runs only on a person's machine with their own `gh` login and asks them to type the org name before deleting (`apps/live-e2e/src/janitor/repos.ts`).

## Report and scrub

- `report.ts` builds `results.json` and the job-summary table (outcome,
  duration, devices, measured cost per pack) and fixes the issue title
  format, `live-e2e: <pack> on <target>`. Writers redact first, re-check the
  text, and write nothing if a secret survives.
- `mask.ts` is the registry of values that only exist during a run (session
  JWTs, the bypass cookie, minted tokens). Registering one prints the
  GitHub `::add-mask::` command and tracks it for the scrub. It can be backed
  by a file named in `LIVE_E2E_MASK_FILE`: one owner creates it (`create: true`,
  exclusive, no symlinks, mode 0600), every other opener must find a regular
  file of its own user with no group or other access, and the scrub refuses to
  run when the file sits inside the folder it scans. (T1b: print the mask
  commands from the main process, not from Playwright workers.)
- `scrub.ts` knows the secret shapes (bypass secret, cookies, Authorization
  and Bearer, Stripe, Anthropic, OpenAI, GitHub, Vercel, Slack, AWS, Google,
  GitLab, npm, JWT, credentials in a URL of any scheme, private keys), the
  registered runtime values and the secret-looking values of the run's own
  environment.

### What is uploaded, and what is not

The threat is an accidental leak from our own test code or Playwright: a token
in a log, a key in a URL, a cookie in a network log. So the upload step is an
allowlist, not a scanner for every format.

`live-e2e scrub --dir <folder> --manifest <file>` decides, file by file:

- **Uploaded after a check:**
  - text files (`.log .txt .md .json .jsonl .html`). They must be strict UTF-8
    with no NUL bytes, and are checked in plain text and through URL encoding,
    base64/base64url, hex, JSON escapes (also doubly escaped) and HTML
    entities;
  - PNG screenshots. Their text chunks (`tEXt`, `iTXt`, `zTXt`, decompressed)
    are checked, and anything after `IEND` is refused.
  - Playwright's HTML report (`playwright-report/index.html`) is the one archive
    that is read. It keeps stdout, errors and attachments in a deflate zip,
    base64-encoded in `<template id="playwrightReportBase64">`; the zip is read
    with hard bounds (5000 entries, 256 MiB inflated in total, 64 MiB per entry,
    compression ratio 1000) and every entry is checked like an uploaded file
    (text as text, a PNG attachment by its text chunks). A binary attachment of
    any other kind keeps the whole report out (`not-uploaded:report-binary-attachment`);
    a damaged or unfamiliar report is a finding.
- **Not uploaded:** everything else, including zip, tar, traces, video, HAR and
  unknown binaries. Each is printed as `not-uploaded:<type> <path>`, listed in
  the manifest and left out of the upload set. That is not an error. Symlinks
  and special files are never followed or uploaded.
- **Embedded archives.** Any other base64 run in a text file that decodes to a zip
  or gzip header makes that file `not-uploaded:embedded-archive`. It is not parsed.
- **Findings** (exit 1, the file is left out too): a secret, an allowed file that
  is not UTF-8 or contains NUL bytes, a damaged PNG, or data after `IEND`.
  Nothing printed ever contains a secret or a file name that holds one.
- The manifest is the upload set: `upload`, `not_uploaded` and
  `included_unscanned`.

**Debugging opt-in.** `--target <name> --include-unscanned <glob>` (repeatable)
puts matching non-allowlisted files in the upload set WITHOUT looking inside
them (only their raw bytes get the plain check). It is off by default, needs
`--target`, is refused on the production target (exit 2) and is listed in the
manifest, in `results.json` (`included_unscanned`) and in the summary.

The run's own environment counts as secret, except values that are only an
absolute path under a well-known root (`/home`, `/tmp`, `/nix`, `/usr`, ...; a
`:`-separated list of them too), because Playwright prints `rootDir`,
`outputDir` and `configFile` and a secret does not look like that. A secret that
merely starts with a slash is still secret.

Not covered: text drawn inside screenshot pixels (that is what
`data-secret-node` masking is for), a value split across lines,
quoted-printable, base32, a bearer value shorter than 16 characters with no
digit and no known token prefix, and the inside of any file that was opted in.

Redaction before writing (`writeReport`, `writeScrubbed`) is separate: the
report and any log the runner writes are redacted first and refused if a
secret survives.
