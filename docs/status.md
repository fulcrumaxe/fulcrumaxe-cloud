# Status

What's implemented and tested, what's implemented but not (yet) exercised by
a test, and what's scaffold-only, for every workspace project at HEAD. For
the roadmap this work is planned against, see
Discussion D#101
(D#101) — this page classifies only what the repo can show today; it does
not repeat that Discussion's dates or milestones.

Sources:
- `apps/web/`
- `apps/workspace/`
- `packages/billing/`
- `packages/core/`
- `packages/db/`
- `packages/decisions/`
- `packages/design/`
- `packages/gh-policy/`
- `packages/model-connection/`
- `packages/model-router/`
- `packages/partners/`
- `packages/roles/`
- `packages/runner/`
- `packages/runtime/`
- `packages/sitekit-checks/`
- `packages/sitekit-claims/`
- `packages/sitekit-template/`
- `packages/spend/`
- `packages/test-guard/`
- `packages/trust/`
- `packages/runner/package.json`
- `apps/web/app/(team)/runs/_components/ModelBadge.tsx`

## Apps

| Project | Status | Evidence |
|---|---|---|
| `apps/web` | implemented-and-tested | 22 `*.test.ts` files under `apps/web/`, covering middleware, the CSRF/session/shell routes, the Stripe webhook handler, the GitHub proxy route/handler (OIDC verification, installation tokens), and the API-sweep cron route. |
| `apps/workspace` | implemented-and-tested | 5 vitest files (`apps/workspace/test/{checks,features-fail-closed,profile,tar,import}.test.mjs`) plus a Playwright e2e spec (`apps/workspace/e2e/idle-network.spec.ts`) that drives a fixture server through boot and an idle period. The vendored frontend under `apps/workspace/shell/` is checked mechanically by `checks.mjs` rather than unit-tested line by line — it's imported bytes, not code authored in this repo. |

## Packages

| Project | Status | Evidence |
|---|---|---|
| `packages/billing` | implemented-and-tested | 7 test files, including `test/webhook.test.ts` (Stripe webhook) and `test/accountLifecycle.test.ts`. |
| `packages/core` | implemented-and-tested | 21 test files across `src/auth/`, `src/role-settings/`, `src/tokens/` (API tokens), `src/stats/`, `src/runs/`, and `src/work-items/` (the public API's read routes). |
| `packages/db` | implemented-and-tested | 50 test files — the largest suite in the workspace, including the RLS/view/matview grant inventory, `packages/db/scripts/test-neon-shape.sh`'s non-superuser migration check, `packages/db/scripts/check-migration-order.sh`'s merge-monotonic numbering check, `test/migrate-0606-upgrade.test.ts`'s derived-status backfill check, and the hardened migration runner's lock/timeout/checksum coverage (`test/migrate-integrity.test.ts`). |
| `packages/decisions` | implemented-and-tested | 7 test files: `test/catalogue.test.ts`, `test/decide.test.ts`, `test/declared.test.ts`, `test/presets.test.ts`, `test/noNeverDialledFlag.test.ts`, a second workspace-wide sibling of that same check, and `test/importScan.test.ts`. |
| `packages/design` | implemented-and-tested | 5 test files, including a markup-parity check between the string (`src/html`) and React (`src/react`) renderers. |
| `packages/gh-policy` | implemented-and-tested | 10 test files for the pure `decide()` engine. |
| `packages/model-connection` | implemented-and-tested | 8 test files, including `crypto.test.ts` (envelope encryption round-trip/tamper cases) and `toctou.test.ts` (a real-Postgres row-lock race). |
| `packages/model-router` | implemented-and-tested | 8 test files covering `route()`, `escalate()`, and the promotion-guard in `proposal.ts`. `ModelBadge` (`apps/web/app/(team)/runs/_components/ModelBadge.tsx`) is built and tested standalone — `apps/web`'s `package.json` does not depend on `@fx/model-router`, and no run page imports the badge yet. |
| `packages/partners` | scaffold | `packages/partners/src/` has only `index.ts`, which exports nothing (`export {}`) and exists solely so `tsc --noEmit` has an input file. No test directory. The partner-tenancy *schema* (`packages/db/migrations/0200_partners.sql`) is implemented and tested inside `packages/db`; this package's own feature code is not built yet. |
| `packages/roles` | implemented-and-tested | 6 test files pinning the role manifest at exactly 26 entries, plus `test/declared-classes.test.ts`'s scan of `tools.ts`/`cards/*.md` for the (currently unused) decision-type declaration convention. |
| `packages/runner` | implemented-and-tested | 31 test files covering `startAgentRun`, `cancelRun`, `networkPolicy`, `firewallPolicy`, `sandboxEnv`, `sandboxNaming`, `githubForwardConfig` (the operator forward-host allowlist, plus a dedicated `githubForwardSource.test.ts` proving it's called only from that file's own definition and the gh-proxy route/handler), mid-run metering and key-failure handling (`keyFailureAndSpendKill.pg.test.ts`), `resume` (`resumeAgentRun.pg.test.ts`), the run-funding seam (`funding.test.ts`, `funding.pg.test.ts`, `fundingSourceCheck.test.ts`), and the real-Workflow-SDK watchdog (`workflows/agentRun.pg.test.ts`) — all tested. Scope note: `packages/runner/package.json`'s own description states a real `@vercel/sandbox` port and the run-start composition root (H14) are the one remaining not-yet-built slice. |
| `packages/runtime` | implemented-and-tested | 11 test files across the local/production/fake runner adapters, including `test/local-setting-sources.test.ts`'s hostile-working-tree fixture proving the local runner's pinned `settingSources`/`mcpServers`/`strictMcpConfig` options hold. |
| `packages/sitekit-checks` | implemented-and-tested | 7 test files for the mechanical output checks (`check-nojs`, `check-weight`, etc.). |
| `packages/sitekit-claims` | implemented-and-tested | 3 test files for the claim schema and the render-refusal gate. |
| `packages/sitekit-template` | implemented-and-tested | 4 test files rendering `SiteContent` to static HTML. |
| `packages/spend` | implemented-and-tested | 16 test files, including concurrency and property-based settlement tests. |
| `packages/test-guard` | implemented-and-tested | 2 test files; `pnpm test:guard` runs a fixture that deliberately violates the guard and asserts the violation throws, so the guard itself can't silently stop working. |
| `packages/trust` | implemented-and-tested | 5 test files for author-trust classification, control-token sanitization, and (`test/provenance.test.ts`) the `internal`/`external` DB-boundary vocabulary `parseProvenance` enforces. |

## Sites

| Project | Status | Evidence |
|---|---|---|

