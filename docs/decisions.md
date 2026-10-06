# Decisions

A log of specific technical decisions made while building this repo's
product code, one entry per decision: what was decided, why, which PR made
it, and a citation showing it's still true at HEAD. Entries come only from
PRs that touched `apps/`, `packages/`, `sites/`, `flake.nix` or `.github/`.

Sources:
- `packages/db/migrations/0001_core.sql`
- `packages/db/migrations/0005_account_members_role_gate.sql`
- `packages/db/migrations/0008_audit_log_append_only.sql`
- `packages/db/migrations/0200_partners.sql`
- `packages/db/migrations/0400_decisions.sql`
- `packages/db/migrations/0600_api_core.sql`
- `packages/db/migrations/0604_session_epoch.sql`
- `packages/db/migrations/0605_execution_mode.sql`
- `packages/db/scripts/test-neon-shape.sh`
- `packages/spend/src/pricing.ts`
- `packages/design/src/`
- `apps/workspace/import/allowlist.txt`
- `apps/workspace/import/import.mjs`
- `packages/runner/src/networkPolicy.ts`
- `packages/billing/src/accountLifecycle.ts`
- `packages/db/migrations/0400_decisions.sql`
- `packages/model-connection/src/crypto.ts`
- `packages/decisions/src/decide.ts`
- `apps/web/lib/shell/csrf.ts`
- `packages/runner/src/executionTarget.ts`
- `packages/model-router/src/route.ts`
- `packages/core/src/role-settings/setMode.ts`
- `.github/workflows/ci.yml`
- `apps/workspace/import/checks.mjs`
- `packages/core/src/auth/session.ts`
- `apps/workspace/build/profile.mjs`
- `apps/web/app/(team)/runs/_components/ModelBadge.tsx`
- `apps/web/package.json`
- `packages/runner/src/githubForwardConfig.ts`
- `packages/net-guard/src/`
- `packages/db/migrations/0606_derived_account_status.sql`
- `packages/db/scripts/check-migration-order.sh`

## Entries

1. **Row-level security is `FORCE`d on every tenant table, not just enabled.** Without `FORCE`, the table owner (the role migrations run as) bypasses the policies. — `#12` — still true: `packages/db/migrations/0001_core.sql` has a `FORCE ROW LEVEL SECURITY` statement for every tenant table.
2. **Money columns are `numeric`, never a float.** Floating-point rounding error is unacceptable for anything that ends up on a bill. — `#11` — still true: `packages/db/migrations/0001_core.sql`'s spend columns are `numeric(10, 2)`/`numeric(10, 4)`.
3. **Partner isolation is three levels (partner / account / user), not two.** A partner's own staff, the accounts it resells to, and end users each need a distinct trust boundary. — `#13` — still true: `packages/db/migrations/0200_partners.sql` defines the `partner_user` role and partner-scoped tables.
4. **CI runs on a self-hosted runner, not a GitHub-hosted image.** Private-repo Actions minutes are capped, and the job needs Nix, Postgres and Playwright browsers exactly as a developer's local `nix develop` provides them. — `#14` — still true: `.github/workflows/ci.yml`'s `check` job has `runs-on: self-hosted` and a single `nix develop --command bash scripts/check.sh` step.
5. **Design tokens are the one source of visual values; no hardcoded colours or lengths outside the token files.** Keeps `apps/web` and site-kit visually consistent and swappable for a white-label palette. — `#39` — still true: `packages/design/src/` holds the token and stylesheet-builder modules the other two consume.
6. **The workspace importer accepts only a source-control archive tar, never the raw working tree.** A tar built by reading the object store structurally cannot contain untracked `.env` files, regardless of which user runs the importer. — `#49` — still true: `apps/workspace/import/import.mjs` takes a `--tar` argument and verifies its recorded commit id, with no working-tree-path mode.
7. **The importer's allowlist is exact per-file, not a blanket glob.** A blanket `core/**`-style glob would also select `.js.map` siblings that the secret/dotfile scanner flags unconditionally, refusing the whole import. — `#95` — still true: `apps/workspace/import/allowlist.txt` lists `core/*.js`, `sdk/**`, `runtime/**` and `apps/themes/**` per-extension rather than as directory globs.
8. **`core/automerge-bootstrap.js` is excluded from the workspace import, even though it's a real upstream file.** The importer's own unconditional rule refuses any path containing "automerge"; the file was left out rather than weakening that rule. — `#95` — still true: `apps/workspace/import/checks.mjs` has the unconditional "automerge" substring rule, and `apps/workspace/import/allowlist.txt` doesn't list the file.
9. **The runner's outbound network policy is deny-by-default and never returns a wildcard host.** A per-role, per-phase allowlist of exact hostnames is safer for a sandbox running arbitrary agent code than a broad egress rule. — `#50` — still true: `packages/runner/src/networkPolicy.ts` builds an exact-host allowlist and documents that it never returns a wildcard rule.
10. **Billing writes to `accounts` go exclusively through `platform_ops`; `app_user` has no INSERT/UPDATE on that table at all.** A tenant session should never be able to change its own plan or status directly. — `#53` — still true: `packages/billing/src/accountLifecycle.ts`'s functions run through the platform-privileged connection.
11. **Decision-policy dial history is append-only — every change is a new versioned row, never an edit.** Makes "what was the setting at time T" answerable and keeps an audit trail that can't be silently rewritten. — `#54` — still true: `packages/db/migrations/0400_decisions.sql` keys `decision_settings` on `(account_id, repo_id, decision_type, version)` with no UPDATE/DELETE grant to `app_user`.
12. **Customer model keys are envelope-encrypted: a random per-row data key, wrapped by a versioned platform KEK, both carrying AEAD additional data.** Limits the blast radius of a single compromised KEK version and binds ciphertext to the row it belongs to. — `#55` — still true: `packages/model-connection/src/crypto.ts` implements `seal`/`open` on this shape.
13. **The decision resolver `decide()` is pure and never reads `customerProximity`/`dataSensitivity`.** Those fields exist for humans reading the catalogue, not for the resolver's own logic, to keep the resolver's behavior fully determined by class and preset. — `#60` — still true: `packages/decisions/src/decide.ts` has no reference to either field name.
14. **`account_members` and `invitations` gained role-derived, per-command RLS policies instead of an `account_id`-only check.** Any session inside an account could otherwise re-role or delete any row, including the owner's. — `#75` — still true: `packages/db/migrations/0005_account_members_role_gate.sql` defines `current_member_role()` and the owner/admin/member-scoped policies.
15. **CSRF is decided once, in middleware, by which credentials are present on the request — before any route handler runs.** Centralizes the check instead of re-implementing it per route. — `#82` — still true: `apps/web/lib/shell/csrf.ts`'s `csrfStep` is the first step registered in `apps/web/middleware.ts`.
16. **`audit_log` writes go through a `SECURITY DEFINER` function (`audit_write`) that stamps actor/account/timestamp itself; `app_user` lost its INSERT grant entirely.** The RLS-only policy let any session forge `actor`, `action` or `created_at`, which had already been exploited twice. — `#91` — still true: `packages/db/migrations/0008_audit_log_append_only.sql` revokes INSERT from `app_user` and defines `audit_write`.
17. **Agent runs are dispatched through an `ExecutionTarget` seam, resolved from a database column, never from an environment variable.** Keeps the run backend swappable and prevents an environment difference from silently picking a different execution target. — `#85` — still true: `packages/runner/src/executionTarget.ts`'s resolver reads `repos.execution_mode` and fails closed on an unregistered mode.
18. **Model routing is a Postgres-backed table (role, size) → model, not a hardcoded map.** Lets a routing change ship as a data update (with a proposal/promotion workflow) instead of a code deploy. — `#88` — still true: `packages/db/migrations/0010_model_routing.sql` defines `routing_tables`/`routing_rows`, and `packages/model-router/src/route.ts` reads them.
19. **`ModelBadge` was built and tested standalone, not wired into a run page.** The run-listing page it was meant to register into doesn't exist yet in this repo. — `#88` — still true: `apps/web/app/(team)/runs/_components/ModelBadge.tsx` exists, and `apps/web/package.json` does not depend on `@fx/model-router`.
20. **Role-scheduling settings are a plain service module with no page or API route of its own.** The UI is a separate, later task; this keeps the read/write contract independently testable first. — `#89` — still true: `packages/core/src/role-settings/setMode.ts` and its siblings have no corresponding `apps/web` route.
21. **Migrations run under a Neon-shaped, non-superuser owner role, proven by a dedicated CI check rather than assumed.** Hosted Postgres never grants the migration role superuser, and the chain previously aborted on `ALTER ROLE ... NOSUPERUSER`, which itself needs superuser to run. — `#92` — still true: `packages/db/scripts/test-neon-shape.sh` is wired into `scripts/check.sh`.
22. **A signed-in user gets a fresh session id on every sign-in, and a stored `session_epoch` lets "sign out everywhere" invalidate every other still-valid session.** A cryptographically valid, unexpired cookie shouldn't remain usable after the user explicitly signs out of all sessions. — `#96` — still true: `packages/core/src/auth/session.ts` mints a new `sid` per sign-in, and `packages/db/migrations/0604_session_epoch.sql` adds the `users.session_epoch` column it checks against.
23. **`idempotency_keys` is numbered `0600`, not the next sequential slot, to avoid colliding with an already-reserved migration number elsewhere.** — `#82` — still true: `packages/db/migrations/0600_api_core.sql`'s header records this numbering choice.
24. **Every factual sentence on a site-kit site is a gated `Claim`, not typed HTML — the build refuses to write output if any claim is unverified.** Keeps a public, unreviewed-by-a-human page from ever shipping an unverified product claim. — `#98` — still true: `packages/sitekit-claims` holds the `gateSite` gate. The one-off marketing site that first used it was archived on 2026-10-05 and is no longer built.
25. **The cloud workspace build profile strips Automerge/CRDT and other non-cloud features by filtering the shell's static import graph, rather than shipping the full desktop bundle.** Removing dead code paths this way also lets the idle-network test prove zero background activity for the features that were dropped. — `#100` — still true: `apps/workspace/build/profile.mjs` walks `apps/workspace/profiles/cloud.json`'s `drop_core` list against the shell's import graph.
26. **The GitHub-proxy forward host is an operator-configured allowlist (a fixed suffix), not any syntactically-valid hostname, and its resolved address is checked on every call rather than accepted on hostname shape alone.** A syntax-only check accepts a hostname the operator never configured, and doesn't catch one that resolves to an internal address. — `#113` — still true: `packages/runner/src/githubForwardConfig.ts`'s `loadGithubForwardConfig` requires a configured suffix, and `packages/runner/src/firewallPolicy.ts`'s `buildFirewallPolicy` resolves the host through `packages/net-guard/src`'s `resolveChecked` before building a policy.
27. **`accounts.status` is a column the database derives from independent per-holder marker timestamps, not a value application code writes directly.** Three separate parties (owner, partner, platform) can each want to stop an account, and a single `status` column can only ever record one of them at a time. — `#93` — still true: `packages/db/migrations/0606_derived_account_status.sql` adds the `accounts_derive_status` trigger and rejects a direct `status` write that disagrees with the derived value.
28. **A new migration file must sort strictly after every migration already on its PR's base, checked by a dedicated CI script rather than left to reviewer attention.** Filename order is what `migrate.ts` actually applies; a file numbered out of merge order can apply in an order nobody reviewed. — `#118` — still true: `packages/db/scripts/check-migration-order.sh` is wired into `scripts/check.sh` right after `test-neon-shape.sh`, and fails closed (exit 2) if it can't resolve the base ref.
29. **A subscription's activation unlocks the workspace; there is no separate licence-activation flow in cloud.** The fulcrumaxe-os licence-activation module doesn't fit a hosted subscription product, and the gate it replaces is cosmetic only — the server already denies runs for a non-active account regardless of what the client renders. — `#162` (D#37 WS-L1 owner ruling) — still true: `apps/workspace/profiles/cloud.json`'s `app_modules` no longer lists `activation`, and `apps/web/lib/shell/session-routes.ts`'s `meResponse` derives `workspace_access` from the account's billing status.
30. **The GitHub proxy gates every git smart-HTTP request by its literal URL endpoint, not by which service the request's target maps to.** Gating on `service` alone let any method (including PUT/PATCH/DELETE) reach `git-upload-pack` once the target parsed as that service, so a non-GET/POST request could reach GitHub with a minted credential. — `#160` — still true: `packages/gh-policy/src/decide.ts` denies `info/refs` to anything but GET/HEAD and `git-upload-pack`/`git-receive-pack` to anything but POST, keyed on `pathTarget.ts`'s `endpoint` field.
