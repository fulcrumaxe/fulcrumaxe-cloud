# gh-policy

`@fx/gh-policy` is the pure decision engine behind the platform's GitHub proxy: given one normalized, already-parsed request, it decides whether a role may make that exact call against the installation's single repo, and if so what token scope backs it. It touches no network and no filesystem itself — the proxy that actually talks to GitHub, `apps/web/app/api/gh-proxy/[...path]/handler.ts`, is a separate component (`#140`) that verifies the caller's OIDC identity and mints a GitHub App installation token (`packages/github/src/oidcVerify.ts`, `packages/github/src/installationToken.ts`) before calling this package and forwarding the request byte-identical to what was approved. `apps/gh-proxy` is a proxy-only deployable that puts a host, path and method gate in front of it (`apps/gh-proxy/gate.ts`).

There are three rule sets, one per kind of caller. `decide()` judges a role's sandbox. `decideRunner()` judges a customer-side runner. `decidePlanePublish()` judges the run that copies a private change to the paired public repository. Each has an entry in `packages/github/src/` that calls it (`proxyDecision.ts`, `runnerProxyDecision.ts`, `planePublishProxy.ts`).

Sources:
- `packages/gh-policy/src/`
- `packages/gh-policy/test/`
- `packages/gh-policy/package.json`
- `apps/web/app/api/gh-proxy/[...path]/handler.ts`
- `packages/github/src/oidcVerify.ts`
- `packages/github/src/installationToken.ts`
- `packages/github/src/installationHttp.ts`
- `packages/runner-cloud/src/setupFinish.ts`
- `packages/gh-policy/src/runnerPolicy.ts`
- `packages/gh-policy/src/planePublish.ts`
- `packages/gh-policy/src/parseUploadPack.ts`
- `packages/gh-policy/vitest.config.ts`
- `apps/gh-proxy/gate.ts`
- `packages/github/src/runnerProxyDecision.ts`
- `packages/github/src/planePublishProxy.ts`
- `packages/github/src/proxyDecision.ts`

## What it does

`decide(req: ProxyRequest): Decision` (`packages/gh-policy/src/decide.ts`) is the single entry point. It runs a fixed sequence of checks — method allowlist, host allowlist with a Host/SNI domain-fronting check, path canonicalization, target parsing, host/target-kind match, repo scoping, a per-endpoint git method gate (GET/HEAD only on `info/refs`, POST only on the literal `git-upload-pack`/`git-receive-pack` endpoints, keyed to the URL endpoint rather than the logical service — `#160`), a universal merge/protection denial, a universal labels-collection replace/clear denial, a universal REST-contents-write denial — then branches on product (`sitekit` is read-only end to end) and, for `team`, on git push/pull vs. REST API traffic, ending in role-and-resource-specific checks for PATCH fields, reviewer verdict labels, the pull-request review family, and a table of enumerated generic write routes. Anything not explicitly matched falls through to a default deny (`unknown_resource`).

## Public surface

Everything `packages/gh-policy/src/index.ts` re-exports: `decide` (`decide.ts`); `isCanonicalPath` (`canonicalPath.ts`); `isMergeOrProtectionPath` (`mergeProtection.ts`); `parseTarget` (`pathTarget.ts`); `parseReceivePackRefUpdates` (`parseReceivePack.ts`); `parseUploadPackRequest` and `isFullCloneRequest` (`parseUploadPack.ts`); `decideRunner`, `RUNNER_PUSHING_ROLES` and `RUNNER_TICKET_REF_RE` (`runnerPolicy.ts`); `decidePlanePublish`, `PLANE_PUBLISH_BASE`, `PLANE_PUBLISH_DENY_REASONS` and `PLANE_PUBLISH_ROLE` (`planePublish.ts`); `isValidRefName` (`refName.ts`); `ALLOWED_METHODS` (`decide.ts`); `ALLOWLISTED_VERDICT_LABELS`, `lookupReviewerVerdictLabels`, `lookupRolePermissions`, `REVIEWER_ROLES`, `ROLE_PERMISSIONS`, `ROLE_PUSH_PREFIX`, `SITEKIT_PERMISSIONS` (`rolePermissions.ts`); and the types `Decision`, `InstallationTarget`, `ParsedRefUpdates`, `ParsedUploadPackRequest`, `RunnerRequest`, `PlanePublishDecision`, `PlanePublishDenyReason`, `PlanePublishRequest`, `PermissionLevel`, `PermissionName`, `Product`, `ProxyRequest`, `RefUpdate`, `TokenScope` (`types.ts`).

## How it works

**Path canonicalization** (`packages/gh-policy/src/canonicalPath.ts`) rejects a path before it is ever parsed or judged, rather than normalizing and re-judging it: it uses an allowlist of literal segment characters, an allowlist of bytes a `%XX` escape may decode to (excluding control/non-ASCII bytes, a second `%`, encoded separators, and the encoded forms of `#`/`?`), and rejects `.`/`..`/empty segments and a trailing slash. `parseTarget` (`pathTarget.ts`) then classifies an already-canonical path as either a REST API target (`/repos/{owner}/{repo}/...`) or a git smart-HTTP target (`upload-pack` or `receive-pack`), returning `null` for anything else — including an `info/refs` request with no `service` query parameter to disambiguate it.

**Per-role permission ceiling.** `ROLE_PERMISSIONS` (`packages/gh-policy/src/rolePermissions.ts`) is the minimum GitHub App permission table minted into a role's installation token for a whole run; `decide()` enforces the actual per-request restrictions independently, so this table is a ceiling, not the mechanism. Four roles carry `contents: "write"` — `executor`, `docs-writer`, `release-manager`, `runbook-writer` — each confined by `ROLE_PUSH_PREFIX` to its own `refs/heads/fx/<name>/*` sub-prefix except `executor`, which may push anywhere under `refs/heads/fx/*` except those three roles' reserved sub-prefixes. `lookupRolePermissions`/the role lookups in `decide.ts` use `Object.hasOwn` rather than bracket access, so a role name like `"toString"` or `"__proto__"` cannot resolve through the prototype chain into a false permission grant.

**Three tokens minted outside the proxy for a project setup.** `packages/github/src/installationToken.ts` mints a `setup_push` token (`contents: write` and `metadata: read`) for the runner's push of the install commit, a `setup_labels` token (`issues: write` and `metadata: read`) for making the engine's labels, and a `setup_finish` token (`issues: write`, `discussions: write` and `metadata: read`) for the step that, once the install pull request has merged, makes the plan's first Discussions and the team-log issue (`packages/runner-cloud/src/setupFinish.ts`). Each covers exactly one repository, is minted fresh and never cached, and the mint is refused (`token_scope_mismatch`, and the token revoked) if GitHub's answer names any other repository or permission. None carries `workflows` or `pull_requests`; the push token goes to the runner, never to a sandbox, and the finish token is held by the cloud's own reconcile step, whose client (`kind` `setup_finish` in `packages/github/src/installationHttp.ts`) may list and create the repository's issues and send `POST /graphql`, and nothing else (the GraphQL documents it sends are fixed in `packages/runner-cloud/src/localOnlyGithub.ts`) (#1228, #1234, #1258).

**Runner policy.** A customer-side runner reaches GitHub only through smart-HTTP and only for the one branch its signed ticket names, so `decideRunner()` (`packages/gh-policy/src/runnerPolicy.ts`) is narrower than `decide()` and does not call it; it reuses the same path, target and ref-name helpers. Only `executor` and `docs-writer` runs may push (`RUNNER_PUSHING_ROLES`), the ticket's ref must be a run branch or the item's own pull-request branch (`RUNNER_TICKET_REF_RE`), and the token scope is `contents` read or write plus `metadata` read.

**Plane publish policy.** The run that publishes a private change to the paired public repository owns two repositories, which `decide()` does not allow, so `decidePlanePublish()` (`packages/gh-policy/src/planePublish.ts`) replaces it for that role. It allows reads of the private repository, and on the public one the calls that create or replace the one recorded branch plus a pull request from that branch onto `main`; repositories are compared exactly, and every denial is one of the fixed `PLANE_PUBLISH_DENY_REASONS`.

**Upload-pack bodies.** `parseUploadPackRequest` (`packages/gh-policy/src/parseUploadPack.ts`) reads a `git-upload-pack` body far enough to tell the command and whether it is a full clone. A body it cannot fully read comes back `complete: false` and the caller refuses it.

**Reviewer verdict labels.** `REVIEWER_ROLES` (`code-reviewer`, `security-reviewer`, `acceptance-tester`, `debater`, `accessibility-reviewer`) may read, comment, and — for the three roles with an entry in `lookupReviewerVerdictLabels` — add or remove their own pass/needs-fix label pair (e.g. `code-review-passed`/`code-review-needs-fix`). Each reviewer's label pair is distinct from every other reviewer's, so removing one role's label can never clear another role's verdict.

## Concrete examples (from the tests)

- **Deny — merge attempt disguised by a non-canonical path.** `PUT /repos/acme/widgets/pulls/../pulls/1/merge` is denied at the path-canonicalization step before it can even reach the merge-protection check; the exact-canonical form of the same request, `PUT /repos/acme/widgets/pulls/1/merge`, is separately denied with reason `merge_or_protection_denied`. `packages/gh-policy/test/decide.security.test.ts`, describe block "item 1: non-canonical path / method bypasses of the merge block".
- **Allow — a push-capable role's own branch prefix.** `docs-writer` pushing a ref update targeting `refs/heads/fx/docs/my-change` (or the bare root `refs/heads/fx/docs`) is allowed; the same role targeting `refs/heads/fx/release/x` (another push-capable role's reserved prefix) is denied. `packages/gh-policy/test/decide.test.ts` and `packages/gh-policy/src/decide.ts`'s `canRolePush`.
- **Deny — labels-collection replace/clear, for every role.** A `PUT` or `DELETE` on `/issues/{n}/labels` (replacing or clearing every label on the issue, not just the caller's own) is denied for any role, reviewer or not, with reason `labels_collection_replace_or_clear_denied`; only `POST` (add) and a single-label `DELETE` are ever approved. `packages/gh-policy/test/decide.security.test.ts`.
- **Allow/deny — reviewer label ownership.** `security-reviewer` adding its own `security-needs-fix` label is allowed; `security-reviewer` attempting to remove `code-reviewer`'s `code-review-passed` label is denied with reason `label_not_allowlisted`, since `lookupReviewerVerdictLabels` scopes each reviewer to only its own pair. `packages/gh-policy/test/rolePermissions.test.ts` and `packages/gh-policy/test/decide.test.ts`.

## Data it touches

No database access — this package only makes decisions from the `ProxyRequest` it is handed. See `../security.md` for how its output (a `Decision`/`TokenScope`) is used by `apps/web/app/api/gh-proxy/[...path]/handler.ts`, the built proxy route.

## Security notes

See `../security.md`. `types.ts`'s own header documents the package's trust boundary explicitly: `gitRefUpdates`, `labelNames`, and `patchFields` are the only windows this pure module has into a request body it never parses itself, so every property this package proves is only as sound as the caller's guarantee that those three fields are an honest, complete account of the exact same request body that gets forwarded to GitHub. No code in this package enforces that guarantee — it is a documented obligation on the proxy that calls `decide()`. `decide.ts` denies a PATCH on an issue/PR whose `patchFields` is missing or empty outright, rather than treating "no visibility into what changed" as "so it must be safe."

## Tests

Run with `pnpm --filter @fx/gh-policy test` (`vitest run`) or `test:coverage` (line-coverage threshold 95%, `vitest.config.ts`). `test/decide.test.ts` and `test/decide.security.test.ts` are the two main suites over `decide()`, the latter organized as one describe block per named finding from a past security review, each asserting the fixed decision that review requires. `test/canonicalPath.test.ts`, `test/pathTarget.test.ts`, `test/refName.test.ts`, `test/mergeProtection.test.ts`, `test/parseReceivePack.test.ts`, `test/parseUploadPack.test.ts`, `test/runnerPolicy.test.ts`, `test/planePublish.test.ts`, `test/rolePermissions.test.ts`, and `test/index.test.ts` cover the individual modules. `test/importScan.test.ts` enforces this package's own pure-module boundary (no network/filesystem/process import anywhere in `src/`).
